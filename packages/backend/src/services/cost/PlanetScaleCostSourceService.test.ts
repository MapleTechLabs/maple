import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, PLANETSCALE_COST_RECONNECT_CODE } from "@maple/domain/http"
import { DateTime, Duration, Effect, Fiber, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { PlanetScaleCostSourceService } from "./PlanetScaleCostSourceService"
import {
	authorizePlanetScale,
	connectPlanetScale,
	FAKE_SCOPES_WITHOUT_INVOICES,
	type FakePlanetScale,
	fakeInvoice,
	fakeLineItem,
	fakePlanetScaleDeps,
	makeFakePlanetScale,
} from "./providers/planetscale/fake-planetscale"
import {
	PlanetScaleCostProvider,
	RECONNECT_FOR_INVOICES,
} from "./providers/planetscale/PlanetScaleCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-12T06:00:00Z"))
const RECONNECT = "@maple/http/planetscale-cost/PlanetScaleCostReconnectRequiredError"
const CHANGED = "@maple/http/errors/IntegrationsConnectionChangedError"
const UNAVAILABLE = "@maple/http/planetscale-cost/PlanetScaleCostUnavailableError"
const INVOICES_PATH = "/v1/organizations/acme/invoices"

/** The open month and the one before it, each with one line. */
const invoiced = (overrides: Partial<FakePlanetScale> = {}) =>
	makeFakePlanetScale({
		invoices: [fakeInvoice("2026-11", "2026-12", false), fakeInvoice("2026-10", "2026-11")],
		lineItems: { "inv_2026-11": [fakeLineItem()], "inv_2026-10": [fakeLineItem()] },
		...overrides,
	})

type Deps = Layer.Success<ReturnType<typeof fakePlanetScaleDeps>>

const run = <A, E>(
	testDb: TestDb,
	world: FakePlanetScale,
	effect: Effect.Effect<A, E, Deps | PlanetScaleCostSourceService>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.effect(PlanetScaleCostSourceService, PlanetScaleCostSourceService.make).pipe(
				Layer.provide(Layer.effect(PlanetScaleCostProvider, PlanetScaleCostProvider.make)),
				Layer.provideMerge(fakePlanetScaleDeps(testDb, world)),
			),
		),
	)

/** Connects `ORG` to the fake's organization, with the call log emptied. */
const connect = (testDb: TestDb, world: FakePlanetScale) =>
	Effect.gen(function* () {
		const connectionRef = yield* connectPlanetScale(testDb, world, ORG)
		world.urls.length = 0
		return connectionRef
	})

const status = PlanetScaleCostSourceService.use((service) => service.status(ORG))
const add = (organization = "acme") =>
	PlanetScaleCostSourceService.use((service) => service.add(ORG, organization))
const remove = PlanetScaleCostSourceService.use((service) => service.remove(ORG))

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

const grantRevoked = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ revoked: boolean }>(
			testDb,
			"SELECT revoked_at IS NOT NULL AS revoked FROM oauth_connections WHERE org_id = 'org_cost'",
		),
	).pipe(Effect.map((row) => row?.revoked))

/** Advance the test clock in small steps until the forked run settles, waiting on real I/O in between. */
const settleWithClock = <A, E>(fiber: Fiber.Fiber<A, E>) =>
	Effect.gen(function* () {
		yield* Effect.repeat(
			Effect.gen(function* () {
				yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
				if (fiber.pollUnsafe() !== undefined) return true
				yield* TestClock.adjust(Duration.millis(250))
				return false
			}),
			{ until: (done) => done, times: 400 },
		)
		return yield* Fiber.join(fiber)
	})

const costConnections = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ rows: number }>(testDb, "SELECT count(*)::int AS rows FROM cost_connections"),
	).pipe(Effect.map((row) => row?.rows))

