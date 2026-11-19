import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Order, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Investigations, OrgErasures, PrReviewReplies, PrReviews, type OrgErasureRow } from "@maple/db/tables"
import type { OrgId } from "@maple/domain/http"
import { WAREHOUSE_ERASURE_TARGETS, warehouseErasureRank } from "@maple/domain/tinybird/org-erasure-plan"
import { WarehouseDeleteToken } from "@maple/infra/secrets"
import { ReplayBlobEraser } from "@maple/backend/platform/bindings"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { fakeChatSessionsLayer } from "@maple/backend/testing/chat-sessions-fake"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { countOrgRows, ORG_A, ORG_B, seedOrgRow } from "@maple/backend/testing/test-two-orgs"
import {
	type WarehouseDeleteJobState,
	WarehouseDeleteClient,
} from "@maple/backend/services/warehouse/WarehouseDeleteClient"
import {
	erasureBackoffMs,
	MAX_WAREHOUSE_JOBS,
	purgeConversationRows,
	queueOrgErasures,
	replayPrefix,
	runOrgErasures,
} from "./org-erasure"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const SESSION_TABLES = ["investigations", "pr_reviews", "pr_review_replies"] as const

const seedSessions = (testDb: TestDb, orgId: OrgId) =>
	Effect.forEach(SESSION_TABLES, (table) => seedOrgRow(testDb, table, "org_id", orgId), { discard: true })

/** What the deletion does: queue the replay prefix, then purge the rows naming conversations. */
const queue = (orgId: OrgId) =>
	Effect.flatMap(Database, (database) =>
		database.execute((db) =>
			Effect.andThen(
				queueOrgErasures(db, orgId, 0),
				Effect.forEach(
					[Investigations, PrReviews, PrReviewReplies],
					(table) => purgeConversationRows(db, table, orgId, 0),
					{ discard: true },
				),
			),
		),
	)

const erasures = Effect.flatMap(Database, (database) =>
	database.execute((db) =>
		db.run(
			PG.from(OrgErasures)
				.select()
				.orderBy(($) => [[$.target, "asc"]]),
		),
	),
)

/** Everything but the warehouse targets, which wait on their own client. */
const nonWarehouse = Effect.map(erasures, (rows) => Arr.filter(rows, (row) => row.kind !== "warehouse"))

/** A warehouse whose jobs end as `ending` says (done by default); records every job it starts. */
const warehouse = (ending: (jobId: string) => WarehouseDeleteJobState = () => ({ _tag: "Done" })) => {
	const submitted: Array<string> = []
	const layer = Layer.succeed(WarehouseDeleteClient, {
		submit: (datasource) =>
			Effect.sync(() => {
				submitted.push(datasource)
				return `job-${datasource}`
			}),
		status: (jobId) => Effect.sync(() => ending(jobId)),
	})
	return { submitted, layer }
}

const warehouseRow = (datasource: string, jobId: string | null): OrgErasureRow => ({
	id: datasource,
	orgId: ORG_A,
	kind: "warehouse",
	target: datasource,
	jobId,
	attempts: 0,
	lastError: null,
	nextAttemptAt: 0,
	createdAt: 0,
})

/** A replay bucket whose prefix holds `pages` full listing pages. */
const replayBucket = (pages: number) => {
	const prefixes: Array<string> = []
	let left = pages
	const layer = Layer.succeed(ReplayBlobEraser, {
		deletePage: (prefix) =>
			Effect.sync(() => {
				prefixes.push(prefix)
				if (left === 0) return 0
				left -= 1
				return 1000
			}),
	})
	return { prefixes, layer }
}

/** Sessions that erase, except the ones named in `failing`; records every erase it is asked for. */
const chatSessions = (failing: ReadonlyArray<string> = []) => {
	const erased: Array<{ sessionId: string; orgId: string }> = []
	const layer = fakeChatSessionsLayer((sessionId) => ({
		erase: (input) => {
			if (failing.includes(sessionId)) return Promise.reject(new Error("object overloaded"))
			erased.push(input)
			return Promise.resolve(true)
		},
	}))
	return { erased, layer }
}

