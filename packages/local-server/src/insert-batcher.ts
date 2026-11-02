// Coalesces the chDB inserts of concurrent OTLP exports. chDB runs one
// statement at a time on the JS thread, and a traces insert costs nearly the
// same for one span as for fifty, so exports that each insert on arrival
// wait for every insert ahead of them. Exports queued together share one insert
// per datasource instead, and each still answers only after its rows commit.
//
// The window is one timer tick. While an insert runs, the thread is blocked and
// new requests wait in the socket; once it returns, they are all read before
// the next tick and go into one insert. So a lone export waits for nothing,
// and the busier the server, the larger each insert.

import { Effect, Result, Schema } from "effect"
import type { Chdb } from "./chdb"
import {
	buildBatchedInsertStatements,
	buildInsertStatements,
	hasInsertTemplate,
	MAX_ESCAPED_PAYLOAD_BYTES,
} from "./inserts"

export interface InsertBatch {
	readonly datasource: string
	readonly ndjson: string
}

/** An export's insert failed. Its rows before `datasource` are committed, its later ones are not. */
export class LocalInsertError extends Schema.TaggedError<LocalInsertError>()("@maple/cli/LocalInsertError", {
	message: Schema.String,
	datasource: Schema.String,
	/** Rows committed before the failure. */
	accepted: Schema.Number,
	cause: Schema.Defect(),
}) {}

interface QueuedExport {
	readonly batches: ReadonlyArray<InsertBatch>
	readonly settle: (outcome: Result.Result<number, LocalInsertError>) => void
	accepted: number
	failure: { readonly datasource: string; readonly cause: unknown } | undefined
}

/** One export's rows of one datasource, the unit a shared statement carries. */
interface QueuedPart {
	readonly queued: QueuedExport
	readonly ndjson: string
}

const byDatasource = (a: InsertBatch, b: InsertBatch) =>
	a.datasource < b.datasource ? -1 : a.datasource > b.datasource ? 1 : 0

/**
 * Queues each export's rows until the next timer tick, or until a statement's
 * worth is queued, then inserts them all. Every other statement on the
 * connection runs {@link InsertBatcher.flush} first (`Chdb.beforeEachStatement`),
 * so statements still run in the order the requests asked for them.
 */
export class InsertBatcher {
	readonly #db: Pick<Chdb, "exec">
	#queue: QueuedExport[] = []
	#queuedBytes = 0
	#timer: ReturnType<typeof setTimeout> | undefined

	constructor(db: Pick<Chdb, "exec">) {
		this.#db = db
	}

	/** Builds the batcher that every statement on `db` flushes first. */
	static attach(db: Chdb): InsertBatcher {
		const batcher = new InsertBatcher(db)
		db.beforeEachStatement(() => batcher.flush())
		return batcher
	}

