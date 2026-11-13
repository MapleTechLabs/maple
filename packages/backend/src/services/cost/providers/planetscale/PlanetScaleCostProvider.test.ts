import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, Order } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import type { CostProviderError } from "../../CostProvider"
import { PlanetScaleCostConnectionService } from "../../PlanetScaleCostConnectionService"
import {
	FAKE_PLANETSCALE_ORGANIZATION,
	FAKE_PLANETSCALE_TOKEN,
	FAKE_PLANETSCALE_TOKEN_ID,
	type FakePlanetScale,
	fakeInvoice,
	fakeLineItem,
	fakePlanetScaleDeps,
	makeFakePlanetScale,
} from "./fake-planetscale"
import { PlanetScaleCostProvider } from "./PlanetScaleCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const INVOICES_PATH = "/v1/organizations/acme/invoices"
const HEADER = `${FAKE_PLANETSCALE_TOKEN_ID}:${FAKE_PLANETSCALE_TOKEN}`
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

const run = <A, E>(
	testDb: TestDb,
	world: FakePlanetScale,
	effect: Effect.Effect<A, E, PlanetScaleCostProvider | PlanetScaleCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(PlanetScaleCostProvider, PlanetScaleCostProvider.make),
				Layer.effect(PlanetScaleCostConnectionService, PlanetScaleCostConnectionService.make),
			).pipe(Layer.provide(fakePlanetScaleDeps(testDb, world))),
		),
	)

/** Saves the fake's token for `ORG` and answers the connection's id, with the fake's call log emptied. */
const saveToken = (testDb: TestDb, world: FakePlanetScale) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* PlanetScaleCostConnectionService.use((service) =>
			service.set(ORG, USER, {
				organization: FAKE_PLANETSCALE_ORGANIZATION,
				tokenId: FAKE_PLANETSCALE_TOKEN_ID,
				token: FAKE_PLANETSCALE_TOKEN,
			}),
		)
		const row = yield* Effect.promise(() =>
			queryFirstRow<{ id: string }>(testDb, "SELECT id FROM cost_connections"),
		)
		world.urls.length = 0
		world.authorizations.length = 0
		return row?.id ?? ""
	})

const pull = (orgId: OrgId, connectionRef: string, window = WINDOW) =>
	PlanetScaleCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

const reasonOf = (error: CostProviderError) => [error.reason, error.requests, error.provider]

