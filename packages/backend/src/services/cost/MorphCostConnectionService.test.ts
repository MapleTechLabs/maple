import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { MorphCostConnectionService } from "./MorphCostConnectionService"
import { type FakeMorph, fakeMorphDeps, makeFakeMorph } from "./providers/morph/fake-morph"

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
	effect: Effect.Effect<A, E, MorphCostConnectionService>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.effect(MorphCostConnectionService, MorphCostConnectionService.make).pipe(
				Layer.provide(fakeMorphDeps(testDb, world)),
			),
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
		const world = makeFakeMorph()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(`  ${KEY}  `)
				assert.deepStrictEqual(saved, { accountId: "organization", accountLabel: "Organization" })
				assert.deepStrictEqual(world.urls, ["/api/v1/account/usage"])
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

	it.effect("takes a personal key, as the personal account it reads", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ account: "personal" })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(KEY)
				assert.deepStrictEqual(saved, { accountId: "personal", accountLabel: "Personal account" })
				assert.strictEqual((yield* stored(testDb))?.account_id, "personal")
			}),
		)
	})

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

				// An answer Maple did not expect is no verdict on the key.
				world.status = 400
				const down = yield* set(KEY).pipe(Effect.flip)
				assert.strictEqual(down._tag, PERSISTENCE)
				assert.isUndefined(yield* stored(testDb))
			}),
		)
	})

	it.effect("replaces the key of the same account, and refuses a key of the other kind", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(KEY)
				const first = yield* stored(testDb)
				yield* set(OTHER_KEY)
				const replaced = yield* stored(testDb)
				assert.strictEqual(replaced?.id, first?.id)
				assert.notStrictEqual(replaced?.secret_ciphertext, first?.secret_ciphertext)

				world.account = "personal"
				const personal = yield* set(KEY).pipe(Effect.flip)
				assert.strictEqual(personal._tag, VALIDATION)
				assert.include(personal.message, "This is a personal key")
				assert.strictEqual((yield* stored(testDb))?.account_id, "organization")
			}),
		)
	})

	it.effect("refuses a replacement that reads another account of the same kind", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeMorph({ days: { "2026-11-10": [{ model: "morph-v3-fast", spend: 4.2 }] } })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(KEY)
				const first = yield* stored(testDb)

				// Another organization: same kind, different spend on the closed days.
				world.byKey = {
					[OTHER_KEY]: { days: { "2026-11-10": [{ model: "morph-v3-fast", spend: 1 }] } },
				}
				const other = yield* set(OTHER_KEY).pipe(Effect.flip)
				assert.strictEqual(other._tag, VALIDATION)
				assert.include(other.message, "another Morph account")
				assert.strictEqual((yield* stored(testDb))?.secret_ciphertext, first?.secret_ciphertext)
				assert.include(world.urls, "/api/v1/account/usage?start=2026-10-22&end=2026-11-20")

				// The saved key was revoked in a rotation: nothing to compare, the new key is taken.
				world.byKey = {
					[KEY]: { status: 401 },
					[OTHER_KEY]: { days: { "2026-11-10": [{ model: "morph-v3-fast", spend: 1 }] } },
				}
				yield* set(OTHER_KEY)
				assert.notStrictEqual((yield* stored(testDb))?.secret_ciphertext, first?.secret_ciphertext)
			}),
		)
	})
})
