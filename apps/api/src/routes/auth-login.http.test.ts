// SAFETY-FILE: JSON in this test is emitted by the route under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import { ApiSchemaErrors, ApiUnexpectedErrors, AuthPublicApiGroup } from "@maple/domain/http"
import { ConfigProvider, Context, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { Env } from "@maple/backend/platform/Env"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { CliDeviceAuthService } from "@maple/backend/services/auth/CliDeviceAuthService"
import { PreviewSignInService } from "@maple/backend/services/auth/PreviewSignInService"
import {
	SELF_HOSTED_LOGIN_RATE_LIMIT_ATTEMPTS,
	SelfHostedLoginRateLimiter,
} from "@maple/backend/services/auth/SelfHostedLoginRateLimiter"
import { HttpAuthPublicLive } from "./auth.http"

class AuthPublicOnlyApi extends HttpApi.make("MapleApi")
	.add(AuthPublicApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ROOT_PASSWORD = "test-root-password"

const ConfigLive = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: ROOT_PASSWORD,
		MAPLE_SESSION_SIGNING_SECRET: "test-session-signing-secret",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	}),
)

// No rate-limit binding is provided, so the route runs on the in-process limit.
const makeHarness = () => {
	const routes = HttpApiBuilder.layer(AuthPublicOnlyApi).pipe(
		Layer.provide(HttpAuthPublicLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provide(
			Layer.mergeAll(
				AuthService.layer,
				SelfHostedLoginRateLimiter.layer,
				Layer.mock(CliDeviceAuthService)({}),
				Layer.mock(PreviewSignInService)({}),
			),
		),
		Layer.provide(Env.layer),
		Layer.provide(ConfigLive),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes as never, { disableLogger: true })

	const login = async (password: string, ip: string) => {
		// SAFETY: the handler's second argument is the Worker environment context,
		// and these routes read nothing out of it.
		const response = await handler(
			new Request("http://maple.test/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json", "cf-connecting-ip": ip },
				body: JSON.stringify({ password }),
			}),
			Context.empty(),
		)
		return {
			status: response.status,
			retryAfter: response.headers.get("retry-after"),
			body: JSON.parse(await response.text()) as Record<string, unknown>,
		}
	}

	return { login, dispose }
}

describe("POST /api/auth/login", () => {
	it("refuses a client with 429 and Retry-After once it is over the attempt limit", async () => {
		const harness = makeHarness()
		try {
			for (let attempt = 0; attempt < SELF_HOSTED_LOGIN_RATE_LIMIT_ATTEMPTS; attempt++) {
				const response = await harness.login("wrong-password-guess", "203.0.113.7")
				expect(response.status).toBe(401)
			}
			const refused = await harness.login(ROOT_PASSWORD, "203.0.113.7")
			expect(refused.status).toBe(429)
			expect(refused.body._tag).toBe("@maple/http/errors/SelfHostedLoginRateLimitError")
			expect(Number(refused.retryAfter)).toBeGreaterThan(0)

			// Another client is unaffected.
			const other = await harness.login(ROOT_PASSWORD, "198.51.100.4")
			expect(other.status).toBe(200)
		} finally {
			await harness.dispose()
		}
	})

	it("signs in with the correct password within the limit", async () => {
		const harness = makeHarness()
		try {
			await harness.login("wrong-password-guess", "203.0.113.7")
			const response = await harness.login(ROOT_PASSWORD, "203.0.113.7")
			expect(response.status).toBe(200)
			expect(typeof response.body.token).toBe("string")
		} finally {
			await harness.dispose()
		}
	})
})
