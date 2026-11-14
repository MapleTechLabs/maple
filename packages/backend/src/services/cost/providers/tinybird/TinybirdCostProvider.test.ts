import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { TinybirdCostConnectionService } from "../../TinybirdCostConnectionService"
import type { CostProviderError } from "../../CostProvider"
import { TinybirdCostProvider } from "./TinybirdCostProvider"
import { FAKE_HOST, FAKE_ORG, type FakeTinybird, fakeTinybirdDeps, makeFakeTinybird } from "./fake-tinybird"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const TOKEN = "p.eyJ1IjogIjAxMjM0NTY3ODkiLCAiaWQiOiAiYWJjZGVmIn0.Sig_nature-0123456789"
const WINDOW = { startDay: "2026-11-01", endDay: "2026-11-10" }
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))

const run = <A, E>(
	testDb: TestDb,
	world: FakeTinybird,
	effect: Effect.Effect<A, E, TinybirdCostProvider | TinybirdCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(TinybirdCostProvider, TinybirdCostProvider.make),
				Layer.effect(TinybirdCostConnectionService, TinybirdCostConnectionService.make),
			).pipe(Layer.provide(fakeTinybirdDeps(testDb, world))),
		),
	)

/** Saves `TOKEN` for `ORG` and answers the connection's id, with the fake's call log emptied. */
const saveToken = (testDb: TestDb, world: FakeTinybird) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* TinybirdCostConnectionService.use((service) => service.set(ORG, USER, TOKEN))
		const row = yield* Effect.promise(() =>
			queryFirstRow<{ id: string }>(testDb, "SELECT id FROM cost_connections"),
		)
		world.calls.length = 0
		world.authorizations.length = 0
		return row?.id ?? ""
	})

const pull = (orgId: OrgId, connectionRef: string, window = WINDOW) =>
	TinybirdCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

const reasonOf = (error: CostProviderError) => [error.reason, error.requests, error.provider]

/** The SQL the token's own host was asked, past the host probe. */
const queriesOnHost = (world: FakeTinybird) =>
	Arr.filter(world.calls, (call) => call.host === FAKE_HOST && !Str.includes("LIMIT 1")(call.sql))

describe("TinybirdCostProvider", () => {
	it.effect("reads the window's usage on the token's host and prices it as estimated rows", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird({
			compute: [{ day: "2026-11-09", overage_seconds: 5000 }],
			storage: [{ day: "2026-11-02", workspace_id: "ws_1", bytes: 300e9 }],
			transfer: [{ day: "2026-11-03", workspace_id: "ws_1", kind: "inter", bytes: 20e9 }],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				assert.strictEqual(pulled.requests, 0)
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [
						row.day,
						row.cloudService,
						row.resourceId,
						row.region,
						row.accountId,
						row.basis,
						row.estimated,
					]),
					[
						[
							"2026-11-09",
							"Tinybird compute",
							FAKE_ORG.organization_id,
							"europe-west2",
							FAKE_ORG.organization_id,
							"estimated",
							true,
						],
						[
							"2026-11-02",
							"Tinybird storage",
							"maple_prod",
							"europe-west2",
							FAKE_ORG.organization_id,
							"estimated",
							false,
						],
						[
							"2026-11-03",
							"Tinybird data transfer",
							"maple_prod",
							"europe-west2",
							FAKE_ORG.organization_id,
							"estimated",
							false,
						],
					],
				)
				// The window is in every usage query, end exclusive.
				const usage = queriesOnHost(world)
				assert.strictEqual(usage.length, 4)
				assert.isTrue(
					Arr.every(
						Arr.filter(usage, (call) => !Str.includes("organization.workspaces")(call.sql)),
						(call) =>
							Str.includes("toDateTime('2026-11-01 00:00:00')")(call.sql) &&
							Str.includes("toDateTime('2026-11-11 00:00:00')")(call.sql),
					),
				)
				assert.isTrue(Arr.every(world.authorizations, (header) => header === `Bearer ${TOKEN}`))
			}),
		)
	})

	it.effect("does not ask for vCPU overage of an organization on a dedicated plan", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird({
			workspaces: [{ workspace_id: "ws_1", name: "maple_prod", plan: "enterprise", live: 1 }],
			compute: [{ day: "2026-11-09", overage_seconds: 5000 }],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const pulled = yield* pull(ORG, yield* saveToken(testDb, world))
				assert.deepStrictEqual(pulled.rows, [])
				assert.isFalse(Arr.some(world.calls, (call) => Str.includes("LEFT JOIN")(call.sql)))
			}),
		)
	})

	it.effect("refuses a window whose days are not dates before any usage query", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				const failed = yield* Effect.flip(
					pull(ORG, connectionRef, { startDay: "2026-11-01'", endDay: "2026-11-10" }),
				)
				assert.deepStrictEqual(reasonOf(failed), ["upstream", 0, "tinybird"])
				assert.isFalse(Arr.some(world.calls, (call) => Str.includes("'2026-11-01''")(call.sql)))
			}),
		)
	})

	it.effect("fails as auth when the token stops working, and as not ready when it loses the scope", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				world.invalidToken = true
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(ORG, connectionRef))), [
					"auth",
					0,
					"tinybird",
				])
				world.invalidToken = false
				world.ownRefusal = { status: 403, error: "Not enough permissions" }
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(ORG, connectionRef))), [
					"not_ready",
					0,
					"tinybird",
				])
			}),
		)
	})

	it.effect("never reads a source with another org's connection", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(OTHER_ORG, connectionRef))), [
					"auth",
					0,
					"tinybird",
				])
				assert.deepStrictEqual(world.calls, [])
			}),
		)
	})
})
