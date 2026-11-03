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
import { SourceUsageService } from "@maple/backend/services/org/SourceUsageService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { SourceRemovalService } from "@maple/backend/services/integrations/SourceRemovalService"
import type { SourceId } from "@maple/domain/primitives"
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

/** `/v2/sources` over an embedded PGlite with the real service. */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_sources_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_sources_e2e")

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
const hourlyRows = [
	{ hour: "2026-07-15 08:00:00", spans: "7", logs: "0", metrics: "0", bytes: "2100" },
	{ hour: "2026-07-15 09:00:00", spans: "51234", logs: "12873", metrics: "8400", bytes: "23891200" },
]
// Filled per test with the created source's id; a row that names no decodable source is dropped.
const totalsRows: Array<Record<string, string>> = []
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
	const realSources = SourcesService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, testDb.layer)))
	const sourcesLive = Layer.mergeAll(
		realSources,
		// Token and default sources only: SourceRemovalService.test.ts covers integration sources.
		Layer.effect(
			SourceRemovalService,
			Effect.gen(function* () {
				const sources = yield* SourcesService
				return {
					remove: (orgId: OrgId, sourceId: SourceId) =>
						Effect.map(sources.delete(orgId, sourceId), (source) => ({
							source,
							cleanupScript: null,
						})),
				}
			}),
		).pipe(Layer.provide(realSources)),
		Layer.effect(SourceUsageService, SourceUsageService.make).pipe(
			Layer.provide(
				Layer.succeed(
					WarehouseQueryService,
					makeWarehouseServiceStub({
						compiledQuery: (_tenant, compiled, options) => {
							recordedUsageSql.push(compiledQueryOf(compiled).sql)
							const rows = options?.context === "sourceUsageTotals" ? totalsRows : hourlyRows
							return compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)
						},
					}),
				),
			),
		),
	)

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(sourcesLive),
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
				return yield* service.create(ORG, USER, { name: "sources-test", metadataJson })
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

