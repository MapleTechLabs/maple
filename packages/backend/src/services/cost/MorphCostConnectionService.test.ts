import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { MorphCostConnectionService } from "./MorphCostConnectionService"
import { type FakeMorph, fakeMorphDeps, makeFakeMorph } from "./providers/morph/fake-morph"
import { MorphCostProvider } from "./providers/morph/MorphCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const USER = Schema.decodeSync(UserId)("user_cost")
const KEY = "sk-FAKE-TEST-KEY-not-a-real-secret"
const OTHER_KEY = "sk-FAKE-TEST-KEY-not-a-real-secret-2"
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-21T14:00:00Z"))
const VALIDATION = "@maple/http/cost-connections/CostConnectionValidationError"
const PERSISTENCE = "@maple/http/cost-connections/CostConnectionPersistenceError"

const run = <A, E>(
	testDb: TestDb,
	world: FakeMorph,
	effect: Effect.Effect<A, E, MorphCostConnectionService | MorphCostProvider>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(MorphCostConnectionService, MorphCostConnectionService.make),
				Layer.effect(MorphCostProvider, MorphCostProvider.make),
			).pipe(Layer.provide(fakeMorphDeps(testDb, world))),
		),
	)

const set = (key: string) => MorphCostConnectionService.use((service) => service.set(ORG, USER, key))

const stored = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ id: string; secret_ciphertext: string; account_id: string }>(
			testDb,
			"SELECT id, secret_ciphertext, account_id FROM cost_connections WHERE org_id = 'org_cost' AND provider = 'morph'",
		),
	)

describe("MorphCostConnectionService", () => {
	it.effect("checks the key with Morph, seals it and makes the cost source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ members: [{ userId: "user_dev", spent: "1.00" }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(`  ${KEY}  `)
				assert.deepStrictEqual(saved, { accountId: "organization", accountLabel: "Organization" })
				assert.deepStrictEqual(world.urls, ["/api/v1/org/members/budgets"])
				assert.deepStrictEqual(world.authorizations, [`Bearer ${KEY}`])
				const row = yield* stored(testDb)
				assert.isDefined(row)
				assert.isFalse(Str.includes(KEY)(row?.secret_ciphertext ?? KEY))
				const source = yield* Effect.promise(() =>
					queryFirstRow<{ connection_ref: string }>(
						testDb,
						"SELECT connection_ref FROM cost_sources WHERE org_id = 'org_cost' AND provider = 'morph'",
					),
				)
				assert.strictEqual(source?.connection_ref, row?.id)
			}),
		)
	})

	it.effect(
		"keeps the reading the key check took, so a month ending before the first sync is not lost",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeMorph({
				month: "2026-11",
				members: [{ userId: "user_dev", spent: "300.00" }],
			})
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* TestClock.setTime(
						DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-30T23:58:00Z")),
					)
					yield* set(KEY)
					const ref = (yield* stored(testDb))?.id ?? ""
					// The first sync runs after Morph rolled over to December.
					yield* TestClock.setTime(
						DateTime.toEpochMillis(DateTime.makeUnsafe("2026-12-01T00:05:00Z")),
					)
					world.month = "2026-12"
					world.members = [{ userId: "user_dev", spent: "0.00" }]
					const pulled = yield* MorphCostProvider.use((provider) =>
						provider.pull(
							{ orgId: ORG, connectionRef: ref },
							{ startDay: "2026-11-01", endDay: "2026-12-01" },
						),
					)
					const november = Arr.reduce(
						Arr.filter(pulled.rows, (row) => row.day < "2026-12-01"),
						0,
						(total, row) => total + row.billedCost,
					)
					assert.strictEqual(november, 300)
				}),
			)
		},
	)

	it.effect("refuses text that is not a key without calling Morph, and says why Morph refused one", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const notKey = yield* set("pk-something").pipe(Effect.flip)
				assert.strictEqual(notKey._tag, VALIDATION)
				assert.deepStrictEqual(world.urls, [])

				world.status = 401
				const rejected = yield* set(KEY).pipe(Effect.flip)
				assert.strictEqual(rejected._tag, VALIDATION)
				assert.include(rejected.message, "Morph rejected this key")

				world.status = 403
				const personal = yield* set(KEY).pipe(Effect.flip)
				assert.strictEqual(personal._tag, VALIDATION)
				assert.include(personal.message, "owned by one of its admins")

				// An answer Maple did not expect is no verdict on the key.
				world.status = 400
				const down = yield* set(KEY).pipe(Effect.flip)
				assert.strictEqual(down._tag, PERSISTENCE)
				assert.isUndefined(yield* stored(testDb))
			}),
		)
	})

	it.effect("replaces the key of the same organization, and refuses another organization's", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ members: [{ userId: "user_dev", spent: "1.00" }] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(KEY)
				const first = yield* stored(testDb)
				yield* MorphCostProvider.use((provider) =>
					provider.pull(
						{ orgId: ORG, connectionRef: first?.id ?? "" },
						{ startDay: "2026-11-01", endDay: "2026-11-21" },
					),
				)

				// The same organization, a member more.
				world.members = [
					{ userId: "user_dev", spent: "1.00" },
					{ userId: "user_ops", spent: "0.00" },
					{ userId: "user_qa", spent: "0.00" },
				]
				yield* set(OTHER_KEY)
				assert.strictEqual((yield* stored(testDb))?.id, first?.id)

				// The organization shrinks to one member, and a sync sees it: rotating its key still works.
				world.members = [{ userId: "user_ops", spent: "0.50" }]
				yield* TestClock.setTime(NOW + 60 * 60_000)
				yield* MorphCostProvider.use((provider) =>
					provider.pull(
						{ orgId: ORG, connectionRef: first?.id ?? "" },
						{ startDay: "2026-11-01", endDay: "2026-11-21" },
					),
				)
				yield* set(KEY)

				world.members = [{ userId: "user_stranger", spent: "9.00" }]
				const other = yield* set(KEY).pipe(Effect.flip)
				assert.strictEqual(other._tag, VALIDATION)
				assert.include(other.message, "another Morph organization")
			}),
		)
	})
})
