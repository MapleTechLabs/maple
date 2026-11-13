import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, Order } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import type { CostProviderError } from "../../CostProvider"
import {
	authorizePlanetScale,
	bindPlanetScale,
	connectPlanetScale,
	FAKE_SCOPES_WITHOUT_INVOICES,
	type FakePlanetScale,
	fakeInvoice,
	fakeLineItem,
	fakePlanetScaleDeps,
	makeFakePlanetScale,
} from "./fake-planetscale"
import { PlanetScaleCostProvider, RECONNECT_FOR_INVOICES } from "./PlanetScaleCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const INVOICES_PATH = "/v1/organizations/acme/invoices"
/** The last two days of a closed month and the first two of the open one. */
const WINDOW = { startDay: "2026-10-30", endDay: "2026-11-02" }
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-02T06:00:00Z"))

/** October closed, November open; one cluster on `main` in each. */
const twoMonths = (overrides: Partial<FakePlanetScale> = {}) =>
	makeFakePlanetScale({
		invoices: [
			fakeInvoice("2026-11", "2026-12", false),
			fakeInvoice("2026-10", "2026-11"),
			fakeInvoice("2026-09", "2026-10"),
		],
		lineItems: {
			"inv_2026-11": [fakeLineItem({ subtotal: "60.00" })],
			"inv_2026-10": [fakeLineItem({ subtotal: "31.00" })],
			"inv_2026-09": [fakeLineItem({ subtotal: "30.00" })],
		},
		...overrides,
	})

type Deps = Layer.Success<ReturnType<typeof fakePlanetScaleDeps>>

const run = <A, E>(
	testDb: TestDb,
	world: FakePlanetScale,
	effect: Effect.Effect<A, E, Deps | PlanetScaleCostProvider>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.effect(PlanetScaleCostProvider, PlanetScaleCostProvider.make).pipe(
				Layer.provideMerge(fakePlanetScaleDeps(testDb, world)),
			),
		),
	)

/** Connects `ORG` to the fake's organization and answers the connection's id, with the call log emptied. */
const connect = (testDb: TestDb, world: FakePlanetScale) =>
	Effect.gen(function* () {
		const connectionRef = yield* connectPlanetScale(testDb, world, ORG)
		world.urls.length = 0
		world.authorizations.length = 0
		world.tokenRequests.length = 0
		return connectionRef
	})

const pull = (orgId: OrgId, connectionRef: string, window = WINDOW) =>
	PlanetScaleCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

const reasonOf = (error: CostProviderError) => [error.reason, error.requests, error.provider]

const grantRevoked = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ revoked: boolean }>(
			testDb,
			"SELECT revoked_at IS NOT NULL AS revoked FROM oauth_connections WHERE org_id = 'org_cost'",
		),
	).pipe(Effect.map((row) => row?.revoked))

