import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OAuthAuthStates } from "@maple/db/tables"
import { OrgId, UserId } from "@maple/domain/http"
import { Database, DatabaseError, type DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	makeOAuthConnectionHelpers,
	OAuthTokenResponseSchema,
	type OAuthTokenEndpointConfig,
} from "./connection-helpers"
import type { OAuthStateInitiator } from "./state-initiator"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const ORG = asOrgId("org_oauth_helpers")
const USER = asUserId("user_oauth_helpers")
const INITIATOR = { orgId: ORG, userId: USER }

const baseConfig = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
}

const configLive = ConfigProvider.layer(ConfigProvider.fromUnknown(baseConfig))

const TOKEN_URL = "https://provider.example.com/oauth/token"

const tokenConfig: OAuthTokenEndpointConfig = {
	tokenUrl: TOKEN_URL,
	clientId: "test-client-id",
	clientSecret: Redacted.make("test-client-secret"),
}

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Serve the token endpoint from a per-test handler; everything else 404s. */
const makeFetch =
	(handler: (body: URLSearchParams) => Response): typeof globalThis.fetch =>
	async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url.startsWith(TOKEN_URL)) {
			const text = await new Response(init?.body ?? "").text()
			return handler(new URLSearchParams(text))
		}
		return jsonResponse({ error: "not_found" }, 404)
	}

const fetchLayer = (handler: (body: URLSearchParams) => Response) =>
	Layer.succeed(FetchHttpClient.Fetch, makeFetch(handler))

/**
 * Build the helpers directly (they are a factory, not a service) against the
 * test PGlite database, optionally through a wrapped `execute`.
 */
const makeHelpers = (wrapDatabase: (database: DatabaseApi) => DatabaseApi = (database) => database) =>
	Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		return yield* makeOAuthConnectionHelpers({
			provider: "test-provider",
			providerLabel: "TestProvider",
			database: wrapDatabase(database),
			env,
		})
	})

const provideBase = (testDb: TestDb, fetch: ReturnType<typeof fetchLayer>) =>
	Layer.mergeAll(
		testDb.layer,
		Env.layer.pipe(Layer.provide(configLive)),
		FetchHttpClient.layer.pipe(Layer.provide(fetch)),
	)

/** Seed an expired connection with a refresh token, so any token read must refresh. */
const seedExpiredConnection = (helpers: Effect.Success<ReturnType<typeof makeHelpers>>) =>
	Effect.gen(function* () {
		const accessEnc = yield* helpers.encryptValue("stale-access-token")
		const refreshEnc = yield* helpers.encryptValue("stored-refresh-token")
		// Written in the past so any later write moves `updatedAt`.
		yield* helpers.upsertConnection(ORG, Date.now() - 10_000, {
			externalUserId: "ext-user-1",
			connectedByUserId: USER,
			accessTokenCiphertext: accessEnc.ciphertext,
			accessTokenIv: accessEnc.iv,
			accessTokenTag: accessEnc.tag,
			refreshTokenCiphertext: refreshEnc.ciphertext,
			refreshTokenIv: refreshEnc.iv,
			refreshTokenTag: refreshEnc.tag,
			// Already expired — getValidConnectionToken must refresh.
			expiresAt: Date.now() - 60_000,
		})
	})

const revokedAtOf = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ revoked_at: string | null }>(
			testDb,
			"SELECT revoked_at FROM oauth_connections WHERE org_id = $1",
			[ORG],
		),
	).pipe(Effect.map((row) => row?.revoked_at ?? null))

describe("refreshAccessToken classification", () => {
	it.live("a 400 invalid_grant is a revocation and stamps the connection revoked", () => {
		const testDb = createTestDb(trackedDbs)
		const fetch = fetchLayer(() => jsonResponse({ error: "invalid_grant" }, 400))
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const error = yield* helpers.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			assert.isNotNull(yield* revokedAtOf(testDb))
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})

	it.live("a 400 invalid_client is an upstream failure and does NOT revoke the connection", () => {
		const testDb = createTestDb(trackedDbs)
		// A rotated/misconfigured Maple client secret answers this for EVERY
		// tenant at once — stamping revoked here would disconnect them all.
		const fetch = fetchLayer(() => jsonResponse({ error: "invalid_client" }, 400))
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const error = yield* helpers.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.isNull(yield* revokedAtOf(testDb))
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})

	it.live("a bodyless 401 is an upstream failure and does NOT revoke the connection", () => {
		const testDb = createTestDb(trackedDbs)
		const fetch = fetchLayer(() => new Response("Unauthorized", { status: 401 }))
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const error = yield* helpers.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.isNull(yield* revokedAtOf(testDb))
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})
})