	/** Succeeds with the rows committed once they all are; fails at the first insert that fails. */
	insert(batches: ReadonlyArray<InsertBatch>): Effect.Effect<number, LocalInsertError> {
		return Effect.flatMap(
			Effect.promise(() => this.#enqueue(batches)),
			Effect.fromResult,
		)
	}

	#enqueue(batches: ReadonlyArray<InsertBatch>): Promise<Result.Result<number, LocalInsertError>> {
		const unknown = batches.find((batch) => !hasInsertTemplate(batch.datasource))
		if (unknown !== undefined)
			return Promise.resolve(
				Result.fail(failed(0, { datasource: unknown.datasource, cause: "no insert mapping" })),
			)
		if (batches.length === 0) return Promise.resolve(Result.succeed(0))
		const { promise, resolve } = Promise.withResolvers<Result.Result<number, LocalInsertError>>()
		// Each export inserts its datasources in name order, the one order flush can keep
		// for every export at once, so its rows before a failed insert are always the same.
		this.#queue.push({
			batches: [...batches].sort(byDatasource),
			settle: resolve,
			accepted: 0,
			failure: undefined,
		})
		// Escaping only grows the payload, so this undercounts by the escaped `\` and `'`.
		for (const batch of batches) this.#queuedBytes += Buffer.byteLength(batch.ndjson, "utf8")
		if (this.#queuedBytes >= MAX_ESCAPED_PAYLOAD_BYTES) this.flush()
		else this.#timer ??= setTimeout(() => this.flush(), 0)
		return promise
	}

	/** Insert everything queued now, one datasource at a time. Never throws, and settles every export it took. */
	flush(): void {
		clearTimeout(this.#timer)
		this.#timer = undefined
		const queue = this.#queue
		if (queue.length === 0) return
		this.#queue = []
		this.#queuedBytes = 0
		const datasources = [
			...new Set(queue.flatMap(({ batches }) => batches.map(({ datasource }) => datasource))),
		].sort()
		for (const datasource of datasources) {
			// An export whose insert already failed stops there, as it did when it inserted alone.
			const parts = queue.flatMap((owner): QueuedPart[] => {
				if (owner.failure !== undefined) return []
				const own = owner.batches.filter((batch) => batch.datasource === datasource)
				return own.length === 0
					? []
					: [{ queued: owner, ndjson: own.map((batch) => batch.ndjson).join("\n") }]
			})
			// Whatever throws here, every export still settles below rather than waiting forever.
			const inserted = Result.try(() => this.#insertDatasource(datasource, parts))
			if (Result.isFailure(inserted))
				for (const { queued } of parts) queued.failure ??= { datasource, cause: inserted.failure }
		}
		for (const owner of queue)
			owner.settle(
				owner.failure === undefined
					? Result.succeed(owner.accepted)
					: Result.fail(failed(owner.accepted, owner.failure)),
			)
	}

	#insertDatasource(datasource: string, parts: ReadonlyArray<QueuedPart>): void {
		const statements = buildBatchedInsertStatements(
			datasource,
			parts.map((part) => ({ owner: part, ndjson: part.ndjson })),
		)
		for (const statement of statements) {
			// Only an export split over several statements can have failed in an earlier one.
			if (statement.parts.some(({ owner }) => owner.queued.failure !== undefined)) continue
			const inserted = Result.try(() => this.#db.exec(statement.sql))
			if (Result.isSuccess(inserted))
				for (const { owner, rowCount } of statement.parts) owner.queued.accepted += rowCount
			else if (statement.parts.length === 1)
				statement.parts[0]!.owner.queued.failure = { datasource, cause: inserted.failure }
			else
				this.#retryAlone(
					datasource,
					statement.parts.map(({ owner }) => owner),
					inserted.failure,
				)
		}
	}

	/**
	 * A shared statement fails whole, so retry each export alone and only the one
	 * with a row the engine refuses fails. Two failures in a row read as the table
	 * failing for everyone (too many parts, memory), and the rest fail untried.
	 */
	#retryAlone(datasource: string, parts: ReadonlyArray<QueuedPart>, cause: unknown): void {
		let failedInARow = 0
		for (const part of parts) {
			if (failedInARow >= 2) part.queued.failure = { datasource, cause }
			else failedInARow = this.#insertAlone(datasource, part) ? 0 : failedInARow + 1
		}
	}

	#insertAlone(datasource: string, part: QueuedPart): boolean {
		for (const statement of buildInsertStatements(datasource, part.ndjson)) {
			const inserted = Result.try(() => this.#db.exec(statement.sql))
			if (Result.isFailure(inserted)) {
				part.queued.failure = { datasource, cause: inserted.failure }
				return false
			}
			part.queued.accepted += statement.rowCount
		}
		return true
	}
}

const failed = (accepted: number, failure: { readonly datasource: string; readonly cause: unknown }) =>
	new LocalInsertError({
		message: `chDB insert (${failure.datasource}) failed`,
		datasource: failure.datasource,
		accepted,
		cause: failure.cause,
	})
