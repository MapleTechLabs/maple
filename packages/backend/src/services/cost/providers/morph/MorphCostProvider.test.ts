import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { MorphCostConnectionService } from "../../MorphCostConnectionService"
import { type FakeMorph, fakeMorphDeps, makeFakeMorph } from "./fake-morph"
import { MorphCostProvider, usageRanges } from "./MorphCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const KEY = "sk-FAKE-TEST-KEY-not-a-real-secret"
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-21T14:00:00Z"))

const run = <A, E>(
	testDb: TestDb,
	world: FakeMorph,
	effect: Effect.Effect<A, E, MorphCostProvider | MorphCostConnectionService>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(MorphCostProvider, MorphCostProvider.make),
				Layer.effect(MorphCostConnectionService, MorphCostConnectionService.make),
			).pipe(Layer.provide(fakeMorphDeps(testDb, world))),
		),
	)

const saveKey = (testDb: TestDb, world: FakeMorph) =>
	Effect.gen(function* () {
		yield* MorphCostConnectionService.use((service) => service.set(ORG, USER, KEY))
		const row = yield* Effect.promise(() =>
			queryFirstRow<{ id: string }>(testDb, "SELECT id FROM cost_connections"),
		)
		world.urls.length = 0
		return row?.id ?? ""
	})

const pull = (connectionRef: string, window: { startDay: string; endDay: string }, orgId = ORG) =>
	MorphCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

describe("MorphCostProvider", () => {
	it.effect("reads the window's days and books each model Morph billed as a row", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({
			days: {
				"2026-11-18": [{ model: "DeepSeek V4.1 Flash", spend: 1.842311 }],
				"2026-11-20": [
					{ model: "morph-v3-fast", spend: 0.5 },
					{ model: "morph-v3-large", spend: 0, includedInPlan: true },
				],
				"2026-11-21": [{ model: "morph-v3-fast", spend: 0.25 }],
			},
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const ref = yield* saveKey(testDb, world)
				const pulled = yield* pull(ref, { startDay: "2026-11-19", endDay: "2026-11-24" })
				// Nothing after today is asked for.
				assert.deepStrictEqual(world.urls, ["/api/v1/account/usage?start=2026-11-19&end=2026-11-21"])
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [
						row.day,
						row.cloudService,
						row.usageType,
						row.billedCost,
						row.consumedQuantity,
						row.consumedUnit,
						row.estimated,
					]),
					[
						["2026-11-20", "morph", "morph-v3-fast", 0.5, 1050, "tokens", false],
						["2026-11-21", "morph", "morph-v3-fast", 0.25, 1050, "tokens", true],
					],
				)
				assert.strictEqual(pulled.requests, 0)
			}),
		)
	})

	it.effect("books a day Morph restated lower as an adjustment", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ days: { "2026-11-10": [{ model: "morph-v3-fast", spend: -2 }] } })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const ref = yield* saveKey(testDb, world)
				const pulled = yield* pull(ref, { startDay: "2026-11-01", endDay: "2026-11-21" })
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [row.chargeCategory, row.billedCost]),
					[["adjustment", -2]],
				)
			}),
		)
	})

	it("splits a window into ranges Morph serves in one request", () => {
		assert.deepStrictEqual(usageRanges("2026-11-05", "2026-11-01"), [])
		assert.deepStrictEqual(usageRanges("2025-01-01", "2026-01-01"), [
			{ start: "2025-01-01", end: "2026-01-01" },
		])
		assert.deepStrictEqual(usageRanges("2024-01-01", "2025-01-03"), [
			{ start: "2024-01-01", end: "2024-12-31" },
			{ start: "2025-01-01", end: "2025-01-03" },
		])
	})

	it.effect("fails as auth on a revoked key, and never reads another org's connection", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const ref = yield* saveKey(testDb, world)
				const window = { startDay: "2026-11-01", endDay: "2026-11-21" }
				const stranger = yield* pull(ref, window, OTHER_ORG).pipe(Effect.flip)
				assert.strictEqual(stranger.reason, "auth")
				assert.deepStrictEqual(world.urls, [])

				world.status = 401
				const revoked = yield* pull(ref, window).pipe(Effect.flip)
				assert.strictEqual(revoked.reason, "auth")

				world.status = 200
				world.days = "<html>not json</html>"
				const garbled = yield* pull(ref, window).pipe(Effect.flip)
				assert.strictEqual(garbled.reason, "invalid_response")
			}),
		)
	})
})