describe("getValidConnectionToken", () => {
	it.live("concurrent reads of an expired token refresh once (single-flight, no false revoke)", () => {
		const testDb = createTestDb(trackedDbs)
		const counters = { refreshes: 0 }
		// The refresh token rotates on use: a second refresh with it would 400.
		const fetch = fetchLayer(() => {
			counters.refreshes += 1
			return counters.refreshes > 1
				? jsonResponse({ error: "invalid_grant" }, 400)
				: jsonResponse({
						access_token: "fresh-access-token",
						refresh_token: "rotated",
						expires_in: 3600,
					})
		})
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const [a, b] = yield* Effect.all(
				[
					helpers.getValidConnectionToken(tokenConfig, ORG),
					helpers.getValidConnectionToken(tokenConfig, ORG),
				],
				{ concurrency: 2 },
			)
			assert.strictEqual(a.accessToken, "fresh-access-token")
			assert.strictEqual(b.accessToken, "fresh-access-token")
			assert.strictEqual(counters.refreshes, 1)
			assert.isNull(yield* revokedAtOf(testDb))
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})
})

describe("requireStateRow", () => {
	it.live("rejects a state that was never issued", () => {
		const testDb = createTestDb(trackedDbs)
		const fetch = fetchLayer(() => jsonResponse({ error: "unexpected" }, 500))
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			const error = yield* helpers
				.requireStateRow("state-that-was-never-issued", INITIATOR)
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})
})

describe("persistRefreshedTokens", () => {
	it.live("retries a transient persistence failure instead of losing the rotated tokens", () => {
		const testDb = createTestDb(trackedDbs)
		const fetch = fetchLayer(() =>
			jsonResponse({
				access_token: "fresh-access-token",
				refresh_token: "fresh-refresh-token",
				expires_in: 3600,
			}),
		)
		let failuresLeft = 2
		const flaky = (database: DatabaseApi): DatabaseApi => ({
			// Suspended so each retry re-evaluates the failure budget.
			execute: (fn) =>
				Effect.suspend(() => {
					if (failuresLeft > 0) {
						failuresLeft -= 1
						return Effect.fail(new DatabaseError({ message: "connection reset", cause: "boom" }))
					}
					return database.execute(fn)
				}),
		})
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const row = yield* helpers.requireConnection(ORG)

			// From here every execute goes through the flaky wrapper: the refresh
			// succeeded upstream (the old refresh token is now dead), so the write
			// must survive a transient blip.
			const flakyHelpers = yield* makeHelpers(flaky)
			const refreshed = yield* flakyHelpers.refreshAccessToken(tokenConfig, "stored-refresh-token")
			const accessToken = yield* flakyHelpers.persistRefreshedTokens(row, refreshed)

			assert.strictEqual(accessToken, "fresh-access-token")
			assert.strictEqual(failuresLeft, 0)
			const persisted = yield* helpers.getValidConnectionToken(tokenConfig, ORG)
			assert.strictEqual(persisted.accessToken, "fresh-access-token")
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})
})

const freshTokens = () =>
	jsonResponse({
		access_token: "fresh-access-token",
		refresh_token: "fresh-refresh-token",
		expires_in: 3600,
	})

