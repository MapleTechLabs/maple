import { afterEach, describe, expect, it } from "@effect/vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CurrentTenant,
	DigestApiGroup,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { EdgeCacheService, makeEdgeCacheService, makeMemoryBackend } from "@maple/cache"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DigestService } from "@maple/backend/services/digest/DigestService"
import { WebAnalyticsDigestService } from "@maple/backend/services/digest/WebAnalyticsDigestService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { HttpDigestLive } from "./digest.http"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

class DigestOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(DigestApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG_ID = Schema.decodeUnknownSync(OrgId)("org_digest_route")
const USER_ID = Schema.decodeUnknownSync(UserId)("user_digest_route")

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const unused = Effect.die("not used by the digest routes")

/** Only the verified-email lookup matters here; every other method is out of scope. */
const authStub = (verifiedEmail: string | null) =>
	Layer.succeed(AuthService, {
		resolveTenant: () => unused,
		resolveMcpTenant: () => unused,
		loginSelfHosted: () => unused,
		refreshSelfHostedSession: () => unused,
		getUserEmail: () => Effect.succeed("unverified@example.com"),
		getVerifiedPrimaryEmail: () => Effect.succeed(verifiedEmail),
		getCustomerData: () => unused,
	})

const authorizationStub = Layer.succeed(
	CurrentTenant.SessionAuthorization,
	CurrentTenant.SessionAuthorization.of({
		bearer: (httpEffect) =>
			Effect.provideService(
				httpEffect,
				CurrentTenant.Context,
				new CurrentTenant.TenantSchema({
					orgId: ORG_ID,
					userId: USER_ID,
					roles: [],
					authMode: "clerk",
				}),
			),
	}),
)

const makeHarness = (verifiedEmail: string | null) => {
	const db = createTestDb(createdDbs)
	const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
	const deps = Layer.mergeAll(
		Layer.succeed(EmailService, { isConfigured: false, send: () => Effect.void }),
		Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub()),
		Layer.succeed(EdgeCacheService, makeEdgeCacheService(makeMemoryBackend())),
	)
	const services = Layer.mergeAll(
		Layer.effect(DigestService, DigestService.make),
		Layer.effect(WebAnalyticsDigestService, WebAnalyticsDigestService.make),
		authStub(verifiedEmail),
	).pipe(Layer.provide(deps), Layer.provideMerge(base))
	const routes = HttpApiBuilder.layer(DigestOnlyApi).pipe(
		Layer.provide(HttpDigestLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provideMerge(authorizationStub),
		Layer.provide(services),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })

	const upsert = async (body: unknown) => {
		const response = await handler(
			new Request("http://maple.test/internal/digest/", {
				method: "POST",
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		return { status: response.status, body: await response.json() }
	}
	const storedEmail = () =>
		queryFirstRow<{ email: string }>(db, "select email from digest_subscriptions where user_id = $1", [
			USER_ID,
		]).then((row) => row?.email ?? null)

	return { upsert, storedEmail, dispose }
}

describe("POST /internal/digest", () => {
	it("refuses with DigestEmailUnavailableError when the member has no verified address", async () => {
		const harness = makeHarness(null)
		try {
			const response = await harness.upsert({ enabled: true })
			expect(response.status).toBe(422)
			expect(response.body).toMatchObject({ _tag: "@maple/http/errors/DigestEmailUnavailableError" })
			expect(await harness.storedEmail()).toBeNull()
		} finally {
			await harness.dispose()
		}
	})

	it("subscribes the member's verified address, never the one in the request body", async () => {
		const harness = makeHarness("member@acme.test")
		try {
			const response = await harness.upsert({ enabled: true, email: "someone-else@example.com" })
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({ email: "member@acme.test", enabled: true })
			expect(await harness.storedEmail()).toBe("member@acme.test")
		} finally {
			await harness.dispose()
		}
	})
})
