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

import { Result } from "effect"
import type { Chdb } from "./chdb"
import { buildBatchedInsertStatements, MAX_ESCAPED_PAYLOAD_BYTES } from "./inserts"

export interface InsertBatch {
	readonly datasource: string
	readonly ndjson: string
}

export interface InsertOutcome {
	/** Rows committed. */
	readonly accepted: number
	/** The first insert that failed. The export's later rows were not inserted. */
	readonly failure?: { readonly datasource: string; readonly cause: unknown }
}

interface QueuedExport {
	readonly batches: ReadonlyArray<InsertBatch>
	readonly settle: (outcome: InsertOutcome) => void
	accepted: number
	failure: InsertOutcome["failure"]
}

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

	/** Resolves once the batches are committed, or once an insert of them fails. Never rejects. */
	insert(batches: ReadonlyArray<InsertBatch>): Promise<InsertOutcome> {
		if (batches.length === 0) return Promise.resolve({ accepted: 0 })
		const { promise, resolve } = Promise.withResolvers<InsertOutcome>()
		this.#queue.push({ batches, settle: resolve, accepted: 0, failure: undefined })
		for (const batch of batches) this.#queuedBytes += batch.ndjson.length
		if (this.#queuedBytes >= MAX_ESCAPED_PAYLOAD_BYTES) this.flush()
		else this.#timer ??= setTimeout(() => this.flush(), 0)
		return promise
	}

	/** Insert everything queued now, one datasource at a time. Never throws. */
	flush(): void {
		clearTimeout(this.#timer)
		this.#timer = undefined
		const queue = this.#queue
		if (queue.length === 0) return
		// Taken before the first insert: each insert runs `Chdb.beforeEachStatement`,
		// which calls back into this method and must find nothing left to do.
		this.#queue = []
		this.#queuedBytes = 0
		// By name, the order the encoders emit each export's batches in, so every export
		// meets its own datasources in the order it would have inserted them alone.
		const datasources = [
			...new Set(queue.flatMap(({ batches }) => batches.map(({ datasource }) => datasource))),
		].sort()
		for (const datasource of datasources) {
			// An export whose insert already failed stops there, as it did when it inserted alone.
			const batches = queue.flatMap((owner) => {
				if (owner.failure !== undefined) return []
				const own = owner.batches.filter((batch) => batch.datasource === datasource)
				return own.length === 0
					? []
					: [{ owner, ndjson: own.map((batch) => batch.ndjson).join("\n") }]
			})
			for (const statement of buildBatchedInsertStatements(datasource, batches)) {
				if (statement.parts.every(({ owner }) => owner.failure !== undefined)) continue
				const inserted = Result.try(() => this.#db.exec(statement.sql))
				for (const { owner, rowCount } of statement.parts) {
					if (Result.isSuccess(inserted)) owner.accepted += rowCount
					else owner.failure ??= { datasource, cause: inserted.failure }
				}
			}
		}
		for (const { settle, accepted, failure } of queue)
			settle(failure === undefined ? { accepted } : { accepted, failure })
	}
}