describe("cross-isolate refresh race", () => {
	it.live("a refresh that persists after a racing isolate stamped revoked clears the stamp", () => {
		const testDb = createTestDb(trackedDbs)
		// Isolate B presents the already-rotated refresh token and is told it is dead.
		const fetch = fetchLayer(() => jsonResponse({ error: "invalid_grant" }, 400))
		return Effect.gen(function* () {
			const isolateA = yield* makeHelpers()
			const isolateB = yield* makeHelpers()
			yield* seedExpiredConnection(isolateA)
			const rowReadByA = yield* isolateA.requireConnection(ORG)

			const lost = yield* isolateB.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.flip)
			assert.strictEqual(lost._tag, "@maple/http/errors/IntegrationsRevokedError")
			assert.isNotNull(yield* revokedAtOf(testDb))

			// A's refresh succeeded upstream and lands afterwards: the grant is alive.
			const refreshed = yield* Schema.decodeUnknownEffect(OAuthTokenResponseSchema)({
				access_token: "fresh-access-token",
				refresh_token: "fresh-refresh-token",
				expires_in: 3600,
			})
			yield* isolateA.persistRefreshedTokens(rowReadByA, refreshed)
			assert.isNull(yield* revokedAtOf(testDb))
			const token = yield* isolateA.getValidConnectionToken(tokenConfig, ORG, { failIfRevoked: true })
			assert.strictEqual(token.accessToken, "fresh-access-token")
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})

	it.live("a racing isolate's revoke stamp does not land on a row refreshed after its re-read", () => {
		const testDb = createTestDb(trackedDbs)
		let refreshPosts = 0
		const fetch = fetchLayer(() => {
			refreshPosts += 1
			return jsonResponse({ error: "invalid_grant" }, 400)
		})
		return Effect.gen(function* () {
			const isolateA = yield* makeHelpers()
			yield* seedExpiredConnection(isolateA)
			const rowReadByA = yield* isolateA.requireConnection(ORG)
			const refreshed = yield* Schema.decodeUnknownEffect(OAuthTokenResponseSchema)({
				access_token: "fresh-access-token",
				refresh_token: "fresh-refresh-token",
				expires_in: 3600,
			})
			// B's statements after its failed POST are the re-read, then the stamp; A persists between.
			let afterPost = 0
			const interleaved = (database: DatabaseApi): DatabaseApi => ({
				execute: (fn) =>
					Effect.suspend(() => {
						if (refreshPosts === 0) return database.execute(fn)
						afterPost += 1
						return afterPost === 2
							? isolateA
									.persistRefreshedTokens(rowReadByA, refreshed)
									.pipe(Effect.orDie, Effect.andThen(database.execute(fn)))
							: database.execute(fn)
					}),
			})
			const isolateB = yield* makeHelpers(interleaved)

			const lost = yield* isolateB.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.flip)
			assert.strictEqual(lost._tag, "@maple/http/errors/IntegrationsRevokedError")
			assert.strictEqual(afterPost, 2)
			assert.isNull(yield* revokedAtOf(testDb))
			const token = yield* isolateA.getValidConnectionToken(tokenConfig, ORG, { failIfRevoked: true })
			assert.strictEqual(token.accessToken, "fresh-access-token")
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})
})

describe("refresh interruption", () => {
	it.live("an interrupt during the refresh POST still persists the rotated tokens", () => {
		const testDb = createTestDb(trackedDbs)
		let refreshPosts = 0
		let signalStarted: () => void = () => undefined
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve
		})
		const fetch = Layer.succeed(FetchHttpClient.Fetch, async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
			if (!url.startsWith(TOKEN_URL)) return jsonResponse({ error: "not_found" }, 404)
			refreshPosts += 1
			signalStarted()
			await new Promise((resolve) => setTimeout(resolve, 50))
			return freshTokens()
		})
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const fiber = yield* helpers.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.forkChild)
			yield* Effect.promise(() => started)
			yield* Fiber.interrupt(fiber)

			const token = yield* helpers.getValidConnectionToken(tokenConfig, ORG)
			assert.strictEqual(token.accessToken, "fresh-access-token")
			// Served from the persisted rotation: the dead refresh token is never presented again.
			assert.strictEqual(refreshPosts, 1)
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})
})

