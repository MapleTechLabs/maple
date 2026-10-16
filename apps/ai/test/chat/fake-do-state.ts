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
import { DatabaseSync } from "node:sqlite"
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

/** `migrated: false` leaves the database empty, for a test that migrates through the activation. */
export const makeFakeDurableObjectState = ({ migrated = true } = {}): FakeDurableObjectState => {
	const db = new DatabaseSync(":memory:")
	const pending: Array<Promise<unknown>> = []
	const alarms: Array<number> = []

	const sql = {
		exec: (statement: string, ...bindings: ReadonlyArray<unknown>) => {
			// A migration file is several statements in one string; `node:sqlite`
			// splits those only through `exec`, while parameterised statements need `prepare`.
			if (bindings.length === 0 && /;\s*\S/.test(statement.trim())) {
				db.exec(statement)
				return makeCursor([])
			}
			const prepared = db.prepare(statement)
			// `RETURNING` makes a write behave like a read — `ChatSession.append` uses it to get the
			// assigned seq without a second `SELECT MAX(seq)`, and `run()` would swallow the row.
			if (/^\s*(select|pragma)/i.test(statement) || /\breturning\b/i.test(statement)) {
				return makeCursor(prepared.all(...(bindings as never[])) as Array<Record<string, unknown>>)
			}
			prepared.run(...(bindings as never[]))
			return makeCursor([])
		},
	}

	if (migrated) applyChatSessionMigrations(sql as SqlStorage)

	return {
		storage: {
			sql: sql as SqlStorage,
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

const makeCursor = (rows: Array<Record<string, unknown>>) => ({
	toArray: () => rows,
	one: () => {
		if (rows.length !== 1) {
			throw new Error(`Expected exactly one row, got ${rows.length}`)
		}
		return rows[0]
	},
	[Symbol.iterator]: () => rows[Symbol.iterator](),
})
