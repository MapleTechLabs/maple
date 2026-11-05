import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { INVESTIGATION_READ_FAMILIES } from "@maple/domain/http/v2"
import { ConfigProvider, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { resolveMcpTenantContext } from "./resolve-tenant"

const INTERNAL_TOKEN = "internal-token"
const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_APP_BASE_URL: "https://app.example.com",
		MAPLE_API_BASE_URL: "https://api.example.com",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
	}),
)

const makeLayer = () => {
	const base = Layer.mergeAll(createTestDb(createdDbs).layer, Env.layer.pipe(Layer.provide(config)))
	return Layer.mergeAll(
		ApiKeysService.layer.pipe(Layer.provide(base)),
		AuthService.layer.pipe(Layer.provide(base)),
		ErrorActorsService.layer.pipe(Layer.provide(base)),
		base,
	)
}

const orgId = Schema.decodeSync(OrgId)("org_scoped_mcp")
const userId = Schema.decodeSync(UserId)("user_scoped_mcp")

/** Creates a standard key with `scopes` and resolves an MCP request bearing it. */
const resolveWithScopes = (scopes: ReadonlyArray<string> | null) =>
	Effect.gen(function* () {
		const apiKeys = yield* ApiKeysService
		const key = yield* apiKeys.create(orgId, userId, { name: "scoped", scopes })
		const request = new Request("https://api.example.com/mcp", {
			method: "POST",
			headers: { authorization: `Bearer ${key.secret}` },
		})
		return yield* resolveMcpTenantContext(request).pipe(Effect.result)
	})

const readAll = Arr.map(INVESTIGATION_READ_FAMILIES, (family) => `${family}:read`)

describe("scoped API keys on the MCP server", () => {
	it.effect("admits a read-only key and marks the tenant read-only", () =>
		Effect.gen(function* () {
			const result = yield* resolveWithScopes(readAll)
			expect(result._tag).toBe("Success")
			if (result._tag === "Success") {
				expect(result.success.orgId).toBe(orgId)
				expect(result.success.readOnly).toBe(true)
			}
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("refuses a key too narrow for the toolset, naming what is missing", () =>
		Effect.gen(function* () {
			const result = yield* resolveWithScopes(["traces:read"])
			expect(result._tag).toBe("Failure")
			if (result._tag === "Failure") {
				expect(result.failure).toMatchObject({ reason: "insufficient_scope" })
				expect(result.failure.message).toContain('"logs:read"')
				expect(result.failure.message).not.toContain('"traces:read"')
			}
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("treats `*` and unscoped keys as full access", () =>
		Effect.gen(function* () {
			const results = yield* Effect.forEach([["*"], null], resolveWithScopes)
			for (const result of results) {
				expect(result._tag).toBe("Success")
				if (result._tag === "Success") expect(result.success.readOnly).toBeUndefined()
			}
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("treats a key that writes every family as full access", () =>
		Effect.gen(function* () {
			const result = yield* resolveWithScopes(
				Arr.map(INVESTIGATION_READ_FAMILIES, (family) => `${family}:write`),
			)
			expect(result._tag).toBe("Success")
			if (result._tag === "Success") expect(result.success.readOnly).toBeUndefined()
		}).pipe(Effect.provide(makeLayer())),
	)
})

describe("internal service tokens on the MCP server", () => {
	const resolveServiceToken = (token: string) =>
		resolveMcpTenantContext(
			new Request("https://api.example.com/mcp", {
				method: "POST",
				headers: { authorization: `Bearer maple_svc_${token}`, "x-org-id": orgId },
			}),
		).pipe(Effect.result)

	it.effect("admits the configured token", () =>
		Effect.gen(function* () {
			const result = yield* resolveServiceToken(INTERNAL_TOKEN)
			expect(result._tag).toBe("Success")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("refuses a token of the same length in other characters as a mismatch", () =>
		Effect.gen(function* () {
			const result = yield* resolveServiceToken(Str.repeat(INTERNAL_TOKEN.length)("\u00e9"))
			expect(result._tag).toBe("Failure")
			if (result._tag === "Failure") {
				expect(result.failure._tag).toBe("@maple/mcp/errors/McpAuthInvalidError")
			}
		}).pipe(Effect.provide(makeLayer())),
	)
})
