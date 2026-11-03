// SAFETY-FILE: JSON in this test is emitted by the route under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import { ApiSchemaErrors, ApiUnexpectedErrors, AuthSessionApiGroup } from "@maple/domain/http"
import { ConfigProvider, Context, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { Env } from "@maple/backend/platform/Env"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
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
const makeHarness = () => {
	const routes = HttpApiBuilder.layer(AuthSessionOnlyApi).pipe(
		Layer.provide(HttpAuthSessionLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provideMerge(SessionAuthorizationLive),
		Layer.provide(
			Layer.mergeAll(
				Layer.mock(CliDeviceAuthService)({}),
				Layer.mock(McpOAuthService)({}),
				Layer.mock(AuthService)({}),
				Layer.mock(AuditLogService)({}),
				Layer.mock(OrganizationRegionService)({}),
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
			Context.empty() as never,
		)
		return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> }
	}

	return { call, dispose }
}

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
})
