import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { listOrganizations } from "@maple/backend/services/integrations/supabase/api"
import {
	FAKE_CLIENT_ID,
	FAKE_CLIENT_SECRET,
	FAKE_ORG,
	makeFakeSupabase,
} from "@maple/backend/services/integrations/supabase/__fixtures__/fake-supabase-api"
import { SupabaseOAuthService } from "./SupabaseOAuthService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const baseConfig = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
}

const withOAuthApp = {
	SUPABASE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
	SUPABASE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
}

const makeLayer = (
	testDb: TestDb,
	fake: ReturnType<typeof makeFakeSupabase>,
	extra: Record<string, string> = withOAuthApp,
) =>
	Layer.mergeAll(
		SupabaseOAuthService.layer.pipe(
			Layer.provide(testDb.layer),
			Layer.provide(Env.layer),
			Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfig, ...extra }))),
		),
		FetchHttpClient.layer,
		Layer.succeed(FetchHttpClient.Fetch, fake.fetch),
	)

/** A Supabase call made through the service's token handling, as discovery makes it. */
const listWithGrant = Effect.gen(function* () {
	const service = yield* SupabaseOAuthService
	const httpClient = yield* HttpClient.HttpClient
	return yield* service.withAccessToken(ORG, (token) =>
		listOrganizations(httpClient, service.apiBaseUrl, token),
	)
})

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const ORG = asOrgId("org_a")
const CALLBACK_URL = "https://api.example.com/api/integrations/supabase/callback"

/** Start the flow and hand the fake the PKCE challenge the authorize URL carried, as Supabase would. */
const connect = (fake: ReturnType<typeof makeFakeSupabase>) =>
	Effect.gen(function* () {
		const service = yield* SupabaseOAuthService
		const { redirectUrl, state } = yield* service.startConnect(ORG, asUserId("user_a"), {
			callbackUrl: CALLBACK_URL,
			returnTo: "/integrations/supabase",
		})
		fake.state.codeChallenge = new URL(redirectUrl).searchParams.get("code_challenge")
		return yield* service.completeConnect("4a0c7b4e-code", state, {
			orgId: ORG,
			userId: asUserId("user_a"),
		})
	})