describe("PlanetScaleCostProvider", () => {
	it.effect(
		"reads each invoice of the window once with the saved token, and spreads it over its days",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = twoMonths()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const connectionRef = yield* saveToken(testDb, world)
					const pulled = yield* pull(ORG, connectionRef)
					// One list, then the two months the window touches. September is not read.
					assert.deepStrictEqual(world.urls, [
						`${INVOICES_PATH}?per_page=50&page=1`,
						`${INVOICES_PATH}/inv_2026-11/line-items?per_page=100&page=1`,
						`${INVOICES_PATH}/inv_2026-10/line-items?per_page=100&page=1`,
					])
					assert.deepStrictEqual(world.authorizations, Arr.replicate(HEADER, 3))
					assert.strictEqual(pulled.requests, 0)
					// Rows carry the organization; today and yesterday are not final yet.
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
								row.usageType,
								row.billedCost,
								row.accountId,
								row.estimated,
							],
						),
						[
							["2026-10-30", "orders", "main", "PS_10_AWS_ARM", 1, "acme", false],
							["2026-10-31", "orders", "main", "PS_10_AWS_ARM", 1, "acme", false],
							["2026-11-01", "orders", "main", "PS_10_AWS_ARM", 2, "acme", true],
							["2026-11-02", "orders", "main", "PS_10_AWS_ARM", 2, "acme", true],
						],
					)
				}),
			)
		},
	)

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
				const connectionRef = yield* saveToken(testDb, world)
				world.maxPerPage = 2
				const pulled = yield* pull(ORG, connectionRef, {
					startDay: "2026-10-01",
					endDay: "2026-10-31",
				})
				// Five databases on each of 31 days, read in three pages after the list.
				assert.strictEqual(pulled.rows.length, 5 * 31)
				assert.strictEqual(world.urls.length, 4)
				assert.closeTo(
					Arr.reduce(pulled.rows, 0, (sum, row) => sum + row.billedCost),
					5 * 31,
					1e-9,
				)
			}),
		)
	})

	it.effect("returns no rows for days no invoice bills, with nothing but the list read", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				const pulled = yield* pull(ORG, connectionRef, {
					startDay: "2026-05-01",
					endDay: "2026-05-31",
				})
				assert.deepStrictEqual(pulled, { rows: [], requests: 0 })
				assert.deepStrictEqual(world.urls, [`${INVOICES_PATH}?per_page=50&page=1`])
			}),
		)
	})

	it.effect("says what the sync should do about each way PlanetScale refuses", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				const reasons = yield* Effect.forEach([401, 403, 404, 429, 502], (status) =>
					Effect.gen(function* () {
						world.invoicesStatus = status
						return (yield* Effect.flip(pull(ORG, connectionRef))).reason
					}),
				)
				assert.deepStrictEqual(reasons, [
					"auth",
					"not_ready",
					"not_ready",
					"rate_limited",
					"upstream",
				])
				// A refusal on a month's line items fails the pull the same way: no part of it is kept.
				world.invoicesStatus = 200
				world.lineItemsStatus = 403
				const error = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual(reasonOf(error), ["not_ready", 0, "planetscale"])
				assert.include(error.message, "read_invoices organization access")
			}),
		)
	})

	it.effect("holds a source whose token PlanetScale no longer knows, and says to replace it", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				// The token was deleted in PlanetScale: it answers 404, as for an unknown organization.
				world.authorization = "tokenid9876:pscale_tkn_another"
				const error = yield* Effect.flip(pull(ORG, connectionRef))
				assert.deepStrictEqual(reasonOf(error), ["not_ready", 0, "planetscale"])
				assert.include(error.message, "replace it")
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
				const connectionRef = yield* saveToken(testDb, world)
				world.invoices = "<html>maintenance</html>"
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(ORG, connectionRef))), [
					"invalid_response",
					0,
					"planetscale",
				])
				// A line without a readable amount is not guessed at.
				world.invoices = [fakeInvoice("2026-10", "2026-11")]
				world.lineItems = { "inv_2026-10": [fakeLineItem({ subtotal: "about thirty" })] }
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
			}),
		)
	})

	it.effect("is built on a deployment whose secret key is unusable, and fails only its own pulls", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				testDb.pglite.query(
					`INSERT INTO cost_connections
					   (id, org_id, provider, secret_ciphertext, secret_iv, secret_tag, account_id, account_label, created_at, updated_at, updated_by)
					 VALUES ('conn_a', 'org_cost', 'planetscale', 'sealed', 'iv', 'tag', 'acme', 'acme', now(), now(), 'user_cost')`,
				),
			)
			const error = yield* Effect.flip(pull(ORG, "conn_a"))
			assert.deepStrictEqual([error.reason, world.urls], ["auth", []])
		}).pipe(
			Effect.provide(
				Layer.effect(PlanetScaleCostProvider, PlanetScaleCostProvider.make).pipe(
					Layer.provide(fakePlanetScaleDeps(testDb, world, "not-a-32-byte-key")),
				),
			),
		)
	})

	it.effect("never reads a token through another org's source, or a connection that is gone", () => {
		const testDb = createTestDb(trackedDbs)
		const world = twoMonths()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveToken(testDb, world)
				assert.strictEqual((yield* Effect.flip(pull(OTHER_ORG, connectionRef))).reason, "auth")
				assert.strictEqual((yield* Effect.flip(pull(ORG, "no-such-connection"))).reason, "auth")
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})
})
