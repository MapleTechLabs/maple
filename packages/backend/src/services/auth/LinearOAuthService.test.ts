import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { LinearOAuthService } from "./LinearOAuthService"

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

interface MockOptions {
	/** Bearer tokens the GraphQL API rejects as unauthenticated. */
	readonly rejectedTokens?: ReadonlyArray<string>
}

interface MockLinear {
	readonly fetch: typeof globalThis.fetch
	readonly revoked: string[]
	readonly graphqlTokens: string[]
}

/** Linear's token, revoke and GraphQL endpoints, served from fixtures. */
const mockLinear = (options: MockOptions = {}): MockLinear => {
	const revoked: string[] = []
	const graphqlTokens: string[] = []
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url === "https://api.linear.app/oauth/token") {
			const body = new URLSearchParams(await readBody(url, init))
			if (
				body.get("client_id") !== "lin-client-id" ||
				body.get("client_secret") !== "lin-client-secret"
			) {
				return jsonResponse({ error: "invalid_client" }, 400)
			}
			if (body.get("grant_type") === "refresh_token") {
				return jsonResponse({
					access_token: "lin-access-refreshed",
					refresh_token: "lin-refresh-rotated",
					expires_in: 86399,
					scope: "read,write",
				})
			}
			return jsonResponse({
				access_token: "lin-access",
				refresh_token: "lin-refresh",
				expires_in: 86399,
				scope: "read,write",
			})
		}
		if (url === "https://api.linear.app/oauth/revoke") {
			revoked.push(new URLSearchParams(await readBody(url, init)).get("token") ?? "")
			return new Response(null, { status: 200 })
		}
		if (url === "https://api.linear.app/graphql") {
			const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? ""
			graphqlTokens.push(token)
			if (options.rejectedTokens?.includes(token)) {
				return jsonResponse(
					{
						errors: [
							{
								message: "Authentication required, not authenticated",
								extensions: { code: "AUTHENTICATION_ERROR" },
							},
						],
					},
					400,
				)
			}
			const { operationName } = JSON.parse(await readBody(url, init))
			if (operationName === "MapleConnectedWorkspace") {
				return jsonResponse({ data: { organization: { id: "lin_org_1", name: "Acme" } } })
			}
			if (operationName === "MapleTeams") {
				return jsonResponse({
					data: {
						teams: {
							nodes: [
								{ id: "team_2", key: "OPS", name: "Operations" },
								{ id: "team_1", key: "ENG", name: "Engineering" },
							],
						},
					},
				})
			}
		}
		return jsonResponse({ message: "not found" }, 404)
	}
	return { fetch, revoked, graphqlTokens }
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
	LINEAR_OAUTH_CLIENT_ID: "lin-client-id",
	LINEAR_OAUTH_CLIENT_SECRET: "lin-client-secret",
}

const makeLayer = (testDb: TestDb, linear: MockLinear, extra: Record<string, string> = withOAuthApp) =>
	LinearOAuthService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfig, ...extra }))),
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, linear.fetch)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const orgA = asOrgId("org_a")
const userA = asUserId("user_a")
const CALLBACK_URL = "https://api.example.com/api/integrations/linear/callback"

const connect = Effect.gen(function* () {
	const service = yield* LinearOAuthService
	const { state } = yield* service.startConnect(orgA, userA, { callbackUrl: CALLBACK_URL })
	return yield* service.completeConnect("auth-code", state, { orgId: orgA, userId: userA })
})

describe("LinearOAuthService", () => {
	it.effect("refuses to start without the OAuth app's credentials", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* LinearOAuthService
			const error = yield* service
				.startConnect(orgA, userA, { callbackUrl: CALLBACK_URL })
				.pipe(Effect.flip)
			assert.include(error.message, "LINEAR_OAUTH_CLIENT_SECRET")
		}).pipe(Effect.provide(makeLayer(testDb, mockLinear(), { LINEAR_OAUTH_CLIENT_ID: "lin-client-id" })))
	})

	it.effect("asks Linear to install the app as its own actor", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* LinearOAuthService
			const { redirectUrl, state } = yield* service.startConnect(orgA, userA, {
				callbackUrl: CALLBACK_URL,
				returnTo: "/integrations",
			})
			const url = new URL(redirectUrl)
			assert.strictEqual(url.origin + url.pathname, "https://linear.app/oauth/authorize")
			assert.strictEqual(url.searchParams.get("actor"), "app")
			assert.strictEqual(url.searchParams.get("scope"), "read,write")
			assert.strictEqual(url.searchParams.get("redirect_uri"), CALLBACK_URL)
			assert.strictEqual(url.searchParams.get("state"), state)
		}).pipe(Effect.provide(makeLayer(testDb, mockLinear())))
	})

	it.effect("stores the workspace and encrypted tokens on connect", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const result = yield* connect
			assert.strictEqual(result.orgId, "org_a")

			const status = yield* (yield* LinearOAuthService).getStatus(orgA)
			assert.deepStrictEqual(status, {
				connected: true,
				workspaceName: "Acme",
				connectedByUserId: userA,
				revoked: false,
			})
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ external_user_id: string; access_token_ciphertext: string }>(
					testDb,
					"SELECT external_user_id, access_token_ciphertext FROM oauth_connections WHERE org_id = $1 AND provider = 'linear'",
					["org_a"],
				),
			)
			assert.strictEqual(row?.external_user_id, "lin_org_1")
			assert.notStrictEqual(row?.access_token_ciphertext, "lin-access")
		}).pipe(Effect.provide(makeLayer(testDb, mockLinear())))
	})

	it.effect("lists teams by name, refreshing a token Linear rejects", () => {
		const testDb = createTestDb(trackedDbs)
		const linear = mockLinear({ rejectedTokens: ["lin-access"] })
		return Effect.gen(function* () {
			// The connect-time lookup must succeed, so connect with a mock that accepts the first token.
			yield* connect.pipe(Effect.provide(makeLayer(testDb, mockLinear())))
			const teams = yield* (yield* LinearOAuthService).listTeams(orgA)
			assert.deepStrictEqual(
				teams.map((team) => team.key),
				["ENG", "OPS"],
			)
			assert.deepStrictEqual(linear.graphqlTokens, ["lin-access", "lin-access-refreshed"])
		}).pipe(Effect.provide(makeLayer(testDb, linear)))
	})

	it.effect("marks the connection revoked when a refreshed token is rejected too", () => {
		const testDb = createTestDb(trackedDbs)
		const linear = mockLinear({ rejectedTokens: ["lin-access", "lin-access-refreshed"] })
		return Effect.gen(function* () {
			yield* connect.pipe(Effect.provide(makeLayer(testDb, mockLinear())))
			const service = yield* LinearOAuthService
			const error = yield* service.listTeams(orgA).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			const status = yield* service.getStatus(orgA)
			assert.isTrue(status.connected && status.revoked)
		}).pipe(Effect.provide(makeLayer(testDb, linear)))
	})

	it.effect("revokes the token at Linear and drops the connection on disconnect", () => {
		const testDb = createTestDb(trackedDbs)
		const linear = mockLinear()
		return Effect.gen(function* () {
			yield* connect
			const service = yield* LinearOAuthService
			assert.deepStrictEqual(yield* service.disconnect(orgA), { disconnected: true })
			assert.deepStrictEqual(linear.revoked, ["lin-access"])
			assert.deepStrictEqual(yield* service.getStatus(orgA), { connected: false })
		}).pipe(Effect.provide(makeLayer(testDb, linear)))
	})
})
