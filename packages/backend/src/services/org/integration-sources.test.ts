import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { OrgId, SourceId } from "@maple/domain/primitives"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, insertTestSource, type TestDb } from "@maple/backend/platform/test-pglite"
import { pollReportDue, upsertWithSource } from "./integration-sources"

const trackedDbs: TestDb[] = []

const now = 10 * 60_000
const recorded = { lastPollAt: now - 30_000, lastPollError: null, disconnectedAt: null }

describe("pollReportDue", () => {
	it("skips a tick that changes nothing within a minute of the last record", () => {
		expect(pollReportDue(recorded, { _tag: "Ok" }, now)).toBe(false)
		expect(pollReportDue({ ...recorded, lastPollAt: now - 90_000 }, { _tag: "Ok" }, now)).toBe(true)
	})

	it("writes as soon as the outcome moves", () => {
		expect(pollReportDue(recorded, { _tag: "Failed", error: "HTTP 503" }, now)).toBe(true)
		expect(
			pollReportDue({ ...recorded, lastPollError: "HTTP 503" }, { _tag: "Failed", error: "HTTP 503" }, now),
		).toBe(false)
		expect(pollReportDue({ ...recorded, lastPollError: "HTTP 503" }, { _tag: "Ok" }, now)).toBe(true)
		expect(pollReportDue(recorded, { _tag: "Disconnected", reason: "Revoked" }, now)).toBe(true)
		expect(pollReportDue({ ...recorded, disconnectedAt: now - 60_000 }, { _tag: "Ok" }, now)).toBe(true)
	})
})

const sourceIds = (testDb: TestDb) =>
	Effect.promise(() => testDb.pglite.query<{ id: string }>("SELECT id FROM sources ORDER BY id")).pipe(
		Effect.map((result) => result.rows.map((row) => row.id)),
	)

const orgId = Schema.decodeUnknownSync(OrgId)("org_upsert")
const asSourceId = Schema.decodeUnknownSync(SourceId)
const ref = { platform: "railway", name: "Railway" } as const

describe("upsertWithSource", () => {
	afterEach(async () => {
		await cleanupTestDbs(trackedDbs)
	})

	it.effect("creates a source for a new row and reuses the row's source on a later upsert", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const database = yield* Database
			const upsert = (current: SourceId | null) =>
				database.execute((db) =>
					upsertWithSource(db, orgId, ref, 0, Effect.succeed(current), (sourceId) =>
						Effect.succeed({ sourceId }),
					),
				)
			const created = yield* upsert(null)
			assert.lengthOf(yield* sourceIds(testDb), 1)
			const reused = yield* upsert(created?.sourceId ?? null)
			assert.strictEqual(reused?.sourceId, created?.sourceId)
			assert.deepStrictEqual(yield* sourceIds(testDb), [created?.sourceId])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("deletes the source it created when a concurrent upsert kept another one", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const winner = asSourceId(
				yield* Effect.promise(() => insertTestSource(testDb, { orgId, platform: "railway" })),
			)
			const database = yield* Database
			const row = yield* database.execute((db) =>
				upsertWithSource(db, orgId, ref, 0, Effect.succeed(null), () =>
					Effect.succeed({ sourceId: winner }),
				),
			)
			assert.strictEqual(row?.sourceId, winner)
			assert.deepStrictEqual(yield* sourceIds(testDb), [winner])
		}).pipe(Effect.provide(testDb.layer))
	})
})
