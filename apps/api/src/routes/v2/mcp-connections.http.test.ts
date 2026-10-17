import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { OrgId, UserId } from "@maple/domain/http"
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

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_mcp_connections")
const ME = Schema.decodeUnknownSync(UserId)("user_member")
const OTHER = Schema.decodeUnknownSync(UserId)("user_other")
const MY_FAMILY = "11111111-1111-4111-8111-111111111111"
const OTHER_FAMILY = "22222222-2222-4222-8222-222222222222"

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const seedConnection = (db: TestDb, familyId: string, user: UserId, clientName: string) =>
	Effect.promise(async () => {
		await db.pglite.query(
			`insert into mcp_oauth_clients (client_id, client_name, redirect_uris, created_at)
			 values ($1, $2, '[]'::jsonb, now())`,
			[`client_${familyId}`, clientName],
		)
		await db.pglite.query(
			`insert into mcp_oauth_refresh_tokens
			 (id, token_hash, family_id, client_id, resource, scopes, org_id, user_id, roles, user_email,
			  access_key_id, created_at, expires_at, family_expires_at)
			 values ($1, $1, $2, $3, 'https://maple.test/mcp', '["mcp:tools"]'::jsonb, $4, $5,
			  '["org:member"]'::jsonb, $6, gen_random_uuid(), now(), now() + interval '30 days',
			  now() + interval '90 days')`,
			[`rt_${familyId}`, familyId, `client_${familyId}`, ORG, user, `${user}@acme.dev`],
		)
	})

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(Env.layer.pipe(Layer.provide(testConfig())), testDb.layer)))
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
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (method: string, path: string, token: string) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: { authorization: `Bearer ${token}` },
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}
	/** No metadata resolves as an org admin; CLI key metadata pins the member role. */
	const key = (role: "admin" | "member") =>
		runtime.runPromise(
			Effect.gen(function* () {
				const apiKeys = yield* ApiKeysService
				return yield* apiKeys.create(ORG, ME, {
					name: role,
					...(role === "member"
						? {
								metadataJson: {
									source: "maple_cli",
									roles: ["org:member"],
									deviceName: "laptop",
								},
							}
						: undefined),
				})
			}),
		)
	const seed = async () => {
		await Effect.runPromise(seedConnection(testDb, MY_FAMILY, ME, "Claude Code"))
		await Effect.runPromise(seedConnection(testDb, OTHER_FAMILY, OTHER, "Cursor"))
	}
	return { request, key, seed, dispose: () => Promise.all([dispose(), runtime.dispose()]) }
}

describe("v2 mcp connections", () => {
	it("lists every member's connections for an admin, and only their own for a member", async () => {
		const harness = makeHarness()
		try {
			await harness.seed()
			const admin = await harness.key("admin")
			const member = await harness.key("member")

			const all = await harness.request("GET", "/v2/mcp_connections", admin.secret)
			expect(all.status).toBe(200)
			expect(all.body.data.map((c: { client_name: string }) => c.client_name).sort()).toEqual([
				"Claude Code",
				"Cursor",
			])
			const mine = await harness.request("GET", "/v2/mcp_connections", member.secret)
			expect(mine.body.data).toHaveLength(1)
			expect(mine.body.data[0]).toMatchObject({
				object: "mcp_connection",
				client_name: "Claude Code",
				user_id: ME,
				user_email: "user_member@acme.dev",
				scopes: ["mcp:tools"],
			})
			expect(mine.body.data[0].id).toMatch(/^mcpc_/)
		} finally {
			await harness.dispose()
		}
	})

	it("lets a member revoke their own connection but not another member's, and audits it", async () => {
		const harness = makeHarness()
		try {
			await harness.seed()
			const admin = await harness.key("admin")
			const member = await harness.key("member")
			const all = await harness.request("GET", "/v2/mcp_connections", admin.secret)
			const idOf = (name: string) =>
				all.body.data.find((c: { client_name: string }) => c.client_name === name).id

			const denied = await harness.request(
				"DELETE",
				`/v2/mcp_connections/${idOf("Cursor")}`,
				member.secret,
			)
			expect(denied.status).toBe(404)
			const revoked = await harness.request(
				"DELETE",
				`/v2/mcp_connections/${idOf("Claude Code")}`,
				member.secret,
			)
			expect(revoked.status).toBe(200)
			expect(revoked.body.client_name).toBe("Claude Code")

			const after = await harness.request("GET", "/v2/mcp_connections", admin.secret)
			expect(after.body.data.map((c: { client_name: string }) => c.client_name)).toEqual(["Cursor"])
			const audit = await harness.request(
				"GET",
				"/v2/audit_log?action=mcp_connection.revoked",
				admin.secret,
			)
			expect(audit.body.data).toHaveLength(1)
			expect(audit.body.data[0].resource_id).toBe(idOf("Claude Code"))
		} finally {
			await harness.dispose()
		}
	})
})