describe("v2 sources", () => {
	it("creates, lists, updates, rolls and deletes a source, showing the token only on create and roll", async () => {
		const harness = makeHarness()
		try {
			const { secret: token } = await harness.bootstrapKey()

			const created = await harness.request("POST", "/v2/sources", token, {
				name: "Checkout staging",
				platform: "nodejs",
				allowed_signals: ["traces", "logs"],
				rate_limit_rps: 200,
				resource_attributes: [{ key: "deployment.environment", value: "staging", mode: "set" }],
			})
			expect(created.status).toBe(200)
			expect(created.body.id).toMatch(/^src_/)
			expect(created.body.object).toBe("source")
			expect(created.body.platform).toBe("nodejs")
			expect(created.body.secret).toMatch(/^maple_src_/)
			expect(created.body.secret.startsWith(created.body.key_prefix)).toBe(true)
			const id: string = created.body.id

			const listed = await harness.request("GET", "/v2/sources", token)
			expect(listed.status).toBe(200)
			expect(listed.body.data).toHaveLength(2)
			expect(listed.body.data[0]).toMatchObject({ is_default: true, key_prefix: null, name: "Default" })
			expect(listed.body.data[0].health).toEqual({
				status: "pending",
				last_data_at: null,
				problem: null,
				resources: null,
			})
			expect(listed.body.data[0].integration_id).toBeNull()
			expect(listed.body.data[1].id).toBe(id)
			expect(listed.body.data[1]).not.toHaveProperty("secret")

			expect(created.body.status).toBe("active")
			expect(created.body.paused_at).toBeNull()
			expect(created.body.last_used_at).toBeNull()

			const updated = await harness.request("PATCH", `/v2/sources/${id}`, token, {
				rate_limit_rps: null,
			})
			expect(updated.status).toBe(200)
			expect(updated.body.rate_limit_rps).toBeNull()
			expect(updated.body.allowed_signals).toEqual(["traces", "logs"])

			const until = new Date(Date.now() + 3_600_000).toISOString()
			const paused = await harness.request("POST", `/v2/sources/${id}/pause`, token, {
				until,
			})
			expect(paused.status).toBe(200)
			expect(paused.body.status).toBe("paused")
			expect(paused.body.health.status).toBe("paused")
			expect(paused.body.paused_until).toBe(until)
			const pastPause = await harness.request("POST", `/v2/sources/${id}/pause`, token, {
				until: "2020-01-01T00:00:00.000Z",
			})
			expect(pastPause.status).toBe(400)
			const resumed = await harness.request("POST", `/v2/sources/${id}/resume`, token)
			expect(resumed.body.status).toBe("active")
			expect(resumed.body.paused_at).toBeNull()

			const usage = await harness.request("GET", `/v2/sources/${id}/usage`, token)
			expect(usage.status).toBe(200)
			expect(usage.body.buckets).toEqual([
				{ hour: "2026-07-15T08:00:00.000Z", spans: 7, logs: 0, metrics: 0, bytes: 2100 },
				{
					hour: "2026-07-15T09:00:00.000Z",
					spans: 51234,
					logs: 12873,
					metrics: 8400,
					bytes: 23891200,
				},
			])
			expect(recordedUsageSql.at(-1)).toContain(`'${id}'`)

			// `/usage` is the all-sources summary, not a source id that fails to decode.
			totalsRows.splice(0, totalsRows.length, {
				sourceId: id,
				spans: "51241",
				logs: "12873",
				metrics: "8400",
				bytes: "23893300",
			})
			totalsRows.push({ sourceId: "not-a-source", spans: "1", logs: "0", metrics: "0", bytes: "300" })
			const summary = await harness.request("GET", "/v2/sources/usage", token)
			expect(summary.status).toBe(200)
			expect(summary.body.object).toBe("source_usage_summary")
			expect(summary.body.data).toEqual([
				{ source_id: id, spans: 51241, logs: 12873, metrics: 8400, bytes: 23893300 },
			])

			const rolled = await harness.request("POST", `/v2/sources/${id}/roll`, token)
			expect(rolled.status).toBe(200)
			expect(rolled.body.id).toBe(id)
			expect(rolled.body.secret).toMatch(/^maple_src_/)
			expect(rolled.body.secret).not.toBe(created.body.secret)

			const audit = await harness.request("GET", "/v2/audit_log?limit=100", token)
			expect(audit.status).toBe(200)
			const auditText = JSON.stringify(audit.body)
			expect(auditText).toContain("source.created")
			expect(auditText).toContain("source.rolled")
			expect(auditText).toContain("source.paused")
			expect(auditText).toContain("source.resumed")
			expect(auditText).not.toContain(created.body.secret)
			expect(auditText).not.toContain(rolled.body.secret)

			const deleted = await harness.request("DELETE", `/v2/sources/${id}`, token)
			expect(deleted.body).toEqual({ id, object: "source", deleted: true })
			const missing = await harness.request("GET", `/v2/sources/${id}`, token)
			expect(missing.status).toBe(404)
			// Usage is gated on the source existing in the caller's org, before any warehouse read.
			const queriesBefore = recordedUsageSql.length
			const goneUsage = await harness.request("GET", `/v2/sources/${id}/usage`, token)
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
			const response = await harness.request("POST", "/v2/sources", token, {
				name: "bad",
				platform: "opentelemetry",
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
			const response = await harness.request("POST", "/v2/sources", token, {
				name: "k",
				platform: "nodejs",
			})
			expect(response.status).toBe(403)
			const pause = await harness.request(
				"POST",
				"/v2/sources/src_aXunrkWtzvXSkw9Z2smcft/pause",
				token,
				{},
			)
			expect(pause.status).toBe(403)
		} finally {
			await harness.dispose()
		}
	})

	it("refuses integration platforms and keeps the default source", async () => {
		const harness = makeHarness()
		try {
			const { secret: token } = await harness.bootstrapKey()
			const pull = await harness.request("POST", "/v2/sources", token, {
				name: "p",
				platform: "prometheus",
			})
			expect(pull.status).toBe(400)

			const listed = await harness.request("GET", "/v2/sources", token)
			const defaultId: string = listed.body.data[0].id
			const deleted = await harness.request("DELETE", `/v2/sources/${defaultId}`, token)
			expect(deleted.status).toBe(400)
			const rolled = await harness.request("POST", `/v2/sources/${defaultId}/roll`, token)
			expect(rolled.status).toBe(400)
			const renamed = await harness.request("PATCH", `/v2/sources/${defaultId}`, token, {
				name: "Prod",
			})
			expect(renamed.body).toMatchObject({ id: defaultId, name: "Prod", is_default: true })
		} finally {
			await harness.dispose()
		}
	})
})
