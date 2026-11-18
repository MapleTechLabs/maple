// SAFETY-FILE: JSON in this test is emitted by the route under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import { makeLoginSelfHosted } from "@maple/auth"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	AuthSessionApiGroup,
	CliDeviceActionResponse,
	CliDeviceInfoResponse,
	McpOAuthAuthorizationActionResponse,
	McpOAuthAuthorizationInfoResponse,
	OrgId,
} from "@maple/domain/http"
import { Array as Arr, ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { Env } from "@maple/backend/platform/Env"
import { AuditLogService, makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { CliDeviceAuthService } from "@maple/backend/services/auth/CliDeviceAuthService"
import { McpOAuthService } from "@maple/backend/services/auth/McpOAuthService"
import { SessionAuthorizationLive } from "@maple/backend/services/auth/SessionAuthorizationLive"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { HttpAuthSessionLive } from "./auth.http"

class AuthSessionOnlyApi extends HttpApi.make("MapleApi")
	.add(AuthSessionApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ConfigLive = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3472",
		MCP_PORT: "3473",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	}),
)

// The flow services are unimplemented mocks: a request that reached a handler
// would die on the first call instead of answering with the middleware's refusal.
const makeHarness = (
	services: {
		readonly cli?: Partial<CliDeviceAuthService["Service"]>
		readonly mcp?: Partial<McpOAuthService["Service"]>
		readonly auth?: Partial<AuthService["Service"]>
		readonly audit?: AuditLogService["Service"]
	} = {},
) => {
	const routes = HttpApiBuilder.layer(AuthSessionOnlyApi).pipe(
		Layer.provide(HttpAuthSessionLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provideMerge(SessionAuthorizationLive),
		Layer.provide(
			Layer.mergeAll(
				Layer.mock(CliDeviceAuthService)(services.cli ?? {}),
				Layer.mock(McpOAuthService)(services.mcp ?? {}),
				Layer.mock(AuthService)(services.auth ?? {}),
				services.audit !== undefined
					? Layer.succeed(AuditLogService, services.audit)
					: Layer.mock(AuditLogService)({}),
				Layer.mock(OrganizationRegionService)({ ensureServedHere: () => Effect.void }),
			),
		),
		Layer.provide(Env.layer),
		Layer.provide(ConfigLive),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes as never, { disableLogger: true })

	const call = async (method: string, path: string, bearer: string) => {
		// SAFETY: the handler's second argument is the Worker environment context,
		// and these routes read nothing out of it.
		const response = await handler(
			new Request(`http://maple.test/api/auth/${path}`, {
				method,
				headers: { authorization: `Bearer ${bearer}` },
			}),
			Context.empty(),
		)
		return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> }
	}

	const sessionToken = () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const env = yield* Env
				return (yield* makeLoginSelfHosted(env)("test-root-password")).token
			}).pipe(Effect.provide(Env.layer.pipe(Layer.provide(ConfigLive)))),
		)

	return { call, dispose, sessionToken }
}

const DEFAULT_ORG = Schema.decodeSync(OrgId)("default")

const LOGIN_ENDPOINTS = [
	["GET", "cli/device/ABCD-EFGH"],
	["POST", "cli/device/ABCD-EFGH/approve"],
	["POST", "cli/device/ABCD-EFGH/deny"],
	["GET", "mcp/oauth/authorization/req_1"],
	["POST", "mcp/oauth/authorization/req_1/approve"],
	["POST", "mcp/oauth/authorization/req_1/deny"],
] as const

describe("login approval endpoints", () => {
	it.each(LOGIN_ENDPOINTS)("refuse an API key bearer on %s /api/auth/%s", async (method, path) => {
		const harness = makeHarness()
		try {
			const response = await harness.call(method, path, "maple_ak_not-a-session")
			expect(response.status).toBe(403)
			expect(response.body._tag).toBe("@maple/http/errors/ApiKeyNotAcceptedError")
		} finally {
			await harness.dispose()
		}
	})

	it("treat any other bearer as a session and reject an invalid one as unauthorized", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.call("POST", "cli/device/ABCD-EFGH/approve", "not-a-session")
			expect(response.status).toBe(401)
		} finally {
			await harness.dispose()
		}
	})

	it("records an approved CLI login with the device it was for", async () => {
		const audit = makeMemoryAuditLog()
		const harness = makeHarness({
			audit,
			auth: { getUserEmail: () => Effect.succeed("root@maple.test") },
			cli: {
				inspect: () =>
					Effect.succeed(
						new CliDeviceInfoResponse({
							userCode: "ABCD-EFGH",
							deviceName: "work laptop",
							expiresAt: "2026-11-18T00:00:00.000Z",
							status: "pending",
						}),
					),
				approve: () => Effect.succeed(new CliDeviceActionResponse({ status: "approved" })),
			},
		})
		try {
			const token = await harness.sessionToken()
			const response = await harness.call("POST", "cli/device/ABCD-EFGH/approve", token)
			expect(response.status).toBe(200)
			const entries = await Effect.runPromise(
				audit.list(DEFAULT_ORG, { action: "cli_session.approved", limit: 10, offset: 0 }),
			)
			expect(Arr.map(entries, (entry) => entry.metadata?.deviceName)).toEqual(["work laptop"])
		} finally {
			await harness.dispose()
		}
	})

	it("records a granted MCP connection with its client and redirect host, not the redirect", async () => {
		const audit = makeMemoryAuditLog()
		const harness = makeHarness({
			audit,
			auth: { getUserEmail: () => Effect.succeed("root@maple.test") },
			mcp: {
				inspect: () =>
					Effect.succeed(
						new McpOAuthAuthorizationInfoResponse({
							clientName: "Editor",
							redirectUri: "https://client.example/cb",
							resource: "https://mcp.maple.test/mcp",
							scopes: ["mcp"],
							expiresAt: "2026-11-18T00:00:00.000Z",
							status: "pending",
						}),
					),
				approve: () =>
					Effect.succeed(
						new McpOAuthAuthorizationActionResponse({
							status: "approved",
							redirectUri: "https://client.example/cb?code=secret",
						}),
					),
			},
		})
		try {
			const token = await harness.sessionToken()
			const response = await harness.call("POST", "mcp/oauth/authorization/req_1/approve", token)
			expect(response.status).toBe(200)
			const entries = await Effect.runPromise(
				audit.list(DEFAULT_ORG, { action: "mcp_connection.granted", limit: 10, offset: 0 }),
			)
			expect(Arr.map(entries, (entry) => entry.metadata)).toEqual([
				expect.objectContaining({ clientName: "Editor", redirectHost: "client.example" }),
			])
			expect(JSON.stringify(entries)).not.toContain("code=secret")
		} finally {
			await harness.dispose()
		}
	})
})
