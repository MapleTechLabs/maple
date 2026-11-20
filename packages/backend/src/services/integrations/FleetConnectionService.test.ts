import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { Array as Arr, Effect, Layer, Order, Schema, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { FleetConnectionService } from "./FleetConnectionService"
import { FAKE_FLEET_TOKEN, type FakeFleet, fakeFleetDeps, makeFakeFleet } from "./fleet/fake-fleet"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_fleet")
const USER = Schema.decodeSync(UserId)("user_fleet")

const run = <A, E>(testDb: TestDb, world: FakeFleet, effect: Effect.Effect<A, E, FleetConnectionService>) =>
	effect.pipe(
		Effect.provide(
			Layer.effect(FleetConnectionService, FleetConnectionService.make).pipe(
				Layer.provide(fakeFleetDeps(testDb, world)),
			),
		),
	)

const connect = (url: string, token = FAKE_FLEET_TOKEN) =>
	FleetConnectionService.use((service) => service.connect(ORG, USER, { url, token }))

interface Stored {
	readonly base_url: string
	readonly token_ciphertext: string
	readonly organization_name: string | null
}

const stored = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Stored>(
			testDb,
			"SELECT base_url, token_ciphertext, organization_name FROM fleet_connections WHERE org_id = 'org_fleet'",
		),
	)

const connectedAt = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ readonly created_at: Date }>(
			testDb,
			"SELECT created_at FROM fleet_connections WHERE org_id = 'org_fleet'",
		),
	).pipe(Effect.map((row) => row?.created_at.getTime() ?? 0))

describe("FleetConnectionService", () => {
	it.effect("checks the token with the server, seals it and reports what the server said", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ tier: "premium" })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				// A pasted API path and a missing scheme both land on the server's base URL.
				const status = yield* connect("fleet.example.com/api/v1/fleet/hosts/")
				assert.deepStrictEqual(
					[
						status.connected,
						status.baseUrl,
						status.organizationName,
						status.apiUserRole,
						status.serverVersion,
						status.licenseTier,
					],
					[true, "https://fleet.example.com", "Acme Corp", "observer", "4.62.0", "premium"],
				)
				assert.deepStrictEqual(
					Arr.sort(
						Arr.map(world.fake.calls, (call) => call.path),
						Order.String,
					),
					["/api/v1/fleet/config", "/api/v1/fleet/me", "/api/v1/fleet/version"],
				)
				assert.isTrue(
					Arr.every(
						world.fake.calls,
						(call) => call.authorization === `Bearer ${FAKE_FLEET_TOKEN}`,
					),
				)
				const row = yield* stored(testDb)
				assert.strictEqual(row?.base_url, "https://fleet.example.com")
				assert.isFalse(Str.includes(FAKE_FLEET_TOKEN)(row?.token_ciphertext ?? FAKE_FLEET_TOKEN))
			}),
		)
	})

	it.effect("refuses a token Fleet rejects and a user without a global role, storing nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({ status: 401 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const rejected = yield* Effect.flip(connect("https://fleet.example.com"))
				assert.strictEqual(rejected._tag, "@maple/http/errors/IntegrationsValidationError")
				assert.strictEqual(rejected.message, "Fleet rejected the API token.")

				world.status = null
				world.globalRole = null
				const teamOnly = yield* Effect.flip(connect("https://fleet.example.com"))
				assert.include(teamOnly.message, "no global role")
				assert.isUndefined(yield* stored(testDb))
			}),
		)
	})

	it.effect(
		"says the address could not be reached when Cloudflare answers for a host that does not resolve",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeFleet({ status: 530 })
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					// 5xx answers are retried with back-off first.
					const unreachable = yield* VendorFake.elapsing(
						Effect.flip(connect("https://fleet.invalid")),
					)
					assert.strictEqual(
						unreachable.message,
						"Maple could not reach this address. Check the Fleet URL.",
					)
					assert.isUndefined(yield* stored(testDb))
				}),
			)
		},
	)

	it.effect("refuses plain http and internal addresses before sending the token anywhere", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const plain = yield* Effect.flip(connect("http://fleet.example.com"))
				assert.include(plain.message, "https://")
				yield* Effect.flip(connect("https://127.0.0.1"))
				yield* Effect.flip(connect("https://user:pass@fleet.example.com"))
				assert.lengthOf(world.fake.calls, 0)
			}),
		)
	})

	it.effect("replaces the server on reconnect and forgets it on disconnect", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect("https://fleet.example.com")
				world.orgName = "Acme Devices"
				const again = yield* connect("https://fleet.example.com")
				assert.strictEqual(again.organizationName, "Acme Devices")

				// Another server is a new connection, connected now.
				const before = yield* connectedAt(testDb)
				yield* TestClock.adjust(60_000)
				yield* connect("https://devices.example.com")
				assert.strictEqual((yield* connectedAt(testDb)) - before, 60_000)
				assert.strictEqual((yield* stored(testDb))?.base_url, "https://devices.example.com")

				const service = yield* FleetConnectionService
				assert.isTrue(yield* service.disconnect(ORG))
				assert.isFalse(yield* service.disconnect(ORG))
				assert.isFalse((yield* service.getStatus(ORG)).connected)
			}),
		)
	})
})
