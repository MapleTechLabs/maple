import { afterEach, assert, describe, it } from "@effect/vitest"
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import { ConfigProvider, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { AutumnClient, type AutumnResult } from "@maple/backend/services/billing/autumn-http"
import { OrgOpenRouterKeyService } from "./OrgOpenRouterKeyService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_byok")
const USER = Schema.decodeUnknownSync(UserId)("user_byok")
const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef"

interface World {
	/** Autumn's answer to the customer read: the add-on held, not held, or an outage. */
	autumn: "entitled" | "not_entitled" | "down"
	/** OpenRouter's status for `GET /key`. */
	openRouterStatus: number
	/** OpenRouter's status for the EU instance's one-token chat completion. */
	euChatStatus: number
	/** OpenRouter's body for that completion. */
	euChatBody: string
	openRouterCalls: Array<string | null>
	openRouterUrls: Array<string>
	/** `MAPLE_REGION` for the service's Env. */
	region: "us" | "eu"
}

const makeWorld = (overrides: Partial<World> = {}): World => ({
	autumn: "entitled",
	openRouterStatus: 200,
	euChatStatus: 200,
	euChatBody: "{}",
	openRouterCalls: [],
	openRouterUrls: [],
	region: "us",
	...overrides,
})

const die = () => Effect.die(new Error("not used by this test"))

const customer = (world: World): AutumnResult =>
	world.autumn === "down"
		? { statusCode: 503, response: { message: "autumn down" } }
		: {
				statusCode: 200,
				response: {
					id: ORG,
					flags:
						world.autumn === "entitled"
							? { openrouter_byok: { featureId: "openrouter_byok" } }
							: {},
				},
			}

const autumnStub = (world: World) =>
	Layer.succeed(AutumnClient, {
		getOrCreateCustomer: () => Effect.sync(() => customer(world)),
		aggregateEvents: die,
		attach: die,
		previewAttach: die,
		openCustomerPortal: die,
		listPlans: die,
		applyReward: die,
		updateCustomerBillingControls: die,
		updateCustomerName: die,
	})

const fetchStub = (world: World): typeof fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		world.openRouterUrls.push(url)
		world.openRouterCalls.push(new Headers(init?.headers).get("authorization"))
		return url.endsWith("/chat/completions")
			? new Response(world.euChatBody, { status: world.euChatStatus })
			: new Response("{}", { status: world.openRouterStatus })
	}) as typeof fetch

const config = (region: World["region"]) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
			MAPLE_REGION: region,
		}),
	)

const run = <A, E>(testDb: TestDb, world: World, effect: Effect.Effect<A, E, OrgOpenRouterKeyService>) =>
	effect.pipe(
		Effect.provide(
			Layer.effect(OrgOpenRouterKeyService, OrgOpenRouterKeyService.make).pipe(
				Layer.provide(
					Layer.mergeAll(
						autumnStub(world),
						EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive)),
						FetchHttpClient.layer,
						BillingCustomerResolver.standalone,
					),
				),
				Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub(world))),
				Layer.provide(testDb.layer),
				Layer.provide(Env.layer),
				Layer.provide(config(world.region)),
			),
		),
	)