describe("queueOrgErasures and purgeConversationRows", () => {
	it.effect(
		"queue each of the org's conversations as its row is deleted, and its replay prefix, once",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* seedSessions(testDb, ORG_A)
				yield* seedSessions(testDb, ORG_B)
				yield* queue(ORG_A)
				// A deletion retried after a failure runs the same steps again.
				yield* queue(ORG_A)

				const rows = yield* erasures
				assert.isTrue(Arr.every(rows, (row) => row.orgId === ORG_A))
				// One per OrgId datasource in the plan, and nothing else under that kind.
				assert.deepStrictEqual(
					Arr.sort(
						Arr.map(
							Arr.filter(rows, (row) => row.kind === "warehouse"),
							(row) => row.target,
						),
						Order.String,
					),
					Arr.sort(
						Arr.map(WAREHOUSE_ERASURE_TARGETS, (target) => target.datasource),
						Order.String,
					),
				)
				const sessions = Arr.filter(rows, (row) => row.kind === "chat_session")
				// One conversation per investigation, review and reply, each under the deleted org.
				assert.deepStrictEqual(
					Arr.map(
						[`${ORG_A}:inv-`, `${ORG_A}:pr-`, `${ORG_A}:prr-`],
						(prefix) => Arr.filter(sessions, (row) => Str.startsWith(prefix)(row.target)).length,
					),
					[1, 1, 1],
				)
				assert.deepStrictEqual(
					Arr.map(
						Arr.filter(rows, (row) => row.kind === "replay_blobs"),
						(row) => row.target,
					),
					[`v1/${ORG_A}/`],
				)
				// The rows naming them are gone with the queuing; another org's stay.
				const left = (orgId: OrgId) =>
					Effect.forEach(SESSION_TABLES, (table) => countOrgRows(testDb, table, "org_id", orgId))
				assert.deepStrictEqual(yield* left(ORG_A), [0, 0, 0])
				assert.deepStrictEqual(yield* left(ORG_B), [1, 1, 1])
			}).pipe(Effect.provide(testDb.layer))
		},
	)
})

