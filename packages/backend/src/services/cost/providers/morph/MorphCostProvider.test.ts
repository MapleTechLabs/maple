import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Fiber, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { MorphCostConnectionService } from "../../MorphCostConnectionService"
import { type FakeMorph, fakeMorphDeps, makeFakeMorph } from "./fake-morph"
import { MorphCostProvider, readingDay } from "./MorphCostProvider"
import { BEFORE_FIRST_READING } from "./normalize"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const KEY = "sk-FAKE-TEST-KEY-not-a-real-secret"
const at = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso))

const run = <A, E>(
	testDb: TestDb,
	world: FakeMorph,
	effect: Effect.Effect<A, E, MorphCostProvider | MorphCostConnectionService>,
) =>
	effect.pipe(
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

const pullAt = (
	iso: string,
	connectionRef: string,
	window: { startDay: string; endDay: string },
	orgId = ORG,
) =>
	Effect.andThen(
		TestClock.setTime(at(iso)),
		MorphCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window)),
	)

const NOVEMBER = { startDay: "2026-10-01", endDay: "2026-11-30" }

describe("MorphCostProvider", () => {
	it.effect("records a reading each pull and turns the readings into each day's spend", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ members: [{ userId: "user_dev", spent: "77.86" }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* TestClock.setTime(at("2026-11-21T14:00:00Z"))
				const ref = yield* saveKey(testDb, world)
				const first = yield* pullAt("2026-11-21T14:05:00Z", ref, NOVEMBER)
				assert.deepStrictEqual(world.urls, ["/api/v1/org/members/budgets"])
				assert.deepStrictEqual(
					Arr.map(first.rows, (row) => [row.day, row.usageType, row.billedCost, row.resourceId]),
					[["2026-11-01", BEFORE_FIRST_READING, 77.86, "user_dev@example.com"]],
				)
				assert.strictEqual(first.requests, 0)

				world.members = [{ userId: "user_dev", spent: "80.00" }]
				yield* pullAt("2026-11-21T23:30:00Z", ref, NOVEMBER)
				world.members = [{ userId: "user_dev", spent: "81.50" }]
				const third = yield* pullAt("2026-11-22T09:00:00Z", ref, NOVEMBER)
				assert.deepStrictEqual(
					Arr.map(third.rows, (row) => [
						row.day,
						row.usageType,
						Math.round(row.billedCost * 100) / 100,
						row.estimated,
					]),
					[
						["2026-11-01", BEFORE_FIRST_READING, 77.86, false],
						["2026-11-21", "Usage", 2.14, false],
						["2026-11-22", "Usage", 1.5, true],
					],
				)
				// A re-pull of a closed day comes out the same: the readings are the history.
				const again = yield* pullAt("2026-11-22T10:00:00Z", ref, {
					startDay: "2026-11-21",
					endDay: "2026-11-21",
				})
				assert.deepStrictEqual(
					Arr.map(again.rows, (row) => [row.day, Math.round(row.billedCost * 100) / 100]),
					[["2026-11-21", 2.14]],
				)
			}),
		)
	})

	it.effect("a pull that read earlier never overwrites a newer reading of the day", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ members: [{ userId: "user_dev", spent: "5.00" }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* TestClock.setTime(at("2026-11-21T14:00:00Z"))
				const ref = yield* saveKey(testDb, world)
				world.members = [{ userId: "user_dev", spent: "9.00" }]
				yield* pullAt("2026-11-21T18:00:00Z", ref, NOVEMBER)
				// An older pull finishing late, with what it read at 16:00.
				world.members = [{ userId: "user_dev", spent: "7.00" }]
				yield* pullAt("2026-11-21T16:00:00Z", ref, NOVEMBER)
				const day = yield* Effect.promise(() =>
					queryFirstRow<{ closing_micros: string }>(
						testDb,
						"SELECT closing_micros::text FROM morph_spend_readings WHERE day = '2026-11-21'",
					),
				)
				assert.strictEqual(day?.closing_micros, "9000000")
				// A reading taken before the day's first one, written last, moves only the day's start.
				world.members = [{ userId: "user_dev", spent: "4.00" }]
				yield* pullAt("2026-11-21T13:00:00Z", ref, NOVEMBER)
				const ends = yield* Effect.promise(() =>
					queryFirstRow<{ opening_micros: string; closing_micros: string }>(
						testDb,
						"SELECT opening_micros::text, closing_micros::text FROM morph_spend_readings WHERE day = '2026-11-21'",
					),
				)
				assert.deepStrictEqual(ends, { opening_micros: "4000000", closing_micros: "9000000" })
			}),
		)
	})

	it.effect("an older answer that arrives after a newer one leaves the newer reading", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ members: [{ userId: "user_dev", spent: "5.00" }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* TestClock.setTime(at("2026-11-21T14:00:00Z"))
				const ref = yield* saveKey(testDb, world)
				// Seconds apart, inside the request timeout. Pull A asks at 15:00:00 and its answer ($7) is held.
				let release = () => {}
				world.holdNext = new Promise<void>((resolve) => {
					release = resolve
				})
				const reached = new Promise<void>((resolve) => {
					world.onRequest = () => {
						world.onRequest = undefined
						resolve()
					}
				})
				world.members = [{ userId: "user_dev", spent: "7.00" }]
				yield* TestClock.setTime(at("2026-11-21T15:00:00Z"))
				const older = yield* Effect.forkChild(
					MorphCostProvider.use((provider) =>
						provider.pull({ orgId: ORG, connectionRef: ref }, NOVEMBER),
					),
				)
				yield* Effect.promise(() => reached)
				// Pull B asks at 15:00:05, gets $9 and finishes first.
				world.members = [{ userId: "user_dev", spent: "9.00" }]
				yield* pullAt("2026-11-21T15:00:05Z", ref, NOVEMBER)
				// A's answer lands later still.
				yield* TestClock.setTime(at("2026-11-21T15:00:10Z"))
				const asked = world.urls.length
				release()
				yield* Fiber.join(older)
				// A was answered once, not retried after a timeout.
				assert.strictEqual(world.urls.length, asked)
				const day = yield* Effect.promise(() =>
					queryFirstRow<{ closing_micros: string }>(
						testDb,
						"SELECT closing_micros::text FROM morph_spend_readings WHERE day = '2026-11-21'",
					),
				)
				assert.strictEqual(day?.closing_micros, "9000000")
			}),
		)
	})

	it.effect("keeps a reading taken just past midnight in the month Morph says it covers", () => {
		assert.strictEqual(readingDay("2026-11", "2026-12-01"), "2026-11-30")
		assert.strictEqual(readingDay("2026-12", "2026-11-30"), "2026-12-01")
		assert.strictEqual(readingDay("2026-11", "2026-11-15"), "2026-11-15")
		return Effect.void
	})

	it.effect("fails as auth on a revoked key and never reads another org's connection", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ members: [{ userId: "user_dev", spent: "1.00" }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* TestClock.setTime(at("2026-11-21T14:00:00Z"))
				const ref = yield* saveKey(testDb, world)
				const foreign = yield* pullAt("2026-11-21T14:05:00Z", ref, NOVEMBER, OTHER_ORG).pipe(
					Effect.flip,
				)
				assert.strictEqual(foreign.reason, "auth")
				assert.deepStrictEqual(world.urls, [])

				world.status = 401
				const revoked = yield* pullAt("2026-11-21T15:05:00Z", ref, NOVEMBER).pipe(Effect.flip)
				assert.strictEqual(revoked.reason, "auth")
				world.status = 403
				const demoted = yield* pullAt("2026-11-21T16:05:00Z", ref, NOVEMBER).pipe(Effect.flip)
				assert.strictEqual(demoted.reason, "not_ready")
				world.status = 200
				world.members = "<html>"
				const garbled = yield* pullAt("2026-11-21T17:05:00Z", ref, NOVEMBER).pipe(Effect.flip)
				assert.strictEqual(garbled.reason, "invalid_response")
			}),
		)
	})

	it.effect("removing the source deletes its readings", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ members: [{ userId: "user_dev", spent: "3.00" }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* TestClock.setTime(at("2026-11-21T14:00:00Z"))
				const ref = yield* saveKey(testDb, world)
				yield* pullAt("2026-11-21T14:05:00Z", ref, NOVEMBER)
				yield* MorphCostConnectionService.use((service) => service.remove(ORG))
				const left = yield* Effect.promise(() =>
					queryFirstRow<{ n: number }>(
						testDb,
						"SELECT count(*)::int AS n FROM morph_spend_readings",
					),
				)
				assert.strictEqual(left?.n, 0)
			}),
		)
	})
})