describe("SupabaseOAuthService", () => {
	it.effect("startConnect fails as not configured without the OAuth app credentials", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase()
		return Effect.gen(function* () {
			const service = yield* SupabaseOAuthService
			assert.isFalse(service.isConfigured)
			const error = yield* service
				.startConnect(ORG, asUserId("user_a"), { callbackUrl: CALLBACK_URL })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsConfigurationError")
		}).pipe(Effect.provide(makeLayer(testDb, fake, {})))
	})

	it.effect("startConnect builds a PKCE S256 authorize URL and stores the verifier with the state", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase()
		return Effect.gen(function* () {
			const service = yield* SupabaseOAuthService
			const { redirectUrl, state } = yield* service.startConnect(ORG, asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			const url = new URL(redirectUrl)
			assert.strictEqual(`${url.origin}${url.pathname}`, "https://api.supabase.com/v1/oauth/authorize")
			assert.strictEqual(url.searchParams.get("client_id"), FAKE_CLIENT_ID)
			assert.strictEqual(url.searchParams.get("redirect_uri"), CALLBACK_URL)
			assert.strictEqual(url.searchParams.get("response_type"), "code")
			assert.strictEqual(url.searchParams.get("state"), state)
			assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256")
			assert.match(url.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ provider: string; code_verifier: string | null }>(
					testDb,
					"SELECT provider, code_verifier FROM oauth_auth_states WHERE state = $1",
					[state],
				),
			)
			assert.strictEqual(row?.provider, "supabase")
			assert.isNotNull(row?.code_verifier ?? null)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect(
		"completeConnect exchanges the code with Basic auth and the verifier, and stores encrypted tokens",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFakeSupabase()
			return Effect.gen(function* () {
				const result = yield* connect(fake)
				assert.strictEqual(result.orgId, "org_a")
				assert.strictEqual(result.connectedByUserId, "user_a")
				assert.strictEqual(result.returnTo, "/integrations/supabase")
				assert.deepStrictEqual(result.organization, {
					id: "jylmnjimcybytpydxgbu",
					slug: "jylmnjimcybytpydxgbu",
					name: "Acme",
				})

				const exchange = fake.state.calls.find((call) => call.path === "/v1/oauth/token")
				const params = new URLSearchParams(exchange?.body ?? "")
				// The secret travels only in the Basic header, never in the form body.
				assert.isNull(params.get("client_secret"))
				assert.strictEqual(params.get("redirect_uri"), CALLBACK_URL)

				const row = yield* Effect.promise(() =>
					queryFirstRow<{
						external_user_id: string
						external_account_name: string | null
						access_token_ciphertext: string
						refresh_token_ciphertext: string | null
						expires_at: Date | null
					}>(
						testDb,
						"SELECT external_user_id, external_account_name, access_token_ciphertext, refresh_token_ciphertext, expires_at FROM oauth_connections WHERE org_id = $1 AND provider = 'supabase'",
						["org_a"],
					),
				)
				assert.strictEqual(row?.external_user_id, "jylmnjimcybytpydxgbu")
				assert.strictEqual(row?.external_account_name, "Acme")
				assert.notStrictEqual(row?.access_token_ciphertext, "sbp_oauth_access_1")
				assert.isNotNull(row?.refresh_token_ciphertext ?? null)
				assert.strictEqual(row?.expires_at?.getTime(), 86_400_000)
			}).pipe(Effect.provide(makeLayer(testDb, fake)))
		},
	)

	it.effect("completeConnect refuses a grant without a refresh token", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ omitRefreshToken: true })
		return Effect.gen(function* () {
			const error = yield* connect(fake).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.isFalse(yield* (yield* SupabaseOAuthService).isGrantUsable(ORG))
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("completeConnect refuses and revokes a grant that reaches no organization", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ organizations: [] })
		return Effect.gen(function* () {
			const error = yield* connect(fake).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.isTrue(fake.state.calls.some((call) => call.path === "/v1/oauth/revoke"))
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("completeConnect refuses and revokes a grant listing an organization it cannot read", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ organizations: [FAKE_ORG, { id: "org_b", name: "Beta" }] })
		return Effect.gen(function* () {
			const error = yield* connect(fake).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.isTrue(fake.state.calls.some((call) => call.path === "/v1/oauth/revoke"))
			assert.isFalse(yield* (yield* SupabaseOAuthService).isGrantUsable(ORG))
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("completeConnect revokes a grant whose fresh access token Supabase rejects", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ rejectIssuedTokens: true })
		return Effect.gen(function* () {
			const error = yield* connect(fake).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			const revoke = fake.state.calls.find((call) => call.path === "/v1/oauth/revoke")
			assert.include(revoke?.body ?? "", "refresh_1")
			assert.isFalse(yield* (yield* SupabaseOAuthService).isGrantUsable(ORG))
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("withAccessToken refreshes an expired access token before calling Supabase", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase()
		return Effect.gen(function* () {
			yield* connect(fake)
			yield* TestClock.adjust("25 hours")
			const organizations = yield* listWithGrant
			assert.strictEqual(organizations.length, 1)
			const refreshes = fake.state.calls.filter(
				(call) => call.path === "/v1/oauth/token" && call.body.includes("grant_type=refresh_token"),
			)
			assert.strictEqual(refreshes.length, 1)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("withAccessToken refreshes once and retries when Supabase rejects an unexpired token", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase()
		return Effect.gen(function* () {
			yield* connect(fake)
			fake.state.validAccessTokens.clear()
			const organizations = yield* listWithGrant
			assert.strictEqual(organizations.length, 1)
			assert.isTrue(yield* (yield* SupabaseOAuthService).isGrantUsable(ORG))
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("a grant revoked upstream is stamped revoked and later calls fail fast", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase()
		return Effect.gen(function* () {
			yield* connect(fake)
			fake.state.validAccessTokens.clear()
			fake.state.refreshRevoked = true
			const error = yield* listWithGrant.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			assert.isFalse(yield* (yield* SupabaseOAuthService).isGrantUsable(ORG))

			const callsBefore = fake.state.calls.length
			const again = yield* listWithGrant.pipe(Effect.flip)
			assert.strictEqual(again._tag, "@maple/http/errors/IntegrationsRevokedError")
			assert.strictEqual(fake.state.calls.length, callsBefore)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("disconnect revokes the grant at Supabase with the refresh token and drops it", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase()
		return Effect.gen(function* () {
			yield* connect(fake)
			const service = yield* SupabaseOAuthService
			assert.deepStrictEqual(yield* service.disconnect(ORG), { disconnected: true })
			const revoke = fake.state.calls.find((call) => call.path === "/v1/oauth/revoke")
			assert.deepStrictEqual(
				Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(revoke?.body ?? "{}"),
				{
					client_id: FAKE_CLIENT_ID,
					client_secret: FAKE_CLIENT_SECRET,
					refresh_token: "refresh_1",
				},
			)
			assert.isFalse(yield* service.isGrantUsable(ORG))
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})
})