describe("refresh timeout", () => {
	it.effect("a stalled token endpoint times out as upstream and releases the refresh permit", () => {
		const testDb = createTestDb(trackedDbs)
		const counters = { posts: 0 }
		let signalStarted: () => void = () => undefined
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve
		})
		// First POST never answers (until aborted); the next one succeeds.
		const fetch = Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
			if (!url.startsWith(TOKEN_URL)) return jsonResponse({ error: "not_found" }, 404)
			counters.posts += 1
			if (counters.posts > 1) return freshTokens()
			signalStarted()
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
			})
		})
		return Effect.gen(function* () {
			// Row timestamps are wall-clock, so align the test clock with them.
			yield* TestClock.setTime(Date.now())
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const fiber = yield* helpers.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.forkChild)
			yield* Effect.promise(() => started)
			yield* TestClock.adjust("21 seconds")
			const error = yield* Fiber.join(fiber).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.isNull(yield* revokedAtOf(testDb))

			const token = yield* helpers.getValidConnectionToken(tokenConfig, ORG)
			assert.strictEqual(token.accessToken, "fresh-access-token")
			assert.strictEqual(counters.posts, 2)
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})
})

describe("requireStateRow provider scoping", () => {
	it.live("refuses a state issued for another provider's connect flow", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* helpers.dbExecute((db) =>
				db.run(
					PG.insertInto(OAuthAuthStates).values({
						state: "state-of-another-provider",
						orgId: ORG,
						provider: "another-provider",
						initiatedByUserId: USER,
						redirectUri: "https://api.example.com/callback",
						returnTo: null,
						codeVerifier: null,
						createdAt: Date.now(),
						expiresAt: Date.now() + 60_000,
					}),
				),
			)
			const error = yield* helpers
				.requireStateRow("state-of-another-provider", INITIATOR)
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
		}).pipe(
			Effect.provide(
				provideBase(
					testDb,
					fetchLayer(() => freshTokens()),
				),
			),
		)
	})
})

describe("requireStateRow initiator binding", () => {
	const insertState = (helpers: Effect.Success<ReturnType<typeof makeHelpers>>, state: string) =>
		helpers.dbExecute((db) =>
			db.run(
				PG.insertInto(OAuthAuthStates).values({
					state,
					orgId: ORG,
					provider: "test-provider",
					initiatedByUserId: USER,
					redirectUri: "https://api.example.com/callback",
					returnTo: null,
					codeVerifier: null,
					createdAt: Date.now(),
					expiresAt: Date.now() + 60_000,
				}),
			),
		)

	const finishers: ReadonlyArray<readonly [string, OAuthStateInitiator]> = [
		["another user in the same org", { orgId: ORG, userId: asUserId("user_somebody_else") }],
		["the same user in another org", { orgId: asOrgId("org_somebody_else"), userId: USER }],
	]
	// `@effect/vitest`'s `each` is `it.for`: the whole row is the first argument.
	it.live.each(finishers)(
		"refuses a forwarded authorization finished by %s, and burns the state",
		([, finisher]) => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				// A real initiator that differs in exactly one field, so the refusal is the comparison's.
				assert.isTrue(finisher.orgId === ORG || finisher.userId === USER)
				assert.isFalse(finisher.orgId === ORG && finisher.userId === USER)
				const helpers = yield* makeHelpers()
				yield* insertState(helpers, "forwarded-state")
				const error = yield* helpers.requireStateRow("forwarded-state", finisher).pipe(Effect.flip)
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
				assert.include(error.message, "different Maple user or organization")
				// The initiator cannot redeem it afterwards either: the forwarded state is spent.
				const replay = yield* helpers.requireStateRow("forwarded-state", INITIATOR).pipe(Effect.flip)
				assert.include(replay.message, "not recognized")
			}).pipe(
				Effect.provide(
					provideBase(
						testDb,
						fetchLayer(() => freshTokens()),
					),
				),
			)
		},
	)

	it.live("returns the row to the user and org that started the flow", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* insertState(helpers, "own-state")
			const row = yield* helpers.requireStateRow("own-state", INITIATOR)
			assert.strictEqual(row.orgId, ORG)
			assert.strictEqual(row.initiatedByUserId, USER)
		}).pipe(
			Effect.provide(
				provideBase(
					testDb,
					fetchLayer(() => freshTokens()),
				),
			),
		)
	})
})
