import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { listSites } from "@maple/backend/services/integrations/google-search-console/client"
import { GoogleOAuthService } from "./GoogleOAuthService"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const readBody = (url: string, init?: RequestInit) =>
	new Request(url, {
		method: "POST",
		body: init?.body,
		// @ts-expect-error duplex is required for streaming bodies in undici/Bun
		duplex: "half",
	}).text()

const SCOPE =
	"openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/webmasters.readonly"

const idToken = (claims: Record<string, unknown>) =>
	`header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`

interface MockOptions {
	/** Bearer tokens the Search Console API rejects with 401. */
	readonly rejectedTokens?: ReadonlyArray<string>
	/** Answer every refresh grant with `invalid_grant`. */
	readonly refreshInvalidGrant?: boolean
	/** The scope string the code exchange reports as granted. */
	readonly grantedScope?: string
	/** Google account ids the code exchanges report, one per exchange; the last repeats. */
	readonly accountSubs?: ReadonlyArray<string>
}

interface MockGoogle {
	readonly fetch: typeof globalThis.fetch
	readonly tokenGrants: string[]
	readonly revoked: string[]
	readonly apiTokens: string[]
}

/** Google's token, revoke and Search Console endpoints, served from fixtures. */
const mockGoogle = (options: MockOptions = {}): MockGoogle => {
	const tokenGrants: string[] = []
	const revoked: string[] = []
	const apiTokens: string[] = []
	let exchanges = 0
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url === "https://oauth2.googleapis.com/token") {
			const body = new URLSearchParams(await readBody(url, init))
			if (body.get("client_id") !== "g-client-id" || body.get("client_secret") !== "g-client-secret") {
				return jsonResponse({ error: "invalid_client" }, 401)
			}
			tokenGrants.push(body.get("grant_type") ?? "")
			if (body.get("grant_type") === "refresh_token") {
				if (options.refreshInvalidGrant === true || body.get("refresh_token") !== "g-refresh") {
					return jsonResponse(
						{ error: "invalid_grant", error_description: "Token has been expired or revoked." },
						400,
					)
				}
				// Google keeps the refresh token on refresh: none comes back.
				return jsonResponse({ access_token: "g-access-refreshed", expires_in: 3599, scope: SCOPE })
			}
			const subs = options.accountSubs ?? ["google-user-1"]
			const sub = subs[Math.min(exchanges, subs.length - 1)]
			exchanges += 1
			return jsonResponse({
				access_token: "g-access",
				refresh_token: "g-refresh",
				expires_in: 3599,
				scope: options.grantedScope ?? SCOPE,
				id_token: idToken({ sub, email: "owner@acme.dev" }),
			})
		}
		if (url === "https://oauth2.googleapis.com/revoke") {
			revoked.push(new URLSearchParams(await readBody(url, init)).get("token") ?? "")
			return new Response(null, { status: 200 })
		}
		if (url === "https://www.googleapis.com/webmasters/v3/sites") {
			const token = Str.replace("Bearer ", "")(new Headers(init?.headers).get("authorization") ?? "")
			apiTokens.push(token)
			if (options.rejectedTokens?.includes(token)) {
				return jsonResponse({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401)
			}
			return jsonResponse({
				siteEntry: [{ siteUrl: "sc-domain:acme.dev", permissionLevel: "siteOwner" }],
			})
		}
		return jsonResponse({ message: "not found" }, 404)
	}
	return { fetch, tokenGrants, revoked, apiTokens }
}

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

const withOAuthApp = {
	GOOGLE_SEARCH_CONSOLE_CLIENT_ID: "g-client-id",
	GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET: "g-client-secret",
}

const makeLayer = (testDb: TestDb, google: MockGoogle, extra: Record<string, string> = withOAuthApp) =>
	Layer.mergeAll(GoogleOAuthService.layer, FetchHttpClient.layer).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfig, ...extra }))),
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, google.fetch)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const orgA = asOrgId("org_a")
const userA = asUserId("user_a")
const CALLBACK_URL = "https://api.example.com/api/integrations/google/callback"

const connect = Effect.gen(function* () {
	const service = yield* GoogleOAuthService
	const { state } = yield* service.startConnect(orgA, userA, { callbackUrl: CALLBACK_URL })
	return yield* service.completeConnect("auth-code", state, { orgId: orgA, userId: userA })
})

const listWithToken = Effect.gen(function* () {
	const service = yield* GoogleOAuthService
	const httpClient = yield* HttpClient.HttpClient
	return yield* service.withAccessToken(orgA, (accessToken) => listSites(httpClient, accessToken))
})

