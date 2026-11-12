import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import type { Database } from "@maple/backend/platform/DatabaseLive"
import type { Env } from "@maple/backend/platform/Env"
import type { CostProviderError, CostPullWindow } from "../../CostProvider"
import { connectFakeVercel, type FakeVercel, fakeVercelDeps, jsonl, makeFakeVercel } from "./fake-vercel"
import { VercelCostProvider } from "./VercelCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const WINDOW = { startDay: "2026-11-01", endDay: "2026-11-04" }
/** The pull runs on the window's last day. */
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-04T06:00:00Z"))
const CHARGES_URL =
	"https://api.vercel.com/v1/billing/charges?teamId=team_1&from=2026-11-01T00%3A00%3A00Z&to=2026-11-05T00%3A00%3A00Z"

const run = <A, E>(
	testDb: TestDb,
	world: FakeVercel,
	effect: Effect.Effect<A, E, VercelCostProvider | Database | Env>,
	encryptionKey?: string,
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		return yield* effect
	}).pipe(
		Effect.provide(
			Layer.effect(VercelCostProvider, VercelCostProvider.make).pipe(
				Layer.provideMerge(fakeVercelDeps(testDb, world, encryptionKey)),
			),
		),
	)

const pull = (orgId: OrgId, connectionRef: string, window: CostPullWindow = WINDOW) =>
	VercelCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

const reasonOf = (error: CostProviderError) => [error.reason, error.requests, error.provider]

const charge = (overrides: Readonly<Record<string, unknown>> = {}) => ({
	BilledCost: 1.5,
	BillingCurrency: "USD",
	ChargeCategory: "Usage",
	ChargePeriodStart: "2026-11-02T00:00:00.000Z",
	ChargePeriodEnd: "2026-11-03T00:00:00.000Z",
	ConsumedQuantity: 300,
	ConsumedUnit: "GB-Hours",
	EffectiveCost: 1.5,
	RegionId: "iad1",
	RegionName: "Washington, D.C., USA",
	ServiceCategory: "Compute",
	ServiceName: "Function Duration",
	ServiceProviderName: "Vercel",
	SkuId: "function-duration",
	SubAccountId: "team_1",
	Tags: { ProjectId: "prj_web", ProjectName: "web" },
	...overrides,
})