describe("OrgOpenRouterKeyService", () => {
	it.effect("checks the key with OpenRouter, stores it encrypted, and hands it to runs", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				const saved = yield* keys.set(ORG, USER, `  ${KEY}  `)
				assert.isTrue(saved.entitled)
				assert.isTrue(saved.configured)
				assert.strictEqual(saved.keyHint, "cdef")
				assert.deepStrictEqual(world.openRouterCalls, [`Bearer ${KEY}`])
				assert.deepStrictEqual(world.openRouterUrls, ["https://openrouter.ai/api/v1/key"])

				const row = yield* Effect.promise(() =>
					queryFirstRow<{ key_ciphertext: string }>(
						testDb,
						"SELECT key_ciphertext FROM org_openrouter_keys WHERE org_id = 'org_byok'",
					),
				)
				assert.isFalse(row?.key_ciphertext.includes(KEY) ?? true)

				const resolved = yield* keys.resolveForRun(ORG)
				assert.strictEqual(Option.map(resolved, Redacted.value).pipe(Option.getOrNull), KEY)
			}),
		)
	})

	it.effect("checks the key and its plan against the in-region host on the EU instance", () => {
		const world = makeWorld({ region: "eu" })
		return run(
			createTestDb(trackedDbs),
			world,
			Effect.gen(function* () {
				yield* (yield* OrgOpenRouterKeyService).set(ORG, USER, KEY)
				assert.deepStrictEqual(world.openRouterUrls, [
					"https://eu.openrouter.ai/api/v1/key",
					"https://eu.openrouter.ai/api/v1/chat/completions",
				])
			}),
		)
	})

	it.effect("refuses an EU key whose plan cannot use the in-region host", () =>
		run(
			createTestDb(trackedDbs),
			makeWorld({ region: "eu", euChatStatus: 403 }),
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				const error = yield* Effect.flip(keys.set(ORG, USER, KEY))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyValidationError")
				assert.include(error.message, "Business or Enterprise")
				assert.isFalse((yield* keys.get(ORG)).configured)
			}),
		),
	)

	it.effect("refuses a key that is not an OpenRouter key without calling OpenRouter", () => {
		const world = makeWorld()
		return run(
			createTestDb(trackedDbs),
			world,
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				const exit = yield* Effect.exit(keys.set(ORG, USER, "sk-ant-not-openrouter-key"))
				assert.isTrue(Exit.isFailure(exit))
				assert.deepStrictEqual(world.openRouterCalls, [])
			}),
		)
	})

	it.effect("refuses a key over 256 characters without calling OpenRouter", () => {
		const world = makeWorld()
		return run(
			createTestDb(trackedDbs),
			world,
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				const error = yield* Effect.flip(keys.set(ORG, USER, `sk-or-v1-${"a".repeat(260)}`))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyValidationError")
				assert.deepStrictEqual(world.openRouterCalls, [])
			}),
		)
	})

	it.effect("refuses an EU key with no credits left", () =>
		run(
			createTestDb(trackedDbs),
			makeWorld({ region: "eu", euChatStatus: 402 }),
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				const error = yield* Effect.flip(keys.set(ORG, USER, KEY))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyValidationError")
				assert.include(error.message, "no credits")
				assert.isFalse((yield* keys.get(ORG)).configured)
			}),
		),
	)

	it.effect("refuses an EU key whose account settings leave the EU model no endpoint", () => {
		const reason =
			"No endpoints found for openai/gpt-6-luna. Drop Out-of-Region Endpoints After BYOK removed azure/eu."
		return run(
			createTestDb(trackedDbs),
			makeWorld({
				region: "eu",
				euChatStatus: 404,
				euChatBody: JSON.stringify({ error: { code: 404, message: reason } }),
			}),
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				const error = yield* Effect.flip(keys.set(ORG, USER, KEY))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyValidationError")
				assert.include(error.message, reason)
				assert.isFalse((yield* keys.get(ORG)).configured)
			}),
		)
	})

	it.effect("asks for a retry, without saving, when the EU check fails on OpenRouter's side", () =>
		run(
			createTestDb(trackedDbs),
			makeWorld({ region: "eu", euChatStatus: 500 }),
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				const error = yield* Effect.flip(keys.set(ORG, USER, KEY))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyPersistenceError")
				assert.isFalse((yield* keys.get(ORG)).configured)
			}),
		),
	)

	it.effect("refuses to save without the add-on", () =>
		run(
			createTestDb(trackedDbs),
			makeWorld({ autumn: "not_entitled" }),
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				const error = yield* Effect.flip(keys.set(ORG, USER, KEY))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyAddOnRequiredError")
			}),
		),
	)

	it.effect("refuses a key OpenRouter rejects", () =>
		run(
			createTestDb(trackedDbs),
			makeWorld({ openRouterStatus: 401 }),
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				const error = yield* Effect.flip(keys.set(ORG, USER, KEY))
				assert.strictEqual(error._tag, "@maple/http/openrouter-key/OpenRouterKeyValidationError")
				assert.isFalse((yield* keys.get(ORG)).configured)
			}),
		),
	)

	it.effect("stops using a saved key once the add-on lapses, but not when billing is down", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* run(
				testDb,
				makeWorld(),
				OrgOpenRouterKeyService.use((keys) => keys.set(ORG, USER, KEY)),
			)
			const lapsed = yield* run(
				testDb,
				makeWorld({ autumn: "not_entitled" }),
				OrgOpenRouterKeyService.use((keys) => keys.resolveForRun(ORG)),
			)
			assert.isTrue(Option.isNone(lapsed))
			const outage = yield* run(
				testDb,
				makeWorld({ autumn: "down" }),
				OrgOpenRouterKeyService.use((keys) => keys.resolveForRun(ORG)),
			)
			assert.isTrue(Option.isSome(outage))
		})
	})

	it.effect("falls back to Maple's key when the stored key no longer decrypts", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			makeWorld(),
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				yield* keys.set(ORG, USER, KEY)
				yield* Effect.promise(() =>
					queryFirstRow(
						testDb,
						"UPDATE org_openrouter_keys SET key_tag = 'AAAAAAAAAAAAAAAAAAAAAA==' WHERE org_id = 'org_byok' RETURNING org_id",
					),
				)
				assert.isTrue(Option.isNone(yield* keys.resolveForRun(ORG)))
			}),
		)
	})

	it.effect("removes the key", () =>
		run(
			createTestDb(trackedDbs),
			makeWorld(),
			Effect.gen(function* () {
				const keys = yield* OrgOpenRouterKeyService
				yield* keys.set(ORG, USER, KEY)
				const removed = yield* keys.remove(ORG)
				assert.isFalse(removed.configured)
				assert.isTrue(Option.isNone(yield* keys.resolveForRun(ORG)))
			}),
		),
	)
})