describe("runOrgErasures", () => {
	it.effect("erases every due target and clears its row", () => {
		const testDb = createTestDb(trackedDbs)
		const sessions = chatSessions()
		const bucket = replayBucket(2)
		return Effect.gen(function* () {
			yield* seedSessions(testDb, ORG_A)
			yield* queue(ORG_A)
			const queued = yield* erasures
			yield* runOrgErasures

			assert.deepStrictEqual(
				Arr.sort(
					Arr.map(sessions.erased, (input) => input.sessionId),
					Order.String,
				),
				Arr.map(
					Arr.filter(queued, (row) => row.kind === "chat_session"),
					(row) => row.target,
				),
			)
			assert.isTrue(Arr.every(sessions.erased, (input) => input.orgId === ORG_A))
			// Two full pages, then the empty listing that says the prefix is clear.
			assert.deepStrictEqual(bucket.prefixes, [
				replayPrefix(ORG_A),
				replayPrefix(ORG_A),
				replayPrefix(ORG_A),
			])
			assert.deepStrictEqual(yield* nonWarehouse, [])
		}).pipe(Effect.provide([testDb.layer, sessions.layer, bucket.layer]))
	})

	it.effect("keeps a failed erase with its error, backs it off, and still finishes the rest", () => {
		const testDb = createTestDb(trackedDbs)
		const failing = `${ORG_A}:inv-stuck`
		const sessions = chatSessions([failing])
		const bucket = replayBucket(0)
		return Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(
					PG.insertInto(OrgErasures).values([
						{
							id: "stuck",
							orgId: ORG_A,
							kind: "chat_session",
							target: failing,
							jobId: null,
							attempts: 2,
							lastError: null,
							nextAttemptAt: 0,
							createdAt: 0,
						},
						{
							id: "fine",
							orgId: ORG_A,
							kind: "chat_session",
							target: `${ORG_A}:inv-fine`,
							jobId: null,
							attempts: 0,
							lastError: null,
							nextAttemptAt: 0,
							createdAt: 0,
						},
					]),
				),
			)
			yield* runOrgErasures

			const [left, ...rest] = yield* erasures
			assert.deepStrictEqual(rest, [])
			assert.strictEqual(left?.id, "stuck")
			assert.strictEqual(left?.attempts, 3)
			assert.strictEqual(left?.nextAttemptAt, erasureBackoffMs(2))
			assert.isNotNull(left?.lastError)

			// Not due yet: the next tick leaves it alone.
			yield* runOrgErasures
			assert.strictEqual((yield* erasures)[0]?.attempts, 3)
		}).pipe(Effect.provide([testDb.layer, sessions.layer, bucket.layer]))
	})

	it.effect("carries a replay prefix too big for one tick over to the next", () => {
		const testDb = createTestDb(trackedDbs)
		const bucket = replayBucket(25)
		const sessions = chatSessions()
		return Effect.gen(function* () {
			yield* queue(ORG_A)
			yield* runOrgErasures
			const [carried] = yield* nonWarehouse
			assert.strictEqual(carried?.kind, "replay_blobs")
			// More to delete is not a failure.
			assert.strictEqual(carried?.attempts, 0)

			yield* runOrgErasures
			assert.deepStrictEqual(yield* nonWarehouse, [])
			assert.strictEqual(bucket.prefixes.length, 26)
		}).pipe(Effect.provide([testDb.layer, sessions.layer, bucket.layer]))
	})

	it.effect(
		"deletes rollups before what feeds them, a few jobs at a time, until every datasource is clear",
		() => {
			const testDb = createTestDb(trackedDbs)
			const jobs = warehouse()
			return Effect.gen(function* () {
				yield* queue(ORG_A)
				const startedPerTick = yield* Effect.forEach(
					Arr.range(1, WAREHOUSE_ERASURE_TARGETS.length * 2 + 4),
					() =>
						Effect.gen(function* () {
							const before = jobs.submitted.length
							yield* runOrgErasures
							return jobs.submitted.length - before
						}),
				)
				assert.isTrue(Arr.every(startedPerTick, (started) => started <= MAX_WAREHOUSE_JOBS))
				assert.deepStrictEqual(
					Arr.sort(jobs.submitted, Order.String),
					Arr.sort(
						Arr.map(WAREHOUSE_ERASURE_TARGETS, (target) => target.datasource),
						Order.String,
					),
				)
				const ranks = Arr.map(jobs.submitted, warehouseErasureRank)
				assert.deepStrictEqual(ranks, Arr.sort(ranks, Order.flip(Order.Number)))
				assert.deepStrictEqual(yield* erasures, [])
			}).pipe(Effect.provide([testDb.layer, chatSessions().layer, replayBucket(0).layer, jobs.layer]))
		},
	)

	it.effect("starts a failed job afresh after the backoff, keeping its reason", () => {
		const testDb = createTestDb(trackedDbs)
		const jobs = warehouse(() => ({ _tag: "Failed", message: "too many parts" }))
		return Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(PG.insertInto(OrgErasures).values([warehouseRow("traces", "job-traces")])),
			)
			yield* runOrgErasures
			const [failed] = yield* erasures
			assert.strictEqual(failed?.jobId, null)
			assert.strictEqual(failed?.attempts, 1)
			assert.strictEqual(failed?.lastError, "too many parts")
			assert.strictEqual(failed?.nextAttemptAt, erasureBackoffMs(0))
		}).pipe(Effect.provide([testDb.layer, jobs.layer]))
	})

	it.effect("waits with a reason while the delete token is not provisioned", () => {
		const testDb = createTestDb(trackedDbs)
		const unprovisioned = Layer.effect(WarehouseDeleteClient, WarehouseDeleteClient.make).pipe(
			Layer.provide([Layer.succeed(WarehouseDeleteToken, Option.none()), FetchHttpClient.layer]),
		)
		return Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(PG.insertInto(OrgErasures).values([warehouseRow("traces", null)])),
			)
			yield* runOrgErasures
			const [waiting] = yield* erasures
			assert.strictEqual(waiting?.attempts, 1)
			assert.strictEqual(waiting?.lastError, "The warehouse delete token is not provisioned")
		}).pipe(Effect.provide([testDb.layer, unprovisioned]))
	})

	it.effect("backs off quickly first and settles at a day", () => {
		assert.deepStrictEqual(
			Arr.map([0, 1, 2, 20, 1000], erasureBackoffMs),
			[300_000, 600_000, 1_200_000, 86_400_000, 86_400_000],
		)
		return Effect.void
	})
})