describe("VercelCostProvider", () => {
	it.effect("reads the team's charges with the connection's token, the window's days whole", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel({
			charges: [
				charge(),
				charge({ BilledCost: 2 }),
				charge({ ChargePeriodStart: "2026-11-04T00:00:00.000Z", BilledCost: 4, RegionId: null }),
				charge({ ChargePeriodStart: "2026-11-03T00:00:00.000Z", BilledCost: 0, EffectiveCost: 0 }),
			],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG, token: "vc_token_abc" })
				const pulled = yield* pull(ORG, connectionRef)
				// One request: from the first day, to the day after the last, which `to` leaves out.
				assert.deepStrictEqual(world.urls, [CHARGES_URL])
				assert.deepStrictEqual(world.authorizations, ["Bearer vc_token_abc"])
				assert.strictEqual(pulled.requests, 0)
				// Rows carry the team's slug, lines of one key are summed, and today can still change.
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [
						row.day,
						row.cloudService,
						row.resourceId,
						row.region,
						row.billedCost,
						row.accountId,
						row.estimated,
					]),
					[
						["2026-11-02", "Function Duration", "web", "iad1", 3.5, "acme", false],
						["2026-11-04", "Function Duration", "web", "global", 4, "acme", true],
					],
				)
			}),
		)
	})

	it.effect("reads a body of several lines, skipping the blank ones", () => {
		const testDb = createTestDb(trackedDbs)
		const lines = [
			charge({ SkuId: "a", BilledCost: 1 }),
			charge({ SkuId: "b", BilledCost: 2 }),
			charge({ SkuId: "c", BilledCost: 3 }),
		]
		// A blank line between charges, Windows line ends, and no newline after the last one.
		const body = `\n${Arr.join(
			Arr.map(lines, (line) => Str.trimEnd(jsonl([line]))),
			"\r\n\r\n",
		)}`
		const world = makeFakeVercel({ charges: body })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG })
				const pulled = yield* pull(ORG, connectionRef)
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [row.usageType, row.billedCost]),
					[
						["a", 1],
						["b", 2],
						["c", 3],
					],
				)
			}),
		)
	})

	it.effect("stores an empty window for a team Vercel billed nothing, body or no body", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel({ charges: "" })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG })
				assert.deepStrictEqual((yield* pull(ORG, connectionRef)).rows, [])
				world.charges = "\n\n"
				assert.deepStrictEqual((yield* pull(ORG, connectionRef)).rows, [])
			}),
		)
	})

	it.effect("fails the whole pull on one line it cannot read, with nothing to store", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG })
				// A good line, then one cut off mid-object.
				world.charges = `${jsonl([charge()])}{"BilledCost": 2, "ServiceName": "Fun\n`
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(ORG, connectionRef))), [
					"invalid_response",
					0,
					"vercel",
				])
				const unreadable = [
					"<html>maintenance</html>",
					jsonl([charge({ BilledCost: "1.50" })]),
					jsonl([charge({ ChargePeriodStart: "soon" })]),
					jsonl([{ BilledCost: 1, ChargePeriodStart: "2026-11-02T00:00:00Z" }]),
				]
				const reasons = yield* Effect.forEach(unreadable, (body) =>
					Effect.gen(function* () {
						world.charges = body
						return (yield* Effect.flip(pull(ORG, connectionRef))).reason
					}),
				)
				assert.deepStrictEqual(reasons, Arr.replicate("invalid_response", 4))
			}),
		)
	})

	it.effect("says what the sync should do about each way Vercel refuses", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG })
				const refusals = yield* Effect.forEach([401, 403, 404, 410, 429, 500, 503], (status) =>
					Effect.gen(function* () {
						world.chargesStatus = status
						const error = yield* Effect.flip(pull(ORG, connectionRef))
						return [status, error.reason, error.requests]
					}),
				)
				assert.deepStrictEqual(refusals, [
					[401, "auth", 0],
					[403, "not_ready", 0],
					[404, "not_ready", 0],
					[410, "not_ready", 0],
					[429, "rate_limited", 0],
					[500, "upstream", 0],
					[503, "upstream", 0],
				])
				// A role without billing access is told which roles have it.
				world.chargesStatus = 403
				assert.include((yield* Effect.flip(pull(ORG, connectionRef))).message, "Billing role")
			}),
		)
	})

	it.effect("does not ask Vercel with a token its poller found rejected", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG, authFailedAt: NOW - 60_000 })
				const error = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual([error.reason, world.urls], ["auth", []])
				assert.include(error.message, "Connect Vercel again")
			}),
		)
	})

	it.effect("refuses a window longer than Vercel serves in one request, before asking", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG })
				// 2024 is a leap year: all of it is 366 days, one more day is too many.
				yield* pull(ORG, connectionRef, { startDay: "2024-01-01", endDay: "2024-12-31" })
				assert.lengthOf(world.urls, 1)
				const error = yield* Effect.flip(
					pull(ORG, connectionRef, { startDay: "2024-01-01", endDay: "2025-01-01" }),
				)
				assert.deepStrictEqual([error.reason, world.urls.length], ["too_large", 1])
			}),
		)
	})

	it.effect("is built on a deployment whose secret key is unusable, and fails only its own pulls", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return Effect.gen(function* () {
			// Sealed with the usable key, read on a deployment that has lost it.
			const connectionRef = yield* run(testDb, world, connectFakeVercel({ orgId: ORG }))
			const error = yield* Effect.flip(
				run(testDb, world, pull(ORG, connectionRef), "not-a-32-byte-key"),
			)
			assert.deepStrictEqual([error.reason, world.urls], ["auth", []])
		})
	})

	it.effect("never reads a token through another org's source, or a connection that is gone", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG })
				assert.strictEqual((yield* Effect.flip(pull(OTHER_ORG, connectionRef))).reason, "auth")
				assert.strictEqual((yield* Effect.flip(pull(ORG, "no-such-connection"))).reason, "auth")
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})
})
