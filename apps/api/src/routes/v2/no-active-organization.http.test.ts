import { afterEach, describe, expect, it } from "@effect/vitest"
import { createSign, generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Context, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { Env } from "@maple/backend/platform/Env"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	Phase1ResourceStubsLayer,
	PlanetScaleServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/** `/v2` under Clerk auth with real session JWTs, verified networklessly against `CLERK_JWT_KEY`. */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const clerkKeys = generateKeyPairSync("rsa", { modulusLength: 2048 })
const strangerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwtKey = clerkKeys.publicKey.export({ type: "spki", format: "pem" }).toString()
// A production-shaped key: development instances also report SDK telemetry.
const publishableKey = `pk_live_${Buffer.from("clerk.maple.test$").toString("base64")}`

const base64UrlJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

/**
 * A Clerk v2 session token for a signed-in user with no `o` (organization) claim. `pending` is
 * Clerk's state for a user who still has to choose an organization.
 */
const sessionWithoutOrganization = ({ privateKey = clerkKeys.privateKey, pending = false } = {}) => {
	const now = Math.floor(Date.now() / 1000)
	const data = `${base64UrlJson({ alg: "RS256", typ: "JWT", kid: "ins_test" })}.${base64UrlJson({
		sub: "user_no_org",
		sid: "sess_no_org",
		iss: "https://clerk.maple.test",
		iat: now - 5,
		nbf: now - 5,
		exp: now + 300,
		v: 2,
		...(pending ? { sts: "pending" } : undefined),
	})}`
	return `${data}.${createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url")}`
}

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3488",
			MCP_PORT: "3489",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "clerk",
			CLERK_SECRET_KEY: "sk_live_no_org_test",
			CLERK_PUBLISHABLE_KEY: publishableKey,
			CLERK_JWT_KEY: jwtKey,
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))
	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const get = async (token: string) => {
		const response = await handler(
			new Request("http://maple.test/v2/agent_feedback", {
				headers: { authorization: `Bearer ${token}` },
			}),
			Context.empty() as never,
		)
		return { status: response.status, body: await response.json() }
	}
	return { get, dispose }
}

describe("v2 session without an active organization", () => {
	it.each([
		{ state: "active", pending: false },
		{ state: "pending", pending: true },
	])(
		"answers an $state session with NoActiveOrganizationError, not a sign-in error",
		async ({ pending }) => {
			const harness = makeHarness()
			try {
				const response = await harness.get(sessionWithoutOrganization({ pending }))
				expect(response.status).toBe(403)
				expect(response.body.error).toMatchObject({
					_tag: "@maple/http/v2/NoActiveOrganizationError",
					type: "permission_error",
					code: "no_active_organization",
					recovery: "none",
				})
			} finally {
				await harness.dispose()
			}
		},
	)

	it("keeps every other session 401 redacted", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.get(
				sessionWithoutOrganization({ privateKey: strangerKeys.privateKey }),
			)
			expect(response.status).toBe(401)
			expect(response.body.error).toMatchObject({
				_tag: "@maple/http/errors/UnauthorizedError",
				code: "invalid_credentials",
				message: "Invalid or missing credentials.",
				recovery: "reauthenticate",
			})
		} finally {
			await harness.dispose()
		}
	})
})