describe("GoogleOAuthService", () => {
	it.effect("fails with a configuration error when the OAuth client is not set", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* GoogleOAuthService
			const error = yield* service
				.startConnect(orgA, userA, { callbackUrl: CALLBACK_URL })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsConfigurationError")
			assert.include(error.message, "GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET")
		}).pipe(Effect.provide(makeLayer(testDb, mockGoogle(), { GOOGLE_SEARCH_CONSOLE_CLIENT_ID: "g-client-id" })))
	})

	it.effect("asks Google for offline Search Console access with a forced consent", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* GoogleOAuthService
			const { redirectUrl, state } = yield* service.startConnect(orgA, userA, {
				callbackUrl: CALLBACK_URL,
			})
			const url = new URL(redirectUrl)
			assert.strictEqual(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth")
			assert.strictEqual(url.searchParams.get("access_type"), "offline")
			assert.strictEqual(url.searchParams.get("prompt"), "consent")
			assert.deepStrictEqual(Str.split(" ")(url.searchParams.get("scope") ?? ""), [
				"openid",
				"email",
				"https://www.googleapis.com/auth/webmasters.readonly",
			])
			assert.strictEqual(url.searchParams.get("redirect_uri"), CALLBACK_URL)
			assert.strictEqual(url.searchParams.get("state"), state)
		}).pipe(Effect.provide(makeLayer(testDb, mockGoogle())))
	})

	it.effect("exchanges the code and stores the account with encrypted tokens", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const result = yield* connect
			assert.strictEqual(result.accountEmail, "owner@acme.dev")
			const connection = yield* (yield* GoogleOAuthService).getConnection(orgA)
			assert.strictEqual(connection?.accountEmail, "owner@acme.dev")
			assert.strictEqual(connection?.revoked, false)
			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					external_user_id: string
					access_token_ciphertext: string
					refresh_token_ciphertext: string
				}>(
					testDb,
					"SELECT external_user_id, access_token_ciphertext, refresh_token_ciphertext FROM oauth_connections WHERE org_id = $1 AND provider = 'google'",
					["org_a"],
				),
			)
			assert.strictEqual(row?.external_user_id, "google-user-1")
			assert.notStrictEqual(row?.access_token_ciphertext, "g-access")
			assert.notStrictEqual(row?.refresh_token_ciphertext, "g-refresh")
		}).pipe(Effect.provide(makeLayer(testDb, mockGoogle())))
	})

	describe("reconnecting", () => {
		const pickedSites = (testDb: TestDb) =>
			Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"SELECT count(*)::int AS count FROM search_console_sites WHERE org_id = $1",
					["org_a"],
				),
			).pipe(Effect.map((row) => row?.count))

		const connectAndPick = (testDb: TestDb) =>
			Effect.gen(function* () {
				yield* connect
				const connection = yield* (yield* GoogleOAuthService).getConnection(orgA)
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`INSERT INTO search_console_sites (id, org_id, oauth_connection_id, site_url, permission_level, created_at, updated_at)
						 VALUES ('scs_1', 'org_a', $1, 'sc-domain:acme.dev', 'siteOwner', now(), now())`,
						[connection?.id],
					),
				)
				assert.strictEqual(yield* pickedSites(testDb), 1)
			})

		it.effect("drops the picked properties when a different Google account connects", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* connectAndPick(testDb)
				yield* connect
				assert.strictEqual(yield* pickedSites(testDb), 0)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, mockGoogle({ accountSubs: ["google-user-1", "google-user-2"] })),
				),
			)
		})

		it.effect("keeps the picked properties when the same account reconnects", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* connectAndPick(testDb)
				yield* connect
				assert.strictEqual(yield* pickedSites(testDb), 1)
			}).pipe(Effect.provide(makeLayer(testDb, mockGoogle())))
		})
	})

	it.effect("refuses a grant where the user unticked Search Console", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const error = yield* connect.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.isNull(yield* (yield* GoogleOAuthService).getConnection(orgA))
		}).pipe(Effect.provide(makeLayer(testDb, mockGoogle({ grantedScope: "openid email" }))))
	})

	it.effect("refreshes an expired access token before calling Google", () => {
		const testDb = createTestDb(trackedDbs)
		const google = mockGoogle()
		return Effect.gen(function* () {
			yield* connect
			yield* TestClock.adjust("2 hours")
			const sites = yield* listWithToken
			assert.deepStrictEqual(sites, [{ siteUrl: "sc-domain:acme.dev", permissionLevel: "siteOwner" }])
			assert.deepStrictEqual(google.tokenGrants, ["authorization_code", "refresh_token"])
			assert.deepStrictEqual(google.apiTokens, ["g-access-refreshed"])
		}).pipe(Effect.provide(makeLayer(testDb, google)))
	})

	it.effect("refreshes once and retries when Google rejects a token", () => {
		const testDb = createTestDb(trackedDbs)
		const google = mockGoogle({ rejectedTokens: ["g-access"] })
		return Effect.gen(function* () {
			yield* connect
			yield* listWithToken
			assert.deepStrictEqual(google.apiTokens, ["g-access", "g-access-refreshed"])
		}).pipe(Effect.provide(makeLayer(testDb, google)))
	})

	it.effect("marks the connection revoked when the refresh answers invalid_grant", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* connect
			yield* TestClock.adjust("2 hours")
			const error = yield* listWithToken.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			const connection = yield* (yield* GoogleOAuthService).getConnection(orgA)
			assert.strictEqual(connection?.revoked, true)
		}).pipe(Effect.provide(makeLayer(testDb, mockGoogle({ refreshInvalidGrant: true }))))
	})

	it.effect("revokes the refresh token at Google and drops the connection on disconnect", () => {
		const testDb = createTestDb(trackedDbs)
		const google = mockGoogle()
		return Effect.gen(function* () {
			yield* connect
			const service = yield* GoogleOAuthService
			assert.deepStrictEqual(yield* service.disconnect(orgA), { disconnected: true })
			assert.deepStrictEqual(google.revoked, ["g-refresh"])
			assert.isNull(yield* service.getConnection(orgA))
		}).pipe(Effect.provide(makeLayer(testDb, google)))
	})
})
