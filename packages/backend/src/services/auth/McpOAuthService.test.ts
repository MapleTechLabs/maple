import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema, Tracer, DateTime, Array as Arr } from "effect"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "./AuthService"
import { matchesMcpOAuthRedirectUri, McpOAuthService, validateMcpOAuthRedirectUri } from "./McpOAuthService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const config = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb) => {
	const base = Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config())))
	const apiKeys = ApiKeysService.layer.pipe(Layer.provide(base))
	const auth = AuthService.layer.pipe(Layer.provide(base))
	return Layer.mergeAll(McpOAuthService.layer.pipe(Layer.provide(base)), apiKeys, auth, base)
}

const orgId = Schema.decodeSync(OrgId)("org_mcp")
const userId = Schema.decodeSync(UserId)("user_mcp")
const memberRole = Schema.decodeSync(RoleName)("org:member")
const resource = "https://api.example.com/mcp"
const redirectUri = "http://127.0.0.1:49152/callback"
const verifier = "maple-mcp-oauth-verifier-that-is-long-enough-1234567890"
const challenge = createHash("sha256").update(verifier).digest("base64url")

/** Register → authorize → approve → exchange, the shortest path to a live grant. */
const issueGrant = Effect.fnUntraced(function* (oauth: McpOAuthService, clientName: string) {
	const client = yield* oauth.register({ clientName, redirectUris: [redirectUri] }, "127.0.0.1")
	const started = yield* oauth.startAuthorization(
		{
			clientId: client.client_id,
			redirectUri,
			responseType: "code",
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
			resource,
			expectedResource: resource,
		},
		"127.0.0.1",
	)
	const requestId = new URL(started.consentUrl).searchParams.get("request_id")!
	const approved = yield* oauth.approve(requestId, {
		orgId,
		userId,
		roles: [memberRole],
		userEmail: null,
	})
	const tokens = yield* oauth.exchangeAuthorizationCode(
		{
			code: new URL(approved.redirectUri).searchParams.get("code")!,
			clientId: client.client_id,
			redirectUri,
			codeVerifier: verifier,
			resource,
		},
		"127.0.0.1",
	)
	return { clientId: client.client_id, tokens }
})

/** The unkeyed digest an attacker with only database write access can compute. */
const plainSha256 = (value: string) => createHash("sha256").update(value).digest("hex")

