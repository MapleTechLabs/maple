import { afterEach, describe, expect, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { McpConnectionId, OrgId, RoleName, UserId } from "@maple/domain/http"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { McpConnectionsService } from "./McpConnectionsService"
import { McpOAuthService } from "./McpOAuthService"

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
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb) => {
	const base = Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config())))
	return Layer.mergeAll(
		McpConnectionsService.layer.pipe(Layer.provide(base)),
		McpOAuthService.layer.pipe(Layer.provide(base)),
		ApiKeysService.layer.pipe(Layer.provide(base)),
	)
}

const orgId = Schema.decodeUnknownSync(OrgId)("org_connections")
const otherOrgId = Schema.decodeUnknownSync(OrgId)("org_elsewhere")
const alice = Schema.decodeUnknownSync(UserId)("user_alice")
const bob = Schema.decodeUnknownSync(UserId)("user_bob")
const memberRole = Schema.decodeUnknownSync(RoleName)("org:member")
const resource = "https://api.example.com/mcp"
const redirectUri = "http://127.0.0.1:49152/callback"
const verifier = "maple-mcp-oauth-verifier-that-is-long-enough-1234567890"
const challenge = createHash("sha256").update(verifier).digest("base64url")

const connect = Effect.fnUntraced(function* (clientName: string, user: UserId, org: OrgId) {
	const oauth = yield* McpOAuthService
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
	const requestId = new URL(started.consentUrl).searchParams.get("request_id") ?? ""
	const approved = yield* oauth.approve(requestId, {
		orgId: org,
		userId: user,
		roles: [memberRole],
		userEmail: `${user}@acme.dev`,
	})
	const tokens = yield* oauth.exchangeAuthorizationCode(
		{
			code: new URL(approved.redirectUri).searchParams.get("code") ?? "",
			clientId: client.client_id,
			redirectUri,
			codeVerifier: verifier,
			resource,
		},
		"127.0.0.1",
	)
	return { clientId: client.client_id, tokens }
})

const admin = { userId: alice, seesAll: true }

describe("McpConnectionsService", () => {
	it.effect("lists one connection per grant, however often it rotated", () =>
		Effect.gen(function* () {
			const connections = yield* McpConnectionsService
			const oauth = yield* McpOAuthService
			const claude = yield* connect("Claude Code", alice, orgId)
			yield* TestClock.adjust("2 hours")
			yield* oauth.refresh(
				{ refreshToken: claude.tokens.refresh_token, clientId: claude.clientId, resource },
				"127.0.0.1",
			)

			const [connection, ...rest] = yield* connections.list(orgId, admin)
			expect(rest).toEqual([])
			expect(connection).toMatchObject({
				clientName: "Claude Code",
				userId: alice,
				userEmail: "user_alice@acme.dev",
				scopes: ["mcp:tools"],
				connectedAt: 0,
				lastRefreshedAt: 2 * 60 * 60 * 1000,
			})
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)

	it.effect("shows a member only their own connections, and an admin everyone's in the org", () =>
		Effect.gen(function* () {
			const connections = yield* McpConnectionsService
			yield* connect("Claude Code", alice, orgId)
			yield* connect("Cursor", bob, orgId)
			yield* connect("Windsurf", bob, otherOrgId)

			const asBob = yield* connections.list(orgId, { userId: bob, seesAll: false })
			expect(asBob.map((c) => c.clientName)).toEqual(["Cursor"])
			const asAdmin = yield* connections.list(orgId, admin)
			expect(asAdmin.map((c) => c.clientName).sort()).toEqual(["Claude Code", "Cursor"])
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)

	it.effect("keeps the hourly OAuth access keys out of the API key list", () =>
		Effect.gen(function* () {
			const apiKeys = yield* ApiKeysService
			yield* connect("Claude Code", alice, orgId)
			yield* apiKeys.create(orgId, alice, {
				name: "Laptop",
				kind: "mcp",
				metadataJson: { source: "maple_mcp", roles: ["org:member"] },
			})
			yield* apiKeys.create(orgId, alice, { name: "CI" })

			const { keys } = yield* apiKeys.list(orgId)
			expect(keys.map((key) => key.name).sort()).toEqual(["CI", "Laptop"])
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)

	it.effect("revoking signs the client out and drops the connection", () =>
		Effect.gen(function* () {
			const connections = yield* McpConnectionsService
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService
			const claude = yield* connect("Claude Code", alice, orgId)
			const [connection] = yield* connections.list(orgId, admin)

			const revoked = yield* connections.revoke(orgId, connection!.id, {
				userId: alice,
				seesAll: false,
			})
			expect(revoked.clientName).toBe("Claude Code")
			expect(yield* connections.list(orgId, admin)).toEqual([])
			expect(Option.isNone(yield* apiKeys.resolveByKey(claude.tokens.access_token))).toBe(true)
			const refreshed = yield* Effect.exit(
				oauth.refresh(
					{ refreshToken: claude.tokens.refresh_token, clientId: claude.clientId, resource },
					"127.0.0.1",
				),
			)
			expect(Exit.isFailure(refreshed)).toBe(true)
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)

	it.effect("refuses a member revoking someone else's connection, or an unknown one", () =>
		Effect.gen(function* () {
			const connections = yield* McpConnectionsService
			yield* connect("Claude Code", alice, orgId)
			const [connection] = yield* connections.list(orgId, admin)

			const asBob = yield* Effect.flip(
				connections.revoke(orgId, connection!.id, { userId: bob, seesAll: false }),
			)
			expect(asBob._tag).toBe("@maple/http/errors/McpConnectionNotFoundError")
			const unknown = Schema.decodeUnknownSync(McpConnectionId)("7c9e6679-7425-40de-944b-e07fc1f90ae7")
			const missing = yield* Effect.flip(connections.revoke(orgId, unknown, admin))
			expect(missing._tag).toBe("@maple/http/errors/McpConnectionNotFoundError")
			expect(yield* connections.list(orgId, admin)).toHaveLength(1)
		}).pipe(Effect.provide(makeLayer(createTestDb(createdDbs)))),
	)
})
