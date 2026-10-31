import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { McpOAuthService } from "@maple/backend/services/auth/McpOAuthService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { TRIAGE_AGENT_NAME } from "@maple/domain/system-agents"
import { resolveMcpTenantContext } from "./resolve-tenant"

/**
 * The seam between the two Workers.
 *
 * `McpOAuthService` stayed on apps/api, which serves the OAuth endpoints and owns
 * the issuer. The code that accepts what it mints moved here. Nothing else pins
 * that a token issued on one side is honoured on the other, or — the half that
 * actually protects anything — that it is refused for a resource it was not
 * bound to. This test used to live inside `McpOAuthService.test.ts`, where both
 * halves were one process; it belongs on the side that would break.
 */
const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const config = (apiBaseUrl: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_API_BASE_URL: apiBaseUrl,
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb, apiBaseUrl = "https://api.example.com") => {
	const base = Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config(apiBaseUrl))))
	return Layer.mergeAll(
		McpOAuthService.layer.pipe(Layer.provide(base)),
		ApiKeysService.layer.pipe(Layer.provide(base)),
		AuthService.layer.pipe(Layer.provide(base)),
		ErrorActorsService.layer.pipe(Layer.provide(base)),
		base,
	)
}

const orgId = Schema.decodeUnknownSync(OrgId)("org_mcp")
const userId = Schema.decodeUnknownSync(UserId)("user_mcp")
const memberRole = Schema.decodeUnknownSync(RoleName)("org:member")
const resource = "https://api.example.com/mcp"
const redirectUri = "http://127.0.0.1:49152/callback"
const verifier = "maple-mcp-oauth-verifier-that-is-long-enough-1234567890"
const challenge = createHash("sha256").update(verifier).digest("base64url")

/** Register → authorize → approve → exchange, the shortest path to a live grant. */
const issueGrant = Effect.fnUntraced(function* (oauth: McpOAuthService["Service"]) {
	const client = yield* oauth.register(
		{ clientName: "seam-test", redirectUris: [redirectUri] },
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
	return yield* oauth.exchangeAuthorizationCode(
		{
			code: new URL(approved.redirectUri).searchParams.get("code")!,
			clientId: client.client_id,
			redirectUri,
			codeVerifier: verifier,
			resource,
		},
		"127.0.0.1",
	)
})

describe("an MCP OAuth token, resolved by the AI worker", () => {
	it.effect("carries the org and roles the grant was approved with", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const tokens = yield* issueGrant(yield* McpOAuthService)
			const tenant = yield* resolveMcpTenantContext(
				new Request(resource, {
					headers: { authorization: `Bearer ${tokens.access_token}` },
				}),
			)
			expect(tenant.orgId).toBe(orgId)
			expect(tenant.roles).toEqual([memberRole])
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("is refused for a resource it was not bound to", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const tokens = yield* issueGrant(yield* McpOAuthService)
			// RFC 8707 audience binding. Without this check a token minted for one
			// deployment's `/mcp` would authenticate against another's.
			const failure = yield* resolveMcpTenantContext(
				new Request("https://other.example.com/mcp", {
					headers: { authorization: `Bearer ${tokens.access_token}` },
				}),
			).pipe(Effect.flip)
			expect(failure._tag).toBe("@maple/mcp/errors/McpAuthInvalidError")
			if (failure._tag === "@maple/mcp/errors/McpAuthInvalidError") {
				expect(failure.reason).toBe("invalid_target")
			}
		}).pipe(Effect.provide(makeLayer(db, "https://other.example.com")))
	})

	it.effect("is checked against the configured origin, not the forwarded host", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const tokens = yield* issueGrant(yield* McpOAuthService)
			const failure = yield* resolveMcpTenantContext(
				new Request(resource, {
					headers: {
						authorization: `Bearer ${tokens.access_token}`,
						"x-forwarded-host": "api.example.com",
					},
				}),
			).pipe(Effect.flip)
			expect(failure._tag).toBe("@maple/mcp/errors/McpAuthInvalidError")
		}).pipe(Effect.provide(makeLayer(db, "https://other.example.com")))
	})
})

describe("an agent named in x-maple-agent-id", () => {
	const otherUser = Schema.decodeUnknownSync(UserId)("user_other")
	const otherOrg = Schema.decodeUnknownSync(OrgId)("org_other")

	it.effect("is acted as only when it is the key user's own agent in the key's org", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const key = yield* (yield* ApiKeysService).create(orgId, userId, { name: "agent", kind: "mcp" })
			const actors = yield* ErrorActorsService
			const resolveAs = (agentId: string) =>
				resolveMcpTenantContext(
					new Request(resource, {
						headers: { authorization: `Bearer ${key.secret}`, "x-maple-agent-id": agentId },
					}),
				).pipe(Effect.map((tenant) => tenant.actorId))

			const own = yield* actors.registerAgent(orgId, userId, { name: "ci-bot" })
			expect(yield* resolveAs(own.id)).toBe(own.id)

			const teammate = yield* actors.registerAgent(orgId, otherUser, { name: "their-bot" })
			const elsewhere = yield* actors.registerAgent(otherOrg, userId, { name: "ci-bot" })
			const person = yield* actors.ensureUserActor(orgId, otherUser)
			const reserved = yield* actors.ensureAgentActor(orgId, TRIAGE_AGENT_NAME, { createdBy: userId })
			const ignored = yield* Effect.forEach(
				[teammate.id, elsewhere.id, person.id, reserved.id, "not-an-actor"],
				resolveAs,
			)
			expect(ignored).toEqual([undefined, undefined, undefined, undefined, undefined])
		}).pipe(Effect.provide(makeLayer(db)))
	})
})