describe("McpOAuthService", () => {
	it("accepts HTTPS and loopback redirects while rejecting unsafe redirects", () => {
		expect(validateMcpOAuthRedirectUri("https://client.example.com/callback")).toBe(true)
		expect(validateMcpOAuthRedirectUri("http://localhost:9876/callback")).toBe(true)
		expect(validateMcpOAuthRedirectUri("http://127.0.0.1:9876/callback")).toBe(true)
		expect(validateMcpOAuthRedirectUri("http://client.example.com/callback")).toBe(false)
		expect(validateMcpOAuthRedirectUri("https://client.example.com/callback#fragment")).toBe(false)
	})

	it("matches loopback redirects with any port while preserving every other component", () => {
		expect(
			matchesMcpOAuthRedirectUri(
				"https://client.example.com/callback",
				"https://client.example.com/callback",
			),
		).toBe(true)
		expect(
			matchesMcpOAuthRedirectUri(
				"http://localhost:49152/callback/server-id?source=codex",
				"http://localhost:51789/callback/server-id?source=codex",
			),
		).toBe(true)
		expect(
			matchesMcpOAuthRedirectUri("http://127.0.0.1:49152/callback", "http://127.0.0.1:51789/callback"),
		).toBe(true)
		expect(matchesMcpOAuthRedirectUri("http://[::1]:49152/callback", "http://[::1]:51789/callback")).toBe(
			true,
		)

		expect(
			matchesMcpOAuthRedirectUri("http://localhost:49152/callback", "http://127.0.0.1:51789/callback"),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"http://localhost:49152/callback/server-id",
				"http://localhost:51789/callback/other-id",
			),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"http://localhost:49152/callback?source=codex",
				"http://localhost:51789/callback?source=claude",
			),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri("http://localhost:49152/callback", "https://localhost:51789/callback"),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"https://client.example.com:49152/callback",
				"https://client.example.com:51789/callback",
			),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"https://client.example.com/callback#fragment",
				"https://client.example.com/callback#fragment",
			),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"http://user@localhost:49152/callback",
				"http://user@localhost:49152/callback",
			),
		).toBe(false)
	})

	it.effect("issues a role-pinned, audience-bound token through authorization code + PKCE", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService
			const authorizationRedirectUri = "http://127.0.0.1:51789/callback"
			const client = yield* oauth.register(
				{ clientName: "Test MCP Client", redirectUris: [redirectUri] },
				"127.0.0.1",
			)
			const started = yield* oauth.startAuthorization(
				{
					clientId: client.client_id,
					redirectUri: authorizationRedirectUri,
					responseType: "code",
					state: "client-state",
					codeChallenge: challenge,
					codeChallengeMethod: "S256",
					resource,
					scope: "mcp:tools",
					expectedResource: resource,
				},
				"127.0.0.1",
			)
			const requestId = new URL(started.consentUrl).searchParams.get("request_id")
			expect(requestId).toBeTruthy()
			const inspected = yield* oauth.inspect(requestId!)
			expect(inspected.clientName).toBe("Test MCP Client")
			expect(inspected.status).toBe("pending")

			const approved = yield* oauth.approve(requestId!, {
				orgId,
				userId,
				roles: [memberRole],
				userEmail: "member@example.com",
			})
			const callback = new URL(approved.redirectUri)
			expect(callback.origin + callback.pathname).toBe(authorizationRedirectUri)
			expect(callback.searchParams.get("state")).toBe("client-state")
			const code = callback.searchParams.get("code")!
			const wrongRedirect = yield* oauth
				.exchangeAuthorizationCode(
					{ code, clientId: client.client_id, redirectUri, codeVerifier: verifier, resource },
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			expect(wrongRedirect._tag).toBe("@maple/backend/errors/McpOAuthProtocolError")
			if (wrongRedirect._tag === "@maple/backend/errors/McpOAuthProtocolError") {
				expect(wrongRedirect.error).toBe("invalid_grant")
			}
			const tokens = yield* oauth.exchangeAuthorizationCode(
				{
					code,
					clientId: client.client_id,
					redirectUri: authorizationRedirectUri,
					codeVerifier: verifier,
					resource,
				},
				"127.0.0.1",
			)
			expect(tokens.token_type).toBe("Bearer")
			expect(tokens.scope).toBe("mcp:tools")
			expect(tokens.expires_in).toBe(3600)

			const resolved = yield* apiKeys.resolveByKey(tokens.access_token)
			expect(Option.isSome(resolved)).toBe(true)
			if (Option.isSome(resolved)) {
				expect(resolved.value.kind).toBe("mcp")
				expect(resolved.value.roles).toEqual([memberRole])
				expect(resolved.value.scopes).toEqual(["mcp:tools"])
				expect(resolved.value.mcpOAuthResource).toBe(resource)
			}
			// The other half of this flow (that MCP accepts this token and rejects it
			// for a different resource) now runs in apps/ai, where the code that
			// resolves it lives: `mcp/lib/resolve-tenant.oauth.test.ts`.
			const reused = yield* oauth
				.exchangeAuthorizationCode(
					{
						code,
						clientId: client.client_id,
						redirectUri: authorizationRedirectUri,
						codeVerifier: verifier,
						resource,
					},
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			expect(reused._tag).toBe("@maple/backend/errors/McpOAuthProtocolError")
			if (reused._tag === "@maple/backend/errors/McpOAuthProtocolError") {
				expect(reused.error).toBe("invalid_grant")
			}
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("rotates refresh tokens and revokes the family when an old token is replayed", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService
			const client = yield* oauth.register(
				{ clientName: "Refresh Test", redirectUris: [redirectUri] },
				"127.0.0.1",
			)
			const started = yield* oauth.startAuthorization(
				{
					clientId: client.client_id,
					redirectUri,
					responseType: "code",
					codeChallenge: challenge,
					codeChallengeMethod: "S256",
					resource,
					expectedResource: resource,
				},
				"127.0.0.1",
			)
			const requestId = new URL(started.consentUrl).searchParams.get("request_id")!
			const approved = yield* oauth.approve(requestId, {
				orgId,
				userId,
				roles: [memberRole],
				userEmail: null,
			})
			const first = yield* oauth.exchangeAuthorizationCode(
				{
					code: new URL(approved.redirectUri).searchParams.get("code")!,
					clientId: client.client_id,
					redirectUri,
					codeVerifier: verifier,
					resource,
				},
				"127.0.0.1",
			)
			const second = yield* oauth.refresh(
				{ refreshToken: first.refresh_token, clientId: client.client_id, resource },
				"127.0.0.1",
			)
			expect(Option.isNone(yield* apiKeys.resolveByKey(first.access_token))).toBe(true)
			expect(Option.isSome(yield* apiKeys.resolveByKey(second.access_token))).toBe(true)

			const replay = yield* oauth
				.refresh(
					{ refreshToken: first.refresh_token, clientId: client.client_id, resource },
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			if (replay._tag === "@maple/backend/errors/McpOAuthProtocolError") {
				expect(replay.error).toBe("invalid_grant")
			}
			expect(Option.isNone(yield* apiKeys.resolveByKey(second.access_token))).toBe(true)
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("refuses a refresh token planted in the database without the lookup key", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const { clientId, tokens } = yield* issueGrant(oauth, "Planted Refresh")
			const rotated = yield* oauth.refresh(
				{ refreshToken: tokens.refresh_token, clientId, resource },
				"127.0.0.1",
			)
			expect(rotated.token_type).toBe("Bearer")

			const planted = "attacker-chosen-refresh-token"
			yield* Effect.promise(() =>
				executeSql(
					db,
					"UPDATE mcp_oauth_refresh_tokens SET token_hash = $1 WHERE revoked_at IS NULL AND replaced_by_id IS NULL",
					[plainSha256(planted)],
				),
			)
			const refused = yield* oauth
				.refresh({ refreshToken: planted, clientId, resource }, "127.0.0.1")
				.pipe(Effect.flip)
			expect(refused._tag).toBe("@maple/backend/errors/McpOAuthProtocolError")
			if (refused._tag === "@maple/backend/errors/McpOAuthProtocolError") {
				expect(refused.error).toBe("invalid_grant")
			}
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect(
		"refuses an authorization code or request id planted in the database without the lookup key",
		() => {
			const db = createTestDb(createdDbs)
			return Effect.gen(function* () {
				const oauth = yield* McpOAuthService
				const client = yield* oauth.register(
					{ clientName: "Planted Code", redirectUris: [redirectUri] },
					"127.0.0.1",
				)
				const authorize = oauth.startAuthorization(
					{
						clientId: client.client_id,
						redirectUri,
						responseType: "code",
						codeChallenge: challenge,
						codeChallengeMethod: "S256",
						resource,
						expectedResource: resource,
					},
					"127.0.0.1",
				)
				const approvedRequest = new URL((yield* authorize).consentUrl).searchParams.get("request_id")!
				yield* oauth.approve(approvedRequest, { orgId, userId, roles: [memberRole], userEmail: null })

				const plantedCode = "attacker-chosen-authorization-code"
				yield* Effect.promise(() =>
					executeSql(
						db,
						"UPDATE mcp_oauth_authorizations SET authorization_code_hash = $1 WHERE authorization_code_hash IS NOT NULL",
						[plainSha256(plantedCode)],
					),
				)
				const refused = yield* oauth
					.exchangeAuthorizationCode(
						{
							code: plantedCode,
							clientId: client.client_id,
							redirectUri,
							codeVerifier: verifier,
							resource,
						},
						"127.0.0.1",
					)
					.pipe(Effect.flip)
				expect(refused._tag).toBe("@maple/backend/errors/McpOAuthProtocolError")
				if (refused._tag === "@maple/backend/errors/McpOAuthProtocolError") {
					expect(refused.error).toBe("invalid_grant")
				}

				const pendingRequest = new URL((yield* authorize).consentUrl).searchParams.get("request_id")!
				expect((yield* oauth.inspect(pendingRequest)).status).toBe("pending")
				// A well-formed id, so the lookup runs: only the stored hash differs from the keyed one.
				yield* Effect.promise(() =>
					executeSql(
						db,
						"UPDATE mcp_oauth_authorizations SET request_id_hash = $1 WHERE approved_at IS NULL",
						[plainSha256(pendingRequest)],
					),
				)
				const approval = yield* oauth
					.approve(pendingRequest, { orgId, userId, roles: [memberRole], userEmail: null })
					.pipe(Effect.flip)
				expect(approval._tag).toBe("@maple/http/errors/McpOAuthAuthorizationNotFoundError")
			}).pipe(Effect.provide(makeLayer(db)))
		},
	)

	it.effect("stops refreshing once the visible MCP key is revoked in the API-keys UI", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService
			const grant = yield* issueGrant(oauth, "Revoked Key Client")

			// Revoking the key a member can actually see used to be a no-op: the
			// next rotation minted a fresh one straight back.
			const resolved = yield* apiKeys.resolveByKey(grant.tokens.access_token)
			expect(Option.isSome(resolved)).toBe(true)
			if (Option.isNone(resolved)) return
			yield* apiKeys.revoke(orgId, resolved.value.keyId)

			const failure = yield* oauth
				.refresh(
					{ refreshToken: grant.tokens.refresh_token, clientId: grant.clientId, resource },
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			expect(failure._tag).toBe("@maple/backend/errors/McpOAuthProtocolError")
			if (failure._tag === "@maple/backend/errors/McpOAuthProtocolError") {
				expect(failure.error).toBe("invalid_grant")
			}

			const live = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					db,
					"select count(*)::int as count from mcp_oauth_refresh_tokens where revoked_at is null",
				),
			)
			expect(Number(live?.count)).toBe(0)
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("leaves the refresh span Ok when the client presents a revoked grant", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const grant = yield* issueGrant(oauth, "Revoked Grant Client")
			const request = { refreshToken: grant.tokens.refresh_token, clientId: grant.clientId, resource }
			yield* oauth.refresh(request, "127.0.0.1")

			const spans: Array<Tracer.NativeSpan> = []
			const tracer = Tracer.make({
				span(options) {
					const span = new Tracer.NativeSpan(options)
					spans.push(span)
					return span
				},
			})
			// The token was rotated above, so replaying it is `invalid_grant`.
			const failure = yield* oauth
				.refresh(request, "127.0.0.1")
				.pipe(Effect.flip, Effect.withTracer(tracer))
			expect(failure._tag).toBe("@maple/backend/errors/McpOAuthProtocolError")

			const span = Option.getOrUndefined(
				Arr.findFirst(spans, (candidate) => candidate.name === "McpOAuthService.refresh"),
			)
			expect(span?.status._tag).toBe("Ended")
			if (span?.status._tag !== "Ended") return
			expect(Exit.isSuccess(span.status.exit)).toBe(true)
			expect(span.attributes.get("error.type")).toBe("@maple/backend/errors/McpOAuthProtocolError")
			expect(span.attributes.get("maple.oauth.error")).toBe("invalid_grant")
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("ends the grant at the absolute family lifetime no matter how often it rotates", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const grant = yield* issueGrant(oauth, "Long Lived Client")

			// The family anchor is 90 days out and is *carried* across rotations,
			// unlike expires_at which each refresh resets to a fresh 30 days.
			// `it.effect` runs on the test clock, so "past" is relative to epoch 0,
			// not to wall time.
			yield* Effect.promise(() =>
				db.pglite.query(
					"update mcp_oauth_refresh_tokens set family_expires_at = timestamptz '1969-12-31 00:00:00+00'",
				),
			)

			const failure = yield* oauth
				.refresh(
					{ refreshToken: grant.tokens.refresh_token, clientId: grant.clientId, resource },
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			expect(failure._tag).toBe("@maple/backend/errors/McpOAuthProtocolError")
			if (failure._tag === "@maple/backend/errors/McpOAuthProtocolError") {
				expect(failure.error).toBe("invalid_grant")
			}
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("keeps the approved client name on the access key a refresh mints", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService
			const grant = yield* issueGrant(oauth, "Named Editor")
			const rotated = yield* oauth.refresh(
				{ refreshToken: grant.tokens.refresh_token, clientId: grant.clientId, resource },
				"127.0.0.1",
			)
			const live = yield* Effect.promise(() =>
				db.pglite.query<{ name: string }>("select name from api_keys where revoked = false"),
			)
			expect(Arr.map(live.rows, (row) => row.name)).toEqual(["Named Editor"])
			expect(Option.isSome(yield* apiKeys.resolveByKey(rotated.access_token))).toBe(true)
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("carries the family expiry across a rotation instead of resetting it", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const grant = yield* issueGrant(oauth, "Rotating Client")
			const before = yield* Effect.promise(() =>
				db.pglite.query<{ family_expires_at: Date }>(
					"select family_expires_at from mcp_oauth_refresh_tokens",
				),
			)
			yield* oauth.refresh(
				{ refreshToken: grant.tokens.refresh_token, clientId: grant.clientId, resource },
				"127.0.0.1",
			)
			const after = yield* Effect.promise(() =>
				db.pglite.query<{ family_expires_at: Date }>(
					"select family_expires_at from mcp_oauth_refresh_tokens order by created_at desc limit 1",
				),
			)
			expect(DateTime.toEpochMillis(DateTime.makeUnsafe(after.rows[0].family_expires_at))).toBe(
				DateTime.toEpochMillis(DateTime.makeUnsafe(before.rows[0].family_expires_at)),
			)
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("returns an OAuth denial to the exact registered redirect and prevents later approval", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const client = yield* oauth.register(
				{ clientName: "Denied Client", redirectUris: [redirectUri] },
				"127.0.0.1",
			)
			const started = yield* oauth.startAuthorization(
				{
					clientId: client.client_id,
					redirectUri,
					responseType: "code",
					state: "denial-state",
					codeChallenge: challenge,
					codeChallengeMethod: "S256",
					resource,
					expectedResource: resource,
				},
				"127.0.0.1",
			)
			const requestId = new URL(started.consentUrl).searchParams.get("request_id")!
			const denied = yield* oauth.deny(requestId)
			const callback = new URL(denied.redirectUri)
			expect(callback.origin + callback.pathname).toBe(redirectUri)
			expect(callback.searchParams.get("error")).toBe("access_denied")
			expect(callback.searchParams.get("state")).toBe("denial-state")
			expect((yield* oauth.inspect(requestId)).status).toBe("denied")
			const conflict = yield* oauth
				.approve(requestId, { orgId, userId, roles: [memberRole], userEmail: null })
				.pipe(Effect.flip)
			expect(conflict._tag).toBe("@maple/http/errors/McpOAuthAuthorizationConflictError")
		}).pipe(Effect.provide(makeLayer(db)))
	})
})
