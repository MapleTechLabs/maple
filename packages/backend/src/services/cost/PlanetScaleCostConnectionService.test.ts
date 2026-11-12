import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { PlanetScaleCostConnectionService } from "./PlanetScaleCostConnectionService"
import {
	FAKE_PLANETSCALE_ORGANIZATION,
	FAKE_PLANETSCALE_TOKEN,
	FAKE_PLANETSCALE_TOKEN_ID,
	type FakePlanetScale,
	fakeInvoice,
	fakeLineItem,
	fakePlanetScaleDeps,
	makeFakePlanetScale,
} from "./providers/planetscale/fake-planetscale"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const USER = Schema.decodeSync(UserId)("user_cost")
const OTHER_TOKEN_ID = "tokenid9876"
const OTHER_TOKEN = "pscale_tkn_replacement"
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-12T06:00:00Z"))
const VALIDATION = "@maple/http/cost-connections/CostConnectionValidationError"
const PERSISTENCE = "@maple/http/cost-connections/CostConnectionPersistenceError"
const INVOICES_PATH = "/v1/organizations/acme/invoices"

const INPUT = {
	organization: FAKE_PLANETSCALE_ORGANIZATION,
	tokenId: FAKE_PLANETSCALE_TOKEN_ID,
	token: FAKE_PLANETSCALE_TOKEN,
}
const OTHER_INPUT = { ...INPUT, tokenId: OTHER_TOKEN_ID, token: OTHER_TOKEN }

/** The open month and the one before it, each with one line. */
const invoiced = (overrides: Partial<FakePlanetScale> = {}) =>
	makeFakePlanetScale({
		invoices: [fakeInvoice("2026-11", "2026-12", false), fakeInvoice("2026-10", "2026-11")],
		lineItems: { "inv_2026-11": [fakeLineItem()], "inv_2026-10": [fakeLineItem()] },
		...overrides,
	})

const run = <A, E>(
	testDb: TestDb,
	world: FakePlanetScale,
	effect: Effect.Effect<A, E, PlanetScaleCostConnectionService>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.effect(PlanetScaleCostConnectionService, PlanetScaleCostConnectionService.make).pipe(
				Layer.provide(fakePlanetScaleDeps(testDb, world)),
			),
		),
	)

const set = (input: typeof INPUT) =>
	PlanetScaleCostConnectionService.use((service) => service.set(ORG, USER, input))
const remove = PlanetScaleCostConnectionService.use((service) => service.remove(ORG))

interface Stored {
	readonly id: string
	readonly provider: string
	readonly secret_ciphertext: string
	readonly account_id: string
	readonly account_label: string
}

const storedToken = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Stored>(
			testDb,
			"SELECT id, provider, secret_ciphertext, account_id, account_label FROM cost_connections WHERE org_id = 'org_cost'",
		),
	)

interface Source {
	readonly id: string
	readonly connection_ref: string
	readonly account_id: string
	readonly enabled: boolean
}

const source = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Source>(
			testDb,
			"SELECT id, connection_ref, account_id, enabled FROM cost_sources WHERE org_id = 'org_cost' AND provider = 'planetscale'",
		),
	)