describe("PlanetScaleCostProvider", () => {
	it.effect("reads each invoice of the window once with the org's grant, and spreads it over its days", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				// One list, then the two months the window touches. September is not read.
				assert.deepStrictEqual(world.urls, [
					`${INVOICES_PATH}?per_page=50&page=1`,
					`${INVOICES_PATH}/inv_2026-11/line-items?per_page=100&page=1`,
					`${INVOICES_PATH}/inv_2026-10/line-items?per_page=100&page=1`,
				])
				// The stored access token, as a bearer: nothing is exchanged for a live token.
				assert.deepStrictEqual(world.authorizations, Arr.replicate("Bearer ps-access-token", 3))
				assert.deepStrictEqual(world.tokenRequests, [])
				assert.strictEqual(pulled.requests, 0)
				// Rows carry the connection's organization; today and yesterday are not final yet.
				assert.deepStrictEqual(
					Arr.map(
						Arr.sort(
							pulled.rows,
							Order.mapInput(Order.String, (row: (typeof pulled.rows)[number]) => row.day),
						),
						(row) => [
							row.day,
							row.cloudService,
							row.resourceId,
							row.billedCost,
							row.accountId,
							row.estimated,
						],
					),
					[
						["2026-10-30", "orders", "main", 1, "acme", false],
						["2026-10-31", "orders", "main", 1, "acme", false],
						["2026-11-01", "orders", "main", 2, "acme", true],
						["2026-11-02", "orders", "main", 2, "acme", true],
					],
				)
			}),
		)
	})

	it.effect("refreshes an access token PlanetScale no longer takes, and reads with the new one", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				// The stored token has expired at PlanetScale: a refresh issues the one it takes now.
				world.issuedAccessToken = "ps-access-token-2"
				world.authorization = "Bearer ps-access-token-2"
				const pulled = yield* pull(ORG, connectionRef)
				assert.strictEqual(pulled.rows.length, 4)
				assert.deepStrictEqual(world.tokenRequests, ["refresh_token"])
				assert.deepStrictEqual(Arr.take(world.authorizations, 2), [
					"Bearer ps-access-token",
					"Bearer ps-access-token-2",
				])
				assert.isFalse(yield* grantRevoked(testDb))
			}),
		)
	})

	it.effect("fails a grant PlanetScale has revoked as auth, stamps it, and asks nothing more of it", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				// Every token is refused, the refreshed one too.
				world.authorization = "Bearer nothing-is-accepted"
				const first = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual(reasonOf(first), ["auth", 0, "planetscale"])
				assert.include(first.message, "Reconnect PlanetScale")
				assert.isTrue(yield* grantRevoked(testDb))

				// The stamped grant is not tried again: no token is fetched and no invoice asked for.
				world.urls.length = 0
				world.tokenRequests.length = 0
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(ORG, connectionRef))), [
					"auth",
					0,
					"planetscale",
				])
				assert.deepStrictEqual([world.urls, world.tokenRequests], [[], []])
			}),
		)
	})

	it.effect("holds a grant made before Maple asked for invoices, without a request", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths({ grantedScope: FAKE_SCOPES_WITHOUT_INVOICES })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				const error = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual(reasonOf(error), ["not_ready", 0, "planetscale"])
				assert.strictEqual(error.message, RECONNECT_FOR_INVOICES)
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})

	it.effect("asks PlanetScale when the grant reports no scopes at all, and holds it on a 403", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths({ grantedScope: null })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				// Nothing rules the grant out, so the read decides: here PlanetScale allows it.
				assert.strictEqual((yield* pull(ORG, connectionRef)).rows.length, 4)
				world.invoicesStatus = 403
				const error = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual([error.reason, error.message], ["not_ready", RECONNECT_FOR_INVOICES])
				// A 403 is about the scope, not the token: the grant is not stamped revoked.
				assert.isFalse(yield* grantRevoked(testDb))
			}),
		)
	})

	it.effect("says what the sync should do about each other way PlanetScale refuses", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				const reasons = yield* Effect.forEach([404, 429, 502], (status) =>
					Effect.gen(function* () {
						world.invoicesStatus = status
						return (yield* Effect.flip(pull(ORG, connectionRef))).reason
					}),
				)
				assert.deepStrictEqual(reasons, ["not_ready", "rate_limited", "upstream"])
				// A refusal on a month's line items fails the pull the same way: no part of it is kept.
				world.invoicesStatus = 200
				world.lineItemsStatus = 403
				assert.strictEqual(
					(yield* Effect.flip(pull(ORG, connectionRef))).message,
					RECONNECT_FOR_INVOICES,
				)
			}),
		)
	})

	it.effect("reads every page of a month's line items", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths({
			invoices: [fakeInvoice("2026-10", "2026-11")],
			lineItems: {
				"inv_2026-10": Arr.makeBy(5, (index) =>
					fakeLineItem({ id: `line_${index}`, database_name: `db_${index}`, subtotal: "31.00" }),
				),
			},
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				world.maxPerPage = 2
				const pulled = yield* pull(ORG, connectionRef, {
					startDay: "2026-10-01",
					endDay: "2026-10-31",
				})
				// Five databases on each of 31 days, read in three pages after the list.
				assert.strictEqual(pulled.rows.length, 5 * 31)
				assert.strictEqual(world.urls.length, 4)
			}),
		)
	})

	it.effect("fails an answer it cannot read as invalid, with nothing to store", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				world.invoices = "<html>maintenance</html>"
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(ORG, connectionRef))), [
					"invalid_response",
					0,
					"planetscale",
				])
			}),
		)
	})

	it.effect("never reads through another org's connection, one that is gone, or without a grant", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				assert.strictEqual((yield* Effect.flip(pull(OTHER_ORG, connectionRef))).reason, "auth")
				assert.strictEqual((yield* Effect.flip(pull(ORG, "no-such-connection"))).reason, "auth")
				// A connection row whose org never authorized PlanetScale has no token to read with.
				const orphan = yield* bindPlanetScale(testDb, OTHER_ORG, "acme", "psconn_b")
				assert.strictEqual((yield* Effect.flip(pull(OTHER_ORG, orphan))).reason, "auth")
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})

	it.effect("reads the organization the connection is bound to, not one the grant could also see", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* authorizePlanetScale(ORG)
				const connectionRef = yield* bindPlanetScale(testDb, ORG, "other-team")
				world.urls.length = 0
				// The fake's grant sees `acme` only: the bound organization answers 404.
				const error = yield* Effect.flip(pull(ORG, connectionRef))
				assert.strictEqual(error.reason, "not_ready")
				assert.deepStrictEqual(world.urls, [
					"/v1/organizations/other-team/invoices?per_page=50&page=1",
				])
			}),
		)
	})
})
