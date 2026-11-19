import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Order, Array as Arr, String as Str } from "effect"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgErasures } from "@maple/db/tables"
import type { OrgId } from "@maple/domain/http"
import { ReplayBlobEraser } from "@maple/backend/platform/bindings"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { fakeChatSessionsLayer } from "@maple/backend/testing/chat-sessions-fake"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { ORG_A, ORG_B, seedOrgRow } from "@maple/backend/testing/test-two-orgs"
import { erasureBackoffMs, queueOrgErasures, replayPrefix, runOrgErasures } from "./org-erasure"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const SESSION_TABLES = ["investigations", "pr_reviews", "pr_review_replies"] as const

const seedSessions = (testDb: TestDb, orgId: OrgId) =>
	Effect.forEach(SESSION_TABLES, (table) => seedOrgRow(testDb, table, "org_id", orgId), { discard: true })

const queue = (orgId: OrgId) =>
	Effect.flatMap(Database, (database) => database.execute((db) => queueOrgErasures(db, orgId, 0)))

const erasures = Effect.flatMap(Database, (database) =>
	database.execute((db) =>
		db.run(
			PG.from(OrgErasures)
				.select()
				.orderBy(($) => [[$.target, "asc"]]),
		),
	),
)

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

describe("queueOrgErasures", () => {
	it.effect(
		"queues each of the org's conversations and its replay prefix once, and nothing of another org",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* seedSessions(testDb, ORG_A)
				yield* seedSessions(testDb, ORG_B)
				yield* queue(ORG_A)
				// A deletion retried after a failure queues the same targets again.
				yield* queue(ORG_A)

				const rows = yield* erasures
				assert.deepStrictEqual(
					Arr.map(rows, (row) => row.orgId),
					[ORG_A, ORG_A, ORG_A, ORG_A],
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
			assert.deepStrictEqual(yield* erasures, [])
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
			const [carried] = yield* erasures
			assert.strictEqual(carried?.kind, "replay_blobs")
			// More to delete is not a failure.
			assert.strictEqual(carried?.attempts, 0)

			yield* runOrgErasures
			assert.deepStrictEqual(yield* erasures, [])
			assert.strictEqual(bucket.prefixes.length, 26)
		}).pipe(Effect.provide([testDb.layer, sessions.layer, bucket.layer]))
	})

	it.effect("backs off quickly first and settles at a day", () => {
		assert.deepStrictEqual(
			Arr.map([0, 1, 2, 20, 1000], erasureBackoffMs),
			[300_000, 600_000, 1_200_000, 86_400_000, 86_400_000],
		)
		return Effect.void
	})
})