describe("PlanetScaleCostSourceService", () => {
	it.effect("says what the Cost page can offer: nothing connected, then the organization to add", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* status, {
					organization: null,
					invoiceAccess: false,
					added: false,
				})
				// A stored grant with no organization bound yet is not a connection.
				yield* authorizePlanetScale(ORG)
				assert.deepStrictEqual(yield* status, {
					organization: null,
					invoiceAccess: false,
					added: false,
				})
			}),
		)
	})

	it.effect("makes the connected organization a source after one read of its invoice list", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connect(testDb, world)
				assert.deepStrictEqual(yield* status, {
					organization: "acme",
					invoiceAccess: true,
					added: false,
				})
				// The status asks PlanetScale nothing: the stored grant says what it can read.
				assert.deepStrictEqual(world.urls, [])

				assert.deepStrictEqual(yield* add(), { organization: "acme", created: true })
				// One page of the list, with the grant: a refusal would show before the source exists.
				assert.deepStrictEqual(world.urls, [`${INVOICES_PATH}?per_page=50&page=1`])
				assert.deepStrictEqual(world.authorizations, ["Bearer ps-access-token"])

				const made = yield* source(testDb)
				// The source points at the integration's connection: nothing is pasted or stored for it.
				assert.deepStrictEqual(
					[made?.connection_ref, made?.account_id, made?.enabled],
					[connectionRef, "acme", true],
				)
				assert.strictEqual(yield* costConnections(testDb), 0)
				assert.deepStrictEqual(yield* status, {
					organization: "acme",
					invoiceAccess: true,
					added: true,
				})
			}),
		)
	})

	it.effect("adds once: a second add changes nothing and asks PlanetScale nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(testDb, world)
				yield* add()
				const first = yield* source(testDb)
				world.urls.length = 0
				assert.deepStrictEqual(yield* add(), { organization: "acme", created: false })
				assert.deepStrictEqual(world.urls, [])
				assert.deepStrictEqual(yield* source(testDb), first)
			}),
		)
	})

	it.effect(
		"refuses a grant made before Maple asked for invoices, under the reconnect code, without a request",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = invoiced({ grantedScope: FAKE_SCOPES_WITHOUT_INVOICES })
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* connect(testDb, world)
					assert.deepStrictEqual(yield* status, {
						organization: "acme",
						invoiceAccess: false,
						added: false,
					})
					const refused = yield* Effect.flip(add())
					assert.deepStrictEqual(
						[refused._tag, refused.message],
						[RECONNECT, RECONNECT_FOR_INVOICES],
					)
					// The page keys its reconnect link on the code the error answers with.
					assert.strictEqual(
						refused._tag === RECONNECT ? refused.error.code : "",
						PLANETSCALE_COST_RECONNECT_CODE,
					)
					assert.deepStrictEqual(world.urls, [])
					assert.isUndefined(yield* source(testDb))
				}),
			)
		},
	)

	it.effect(
		"refuses under the reconnect code when PlanetScale answers 403 or 401 for invoices, and leaves the grant alone",
		() => {
			const testDb = createTestDb(trackedDbs)
			// The grant reports no scopes, so only the read can tell.
			const world = invoiced({ grantedScope: null, invoicesStatus: 403 })
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* connect(testDb, world)
					const forbidden = yield* Effect.flip(add())
					assert.deepStrictEqual(
						[forbidden._tag, forbidden.message],
						[RECONNECT, RECONNECT_FOR_INVOICES],
					)

					// A 401 that outlives a refresh reads the same to the person adding.
					world.invoicesStatus = 401
					const unauthorized = yield* Effect.flip(add())
					assert.strictEqual(unauthorized._tag, RECONNECT)
					assert.include(unauthorized.message, "Reconnect PlanetScale")
					// An add never revokes the grant the org's metrics and webhooks run on.
					assert.isFalse(yield* grantRevoked(testDb))
					assert.isUndefined(yield* source(testDb))

					// A grant the integration itself found dead is said so without a request.
					yield* Effect.promise(() =>
						executeSql(testDb, "UPDATE oauth_connections SET revoked_at = now()", []),
					)
					world.urls.length = 0
					assert.deepStrictEqual(yield* status, {
						organization: "acme",
						invoiceAccess: false,
						added: false,
					})
					assert.strictEqual((yield* Effect.flip(add()))._tag, RECONNECT)
					assert.deepStrictEqual(world.urls, [])
				}),
			)
		},
	)

	it.effect("reports a PlanetScale outage with its reason, not as a grant to reconnect", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced({ invoicesStatus: 503 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(testDb, world)
				const outage = yield* Effect.flip(add())
				// The page shows this error's message as it is: one of Maple's own sentences.
				assert.deepStrictEqual(
					[outage._tag, outage.message],
					[UNAVAILABLE, "PlanetScale did not answer the invoice request."],
				)
				world.invoicesStatus = 200
				world.invoices = "<html>maintenance</html>"
				assert.strictEqual((yield* Effect.flip(add()))._tag, UNAVAILABLE)
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("gives up on a PlanetScale that does not answer the check within twenty seconds", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(testDb, world)
				// The request is accepted and never answered.
				world.beforeAnswer = () => new Promise<void>(() => {})
				const fiber = yield* Effect.forkChild(Effect.flip(add()))
				yield* TestClock.adjust("19 seconds")
				assert.isUndefined(fiber.pollUnsafe())
				const stalled = yield* settleWithClock(fiber)
				assert.deepStrictEqual(
					[stalled._tag, stalled.message],
					[UNAVAILABLE, "PlanetScale took too long to answer."],
				)
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect(
		"refuses an organization other than the one connected, and an org with nothing connected",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = invoiced()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					assert.strictEqual(
						(yield* Effect.flip(add()))._tag,
						"@maple/http/errors/IntegrationsNotConnectedError",
					)
					yield* connect(testDb, world)
					// The dialog showed another organization than the connection reads by now.
					const mismatch = yield* Effect.flip(add("someone-else"))
					assert.strictEqual(mismatch._tag, CHANGED)
					assert.include(mismatch.message, "another organization (acme)")
					assert.deepStrictEqual(world.urls, [])
					assert.isUndefined(yield* source(testDb))
				}),
			)
		},
	)

	it.effect("sends nothing for an org outside the rollout, which may still remove its source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(testDb, world)
				yield* add()
				world.urls.length = 0
				world.cloudCost = false
				const refusals = yield* Effect.forEach([status, add()], (call) =>
					Effect.map(Effect.flip(call), (error) => error._tag),
				)
				assert.deepStrictEqual(
					refusals,
					Arr.replicate("@maple/http/errors/CloudCostDisabledError", 2),
				)
				assert.deepStrictEqual(world.urls, [])
				assert.deepStrictEqual(yield* remove, { removed: true })
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("removes the source and leaves the connection and its grant alone", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(testDb, world)
				yield* add()
				assert.deepStrictEqual(yield* remove, { removed: true })
				assert.isUndefined(yield* source(testDb))
				// Nothing to remove the second time.
				assert.deepStrictEqual(yield* remove, { removed: false })
				// The integration is as it was: the organization can be added again.
				assert.deepStrictEqual(yield* status, {
					organization: "acme",
					invoiceAccess: true,
					added: false,
				})
			}),
		)
	})

	it.effect("does not add a source for a connection bound to another organization while it checked", () => {
		const testDb = createTestDb(trackedDbs)
		const world = invoiced()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(testDb, world)
				// The check read answers for `acme`; the binding moves before the source is inserted.
				world.beforeAnswer = async () => {
					await executeSql(
						testDb,
						"UPDATE planetscale_connections SET ps_organization = 'second-org' WHERE org_id = 'org_cost'",
						[],
					)
				}
				const moved = yield* Effect.flip(add())
				assert.strictEqual(moved._tag, CHANGED)
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})
})