describe("PlanetScaleCostConnectionService", () => {
	it.effect("checks a token with PlanetScale, seals it and makes the cost source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set({
					organization: "  Acme ",
					tokenId: ` ${FAKE_PLANETSCALE_TOKEN_ID} `,
					token: `${FAKE_PLANETSCALE_TOKEN}\n`,
				})
				assert.deepStrictEqual(saved, { accountId: "acme", accountLabel: "acme" })
				// The invoice list, then the newest invoice's line items: both reads a pull makes.
				assert.deepStrictEqual(world.urls, [
					`${INVOICES_PATH}?per_page=50&page=1`,
					`${INVOICES_PATH}/inv_2026-11/line-items?per_page=100&page=1`,
				])
				const header = `${FAKE_PLANETSCALE_TOKEN_ID}:${FAKE_PLANETSCALE_TOKEN}`
				assert.deepStrictEqual(world.authorizations, [header, header])

				const stored = yield* storedToken(testDb)
				assert.isFalse(
					Str.includes(FAKE_PLANETSCALE_TOKEN)(stored?.secret_ciphertext ?? FAKE_PLANETSCALE_TOKEN),
				)
				assert.deepStrictEqual(
					[stored?.provider, stored?.account_id, stored?.account_label],
					["planetscale", "acme", "acme"],
				)
				const made = yield* source(testDb)
				assert.deepStrictEqual(
					[made?.connection_ref, made?.account_id, made?.enabled],
					[stored?.id, "acme", true],
				)
			}),
		)
	})

	it.effect("saves a token for an organization PlanetScale never invoiced", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakePlanetScale()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(INPUT)
				assert.deepStrictEqual(world.urls, [`${INVOICES_PATH}?per_page=50&page=1`])
				assert.strictEqual((yield* source(testDb))?.account_id, "acme")
			}),
		)
	})

	it.effect("refuses a token or an organization PlanetScale does not find, naming both", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				// PlanetScale answers 404 for a wrong token and for an organization the token cannot see.
				const refusals = yield* Effect.forEach(
					[
						{ ...INPUT, token: OTHER_TOKEN },
						{ ...INPUT, organization: "someone-else" },
					],
					(input) => Effect.flip(set(input)),
				)
				assert.deepStrictEqual(
					Arr.map(refusals, (error) => [error._tag, error.message]),
					Arr.replicate(
						[
							VALIDATION,
							"PlanetScale found no organization with this name for this service token. Check the organization, the token ID and the token.",
						],
						2,
					),
				)
				world.invoicesStatus = 401
				assert.strictEqual(
					(yield* Effect.flip(set(INPUT))).message,
					"PlanetScale rejected this service token.",
				)
				assert.isUndefined(yield* storedToken(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("refuses a token without invoice access, on the list or on the line items", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced({ invoicesStatus: 403 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const onList = yield* Effect.flip(set(INPUT))
				assert.strictEqual(onList._tag, VALIDATION)
				assert.include(onList.message, "read_invoices organization access")
				world.invoicesStatus = 200
				world.lineItemsStatus = 403
				const onLines = yield* Effect.flip(set(INPUT))
				assert.deepStrictEqual([onLines._tag, onLines.message], [VALIDATION, onList.message])
				assert.isUndefined(yield* storedToken(testDb))
			}),
		)
	})

	it.effect("reports a PlanetScale outage as a retryable failure, not as a bad token", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced({ invoicesStatus: 503 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.strictEqual((yield* Effect.flip(set(INPUT)))._tag, PERSISTENCE)
				world.invoicesStatus = 429
				assert.strictEqual((yield* Effect.flip(set(INPUT)))._tag, PERSISTENCE)
				world.invoicesStatus = 200
				world.lineItems = "<html>maintenance</html>"
				assert.strictEqual((yield* Effect.flip(set(INPUT)))._tag, PERSISTENCE)
				assert.isUndefined(yield* storedToken(testDb))
			}),
		)
	})

	it.effect("never sends text that cannot be an organization, a token ID or a token", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const refusals = yield* Effect.forEach(
					[
						{ ...INPUT, organization: "" },
						{ ...INPUT, organization: "acme/invoices" },
						{ ...INPUT, organization: "two words" },
						{ ...INPUT, organization: Str.repeat(101)("a") },
						{ ...INPUT, tokenId: "" },
						{ ...INPUT, tokenId: "id:with-colon" },
						{ ...INPUT, tokenId: "two words" },
						{ ...INPUT, token: "" },
						{ ...INPUT, token: "a-token-without-its-prefix" },
						{ ...INPUT, token: "pscale_tkn_two words" },
						{ ...INPUT, token: `pscale_tkn_${Str.repeat(300)("a")}` },
					],
					(input) => Effect.map(Effect.flip(set(input)), (error) => error._tag),
				)
				assert.deepStrictEqual(refusals, Arr.replicate(VALIDATION, 11))
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})

	it.effect("sends no token of an org outside the rollout", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced({ cloudCost: false })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const outside = yield* Effect.flip(set(INPUT))
				assert.strictEqual(outside._tag, "@maple/http/errors/CloudCostDisabledError")
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})

	it.effect("keeps the connection and its source when the organization's token is replaced", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(INPUT)
				const first = yield* storedToken(testDb)
				const firstSource = yield* source(testDb)

				world.authorization = `${OTHER_TOKEN_ID}:${OTHER_TOKEN}`
				// Typed with another case: still the same organization.
				yield* set({ ...OTHER_INPUT, organization: "ACME" })
				const second = yield* storedToken(testDb)
				assert.strictEqual(second?.id, first?.id)
				assert.notStrictEqual(second?.secret_ciphertext, first?.secret_ciphertext)
				assert.deepStrictEqual(yield* source(testDb), firstSource)
			}),
		)
	})

	it.effect(
		"refuses a token for another organization while a source exists, and keeps the saved one",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = invoiced()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* set(INPUT)
					const first = yield* storedToken(testDb)

					// The other organization's invoices would overwrite the days the source already holds.
					world.organization = "second-org"
					world.authorization = `${OTHER_TOKEN_ID}:${OTHER_TOKEN}`
					const refused = yield* Effect.flip(set({ ...OTHER_INPUT, organization: "second-org" }))
					assert.strictEqual(refused._tag, VALIDATION)
					assert.include(refused.message, "another PlanetScale organization")
					assert.deepStrictEqual(yield* storedToken(testDb), first)
				}),
			)
		},
	)

	it.effect("makes a source held for its old token's failure due again once the token is replaced", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		const held = Effect.promise(() =>
			queryFirstRow<{
				error: string | null
				reason: string | null
				held: boolean
				failures: number
				leased: boolean
			}>(
				testDb,
				`SELECT last_error AS error, last_error_reason AS reason, next_attempt_at IS NOT NULL AS held,
				        consecutive_failures AS failures, lease_until IS NOT NULL AS leased
				   FROM cost_sources WHERE org_id = 'org_cost'`,
			),
		)
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(INPUT)
				yield* Effect.promise(() =>
					testDb.pglite.query(
						// A pull on the old token is in flight: it holds the source's lease.
						`UPDATE cost_sources SET last_error = 'PlanetScale found no organization for the saved service token.',
						        last_error_reason = 'not_ready', next_attempt_at = now() + interval '6 hours',
						        consecutive_failures = 3, lease_until = now() + interval '20 minutes'`,
					),
				)
				assert.strictEqual((yield* held)?.held, true)
				world.authorization = `${OTHER_TOKEN_ID}:${OTHER_TOKEN}`
				yield* set(OTHER_INPUT)
				assert.deepStrictEqual(yield* held, {
					error: null,
					reason: null,
					held: false,
					failures: 0,
					leased: false,
				})
			}),
		)
	})

	it.effect("removes the token and its source together, without needing the rollout", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(INPUT)
				world.cloudCost = false
				yield* remove
				assert.isUndefined(yield* storedToken(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})
})
