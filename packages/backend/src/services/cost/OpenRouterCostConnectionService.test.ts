import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { OpenRouterCostConnectionService } from "./OpenRouterCostConnectionService"
import {
	type FakeOpenRouter,
	fakeOpenRouterDeps,
	makeFakeOpenRouter,
} from "./providers/openrouter/fake-openrouter"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const USER = Schema.decodeSync(UserId)("user_cost")
const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef"
const OTHER_KEY = "sk-or-v1-fedcba9876543210fedcba9876543210"

const run = <A, E>(
	testDb: TestDb,
	world: FakeOpenRouter,
	effect: Effect.Effect<A, E, OpenRouterCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.effect(OpenRouterCostConnectionService, OpenRouterCostConnectionService.make).pipe(
				Layer.provide(fakeOpenRouterDeps(testDb, world)),
			),
		),
	)

const set = (key: string) => OpenRouterCostConnectionService.use((service) => service.set(ORG, USER, key))
const remove = OpenRouterCostConnectionService.use((service) => service.remove(ORG))

interface Stored {
	readonly id: string
	readonly key_ciphertext: string
	readonly key_label: string
	readonly account_id: string
}

const storedKey = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Stored>(
			testDb,
			"SELECT id, key_ciphertext, key_label, account_id FROM openrouter_cost_connections WHERE org_id = 'org_cost'",
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
			"SELECT id, connection_ref, account_id, enabled FROM cost_sources WHERE org_id = 'org_cost' AND provider = 'openrouter'",
		),
	)

describe("OpenRouterCostConnectionService", () => {
	it.effect("checks a management key with OpenRouter, seals it and makes the cost source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(`  ${KEY}  `)
				assert.strictEqual(saved.keyLabel, "sk-or-v1-abc...123")
				// Identity first, then proof that the key reads activity, then that it reads the whole
				// account, all on the global host.
				assert.deepStrictEqual(world.urls, [
					"https://openrouter.ai/api/v1/key",
					"https://openrouter.ai/api/v1/activity",
					"https://openrouter.ai/api/v1/activity?workspace_id=00000000-0000-4000-8000-000000000000",
				])
				assert.deepStrictEqual(world.authorizations, Arr.replicate(`Bearer ${KEY}`, 3))

				const stored = yield* storedKey(testDb)
				assert.isFalse(Str.includes(KEY)(stored?.key_ciphertext ?? KEY))
				const made = yield* source(testDb)
				// The source is named after the key's account, which a later key keeps.
				assert.deepStrictEqual(
					[made?.connection_ref, made?.account_id, made?.enabled],
					[stored?.id, "user_account_a", true],
				)
			}),
		)
	})

	it.effect("refuses a regular API key before asking for activity, and stores nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter({ isManagementKey: false })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const error = yield* Effect.flip(set(KEY))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyValidationError")
				assert.include(error.message, "management key")
				assert.deepStrictEqual(world.urls, ["https://openrouter.ai/api/v1/key"])
				assert.isUndefined(yield* storedKey(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("refuses a key OpenRouter does not know, and one it lets read no activity", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter({ keyStatus: 401 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const unknown = yield* Effect.flip(set(KEY))
				assert.strictEqual(unknown.message, "OpenRouter rejected this key.")

				world.keyStatus = 200
				world.activityStatus = 403
				const scoped = yield* Effect.flip(set(KEY))
				assert.strictEqual(scoped._tag, "@maple/http/openrouter-key/OpenRouterKeyValidationError")
				assert.include(scoped.message, "did not let this key read the account's activity")
				assert.isUndefined(yield* storedKey(testDb))
			}),
		)
	})

	it.effect("refuses a management key that reads one workspace only, and stores nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter({ workspaceScoped: true })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const error = yield* Effect.flip(set(KEY))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyValidationError")
				assert.include(error.message, "reads one workspace only")
				assert.isUndefined(yield* storedKey(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("reports an OpenRouter outage as a retryable failure, not as a bad key", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter({ activityStatus: 503 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const error = yield* Effect.flip(set(KEY))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyPersistenceError")
				assert.isUndefined(yield* storedKey(testDb))
			}),
		)
	})

	it.effect(
		"never sends text that is not an OpenRouter key, nor any key of an org outside the rollout",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeOpenRouter()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const malformed = yield* Effect.flip(set("AKIAIOSFODNN7EXAMPLE-not-openrouter"))
					assert.strictEqual(
						malformed._tag,
						"@maple/http/openrouter-key/OpenRouterKeyValidationError",
					)

					world.cloudCost = false
					const outside = yield* Effect.flip(set(KEY))
					assert.strictEqual(outside._tag, "@maple/http/errors/CloudCostDisabledError")
					assert.deepStrictEqual(world.urls, [])
				}),
			)
		},
	)

	it.effect("keeps the connection and its source when the account's key is replaced", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(KEY)
				const first = yield* storedKey(testDb)
				const firstSource = yield* source(testDb)

				world.keyLabel = "sk-or-v1-new...456"
				const replaced = yield* set(OTHER_KEY)
				assert.strictEqual(replaced.keyLabel, "sk-or-v1-new...456")
				const second = yield* storedKey(testDb)
				assert.strictEqual(second?.id, first?.id)
				assert.strictEqual(second?.key_label, "sk-or-v1-new...456")
				assert.notStrictEqual(second?.key_ciphertext, first?.key_ciphertext)
				assert.deepStrictEqual(yield* source(testDb), firstSource)
			}),
		)
	})

	it.effect(
		"refuses a key of another OpenRouter account while a source exists, and keeps the saved key",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeOpenRouter()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* set(KEY)
					const first = yield* storedKey(testDb)

					// The other account's spend would overwrite the days the source already holds.
					world.creatorUserId = "user_account_b"
					const refused = yield* Effect.flip(set(OTHER_KEY))
					assert.strictEqual(
						refused._tag,
						"@maple/http/openrouter-key/OpenRouterKeyValidationError",
					)
					assert.include(refused.message, "another OpenRouter account")
					assert.deepStrictEqual(yield* storedKey(testDb), first)

					// An organization's account is its organization, whoever made the key.
					world.organizationId = "org_openrouter_x"
					assert.include((yield* Effect.flip(set(OTHER_KEY))).message, "another OpenRouter account")
				}),
			)
		},
	)

	it.effect("makes a source held for its old key's failure due again once the key is replaced", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter()
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
				yield* set(KEY)
				yield* Effect.promise(() =>
					testDb.pglite.query(
						// A pull on the old key is in flight: it holds the source's lease.
						`UPDATE cost_sources SET last_error = 'OpenRouter rejected the saved key.',
						        last_error_reason = 'auth', next_attempt_at = now() + interval '6 hours',
						        consecutive_failures = 3, lease_until = now() + interval '20 minutes'`,
					),
				)
				assert.strictEqual((yield* held)?.held, true)
				yield* set(OTHER_KEY)
				// The lease goes too: the old pull's failure, arriving later, finds the claim gone and writes nothing.
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

	it.effect("removes the key and its source together, without needing the rollout", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeOpenRouter()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(KEY)
				world.cloudCost = false
				yield* remove
				assert.isUndefined(yield* storedKey(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})
})
