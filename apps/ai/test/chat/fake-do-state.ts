/**
 * A `DurableObjectState` backed by a real in-memory SQLite database.
 *
 * `ChatSession` is mostly SQL: the event log, the transcript fold, and the turn mutex are all
 * statements against `ctx.storage.sql`. Mocking that away would test a paraphrase of the class
 * rather than the class, and the fold bug this harness exists to pin (an `indexOf` on an object
 * that had just been replaced) lived entirely in the code a mock would have skipped.
 *
 * `node:sqlite` is the same engine Durable Object storage exposes, and the `SqlStorage` surface the
 * class touches is small: `exec(sql, ...bindings)` returning a cursor with `one()` and `toArray()`.
 */
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite"
import { CHAT_SESSION_MIGRATIONS } from "../../src/chat/ChatSession"

const migrationsDir = path.resolve(import.meta.dirname, "../../../..", CHAT_SESSION_MIGRATIONS)

/** Every migration file, in order, as alchemy's `apply` runs them (minus its history table). */
export const applyChatSessionMigrations = (sql: SqlStorage): void => {
	for (const file of readdirSync(migrationsDir)
		.filter((name) => name.endsWith(".sql"))
		.toSorted()) {
		sql.exec(readFileSync(path.join(migrationsDir, file), "utf8"))
	}
}

/** Everything the DO under test reads off its state, and nothing more. */
export interface FakeDurableObjectState {
	readonly storage: {
		readonly sql: SqlStorage
		readonly setAlarm: (scheduledTime: number) => Promise<void>
	}
	/** Every alarm time the object asked for, in order. */
	readonly alarms: Array<number>
	/** Collected rather than awaited, so a test can drive the turn itself. */
	readonly waitUntil: (promise: Promise<unknown>) => void
	readonly pending: Array<Promise<unknown>>
}

type Row = Record<string, SqlStorageValue>

/** `node:sqlite` hands back bigints and byte arrays; DO storage hands back numbers and buffers. */
const toStorageRow = (row: Record<string, SQLOutputValue>): Row =>
	Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key,
			typeof value === "bigint"
				? Number(value)
				: value instanceof Uint8Array
					? value.slice().buffer
					: value,
		]),
	)

/** The cursor surface of `SqlStorageCursor`, over rows already read. */
class FakeCursor<T extends Row> implements SqlStorageCursor<T> {
	columnNames: string[]
	private index = 0
	constructor(private readonly rows: Array<T> = []) {
		this.columnNames = rows[0] === undefined ? [] : Object.keys(rows[0])
	}
	get rowsRead(): number {
		return this.rows.length
	}
	get rowsWritten(): number {
		return 0
	}
	next(): { done?: false; value: T } | { done: true; value?: never } {
		const value = this.rows[this.index++]
		return value === undefined ? { done: true } : { value }
	}
	// Like the real cursor, rows already taken by next() are not returned again.
	toArray(): T[] {
		const rest = this.rows.slice(this.index)
		this.index = this.rows.length
		return rest
	}
	one(): T {
		const [row] = this.rows
		if (row === undefined || this.rows.length !== 1) {
			throw new Error(`Expected exactly one row, got ${this.rows.length}`)
		}
		return row
	}
	raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
		throw new Error("raw() is not used by ChatSession")
	}
	// Lazy, like the real cursor: iterating consumes rows one at a time via next().
	*[Symbol.iterator](): Generator<T, void> {
		let step = this.next()
		while (!step.done) {
			yield step.value
			step = this.next()
		}
	}
}

class FakeSqlStatement implements SqlStorageStatement {}

/** `SqlStorage` over a real SQLite database. */
class FakeSqlStorage implements SqlStorage {
	readonly Cursor = FakeCursor
	readonly Statement = FakeSqlStatement
	constructor(private readonly db: DatabaseSync) {}
	get databaseSize(): number {
		return 0
	}
	exec<T extends Row>(statement: string, ...bindings: Array<SQLInputValue>): SqlStorageCursor<T> {
		// A migration file is several statements in one string; `node:sqlite`
		// splits those only through `exec`, while parameterised statements need `prepare`.
		if (bindings.length === 0 && /;\s*\S/.test(statement.trim())) {
			this.db.exec(statement)
			return new FakeCursor<T>()
		}
		const prepared = this.db.prepare(statement)
		// `RETURNING` makes a write behave like a read: `ChatSession.append` uses it to get the
		// assigned seq without a second `SELECT MAX(seq)`, and `run()` would swallow the row.
		if (/^\s*(select|pragma)/i.test(statement) || /\breturning\b/i.test(statement)) {
			// SAFETY: `exec<T>` is unchecked in the real runtime too; the caller names its row shape.
			return new FakeCursor(prepared.all(...bindings).map(toStorageRow) as Array<T>)
		}
		prepared.run(...bindings)
		return new FakeCursor<T>()
	}
}

/** `migrated: false` leaves the database empty, for a test that migrates through the activation. */
export const makeFakeDurableObjectState = ({ migrated = true } = {}): FakeDurableObjectState => {
	const pending: Array<Promise<unknown>> = []
	const alarms: Array<number> = []
	const sql = new FakeSqlStorage(new DatabaseSync(":memory:"))

	if (migrated) applyChatSessionMigrations(sql)

	return {
		storage: {
			sql,
			setAlarm: async (scheduledTime) => {
				alarms.push(scheduledTime)
			},
		},
		alarms,
		waitUntil: (promise) => {
			// Swallow rejections here the way the runtime does; a test that cares awaits `pending`.
			pending.push(promise.catch(() => undefined))
		},
		pending,
	}
}
