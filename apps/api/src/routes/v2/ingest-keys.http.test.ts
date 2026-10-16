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
import { CustomIngestKeyUsageService } from "@maple/backend/services/org/CustomIngestKeyUsageService"
import { OrgCustomIngestKeysService } from "@maple/backend/services/org/OrgCustomIngestKeysService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	Phase1ResourceStubsLayer,
	makeWarehouseServiceStub,
	PlanetScaleServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/** `/v2/ingest_keys/custom` over an embedded PGlite with the real service. */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_ingest_keys_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_ingest_keys_e2e")

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3488",
			MCP_PORT: "3489",
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

// 64-bit counts arrive as strings, as ClickHouse returns them.
const usageRows = [
	{ signal: "spans", hour: "2026-07-15 09:00:00", count: "51234" },
	{ signal: "logs", hour: "2026-07-15 09:00:00", count: "12873" },
	{ signal: "spans", hour: "2026-07-15 08:00:00", count: "7" },
]
const recordedUsageSql: string[] = []

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
		MobileDevicesService.layer,
		LiveActivitiesService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))
	// Provided first so it shadows the inert stub in ConfigResourceServiceStubsLayer.
	const customKeysLive = Layer.mergeAll(
		OrgCustomIngestKeysService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, testDb.layer))),
		Layer.effect(CustomIngestKeyUsageService, CustomIngestKeyUsageService.make).pipe(
			Layer.provide(
				Layer.succeed(
					WarehouseQueryService,
					makeWarehouseServiceStub({
						compiledQuery: (_tenant, compiled) => {
							recordedUsageSql.push(compiledQueryOf(compiled).sql)
							return compiledQueryOf(compiled).decodeRows(usageRows).pipe(Effect.orDie)
						},
					}),
				),
			),
		),
	)

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(customKeysLive),
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
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (method: string, path: string, token: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body !== undefined ? { "content-type": "application/json" } : undefined),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	const bootstrapKey = (metadataJson?: Record<string, unknown>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "ingest-keys-test", metadataJson })
			}),
		)

	return {
		request,
		bootstrapKey,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 custom ingest keys", () => {
	it("creates, lists, updates, rolls and deletes a key, showing the secret only on create and roll", async () => {
		const harness = makeHarness()
		try {
			const { secret: token } = await harness.bootstrapKey()

			const created = await harness.request("POST", "/v2/ingest_keys/custom", token, {
				name: "Checkout staging",
				allowed_signals: ["traces", "logs"],
				rate_limit_rps: 200,
				resource_attributes: [{ key: "deployment.environment", value: "staging", mode: "set" }],
			})
			expect(created.status).toBe(200)
			expect(created.body.id).toMatch(/^ingk_/)
			expect(created.body.object).toBe("custom_ingest_key")
			expect(created.body.secret).toMatch(/^maple_ik_/)
			expect(created.body.secret.startsWith(created.body.key_prefix)).toBe(true)
			const id: string = created.body.id

			const listed = await harness.request("GET", "/v2/ingest_keys/custom", token)
			expect(listed.status).toBe(200)
			expect(listed.body.data).toHaveLength(1)
			expect(listed.body.data[0].id).toBe(id)
			expect(listed.body.data[0]).not.toHaveProperty("secret")

			expect(created.body.status).toBe("active")
			expect(created.body.paused_at).toBeNull()
			expect(created.body.last_used_at).toBeNull()

			const updated = await harness.request("PATCH", `/v2/ingest_keys/custom/${id}`, token, {
				rate_limit_rps: null,
			})
			expect(updated.status).toBe(200)
			expect(updated.body.rate_limit_rps).toBeNull()
			expect(updated.body.allowed_signals).toEqual(["traces", "logs"])

			const until = new Date(Date.now() + 3_600_000).toISOString()
			const paused = await harness.request("POST", `/v2/ingest_keys/custom/${id}/pause`, token, {
				until,
			})
			expect(paused.status).toBe(200)
			expect(paused.body.status).toBe("paused")
			expect(paused.body.paused_until).toBe(until)
			const pastPause = await harness.request("POST", `/v2/ingest_keys/custom/${id}/pause`, token, {
				until: "2020-01-01T00:00:00.000Z",
			})
			expect(pastPause.status).toBe(400)
			const resumed = await harness.request("POST", `/v2/ingest_keys/custom/${id}/resume`, token)
			expect(resumed.body.status).toBe("active")
			expect(resumed.body.paused_at).toBeNull()

			const usage = await harness.request("GET", `/v2/ingest_keys/custom/${id}/usage`, token)
			expect(usage.status).toBe(200)
			expect(usage.body.buckets).toEqual([
				{ hour: "2026-07-15T08:00:00.000Z", spans: 7, logs: 0 },
				{ hour: "2026-07-15T09:00:00.000Z", spans: 51234, logs: 12873 },
			])
			expect(recordedUsageSql.at(-1)).toContain(`'${id}'`)

			const rolled = await harness.request("POST", `/v2/ingest_keys/custom/${id}/roll`, token)
			expect(rolled.status).toBe(200)
			expect(rolled.body.id).toBe(id)
			expect(rolled.body.secret).toMatch(/^maple_ik_/)
			expect(rolled.body.secret).not.toBe(created.body.secret)

			const audit = await harness.request("GET", "/v2/audit_log?limit=100", token)
			expect(audit.status).toBe(200)
			const auditText = JSON.stringify(audit.body)
			expect(auditText).toContain("custom_ingest_key.created")
			expect(auditText).toContain("custom_ingest_key.rolled")
			expect(auditText).toContain("custom_ingest_key.paused")
			expect(auditText).toContain("custom_ingest_key.resumed")
			expect(auditText).not.toContain(created.body.secret)
			expect(auditText).not.toContain(rolled.body.secret)

			const deleted = await harness.request("DELETE", `/v2/ingest_keys/custom/${id}`, token)
			expect(deleted.body).toEqual({ id, object: "custom_ingest_key", deleted: true })
			const missing = await harness.request("GET", `/v2/ingest_keys/custom/${id}`, token)
			expect(missing.status).toBe(404)
			// Usage is gated on the key existing in the caller's org, before any warehouse read.
			const queriesBefore = recordedUsageSql.length
			const goneUsage = await harness.request("GET", `/v2/ingest_keys/custom/${id}/usage`, token)
			expect(goneUsage.status).toBe(404)
			expect(recordedUsageSql).toHaveLength(queriesBefore)
		} finally {
			await harness.dispose()
		}
	})

	it("rejects a reserved attribute override with a 400 that names the key", async () => {
		const harness = makeHarness()
		try {
			const { secret: token } = await harness.bootstrapKey()
			const response = await harness.request("POST", "/v2/ingest_keys/custom", token, {
				name: "bad",
				resource_attributes: [{ key: "maple_org_id", value: "org_other", mode: "set" }],
			})
			expect(response.status).toBe(400)
			expect(response.body.error.message).toContain("maple_org_id")
		} finally {
			await harness.dispose()
		}
	})

	it("refuses non-admin members", async () => {
		const harness = makeHarness()
		try {
			const { secret: token } = await harness.bootstrapKey({
				source: "maple_cli",
				roles: ["org:member"],
				deviceName: "laptop",
			})
			const response = await harness.request("POST", "/v2/ingest_keys/custom", token, { name: "k" })
			expect(response.status).toBe(403)
			const pause = await harness.request(
				"POST",
				"/v2/ingest_keys/custom/ingk_aXunrkWtzvXSkw9Z2smcft/pause",
				token,
				{},
			)
			expect(pause.status).toBe(403)
		} finally {
			await harness.dispose()
		}
	})
})
