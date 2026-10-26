import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
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
import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import { UptimeMonitorAllowance } from "@maple/backend/services/uptime/UptimeMonitorAllowance"
import { UptimeMonitorsService } from "@maple/backend/services/uptime/UptimeMonitorsService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	allV2GroupLayersWithUptime,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	Phase1ResourceStubsLayer,
	PlanetScaleServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/** `/v2/uptime_monitors` over an embedded PGlite with the real service. */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_uptime_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_uptime_e2e")

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
			MAPLE_API_BASE_URL: "https://api.maple.test",
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
		MobileDevicesService.layer,
		LiveActivitiesService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))
	const uptimeLive = Layer.effect(UptimeMonitorsService, UptimeMonitorsService.make).pipe(
		Layer.provide(UptimeMonitorAllowance.unmetered),
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.mergeAll(envLive, testDb.layer)),
	)

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(allV2GroupLayersWithUptime(uptimeLive)),
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
				return yield* service.create(ORG, USER, { name: "uptime-test", metadataJson })
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

describe("v2 uptime monitors", () => {
	it("creates, lists, retrieves, pauses, resumes and deletes a monitor", async () => {
		const harness = makeHarness()
		try {
			const { secret: token } = await harness.bootstrapKey()

			const created = await harness.request("POST", "/v2/uptime_monitors", token, {
				name: "API health",
				kind: "http",
				config: { type: "http", url: "https://api.example.com/health" },
				interval_seconds: 60,
				service_name: "api",
			})
			expect(created.status).toBe(200)
			expect(created.body.id).toMatch(/^upm_/)
			expect(created.body.alert_rule_id).toMatch(/^alrt_/)
			expect(created.body).toMatchObject({
				object: "uptime_monitor",
				kind: "http",
				enabled: true,
				failures_to_down: 2,
				heartbeat_url: null,
				// Omitted config fields come back with their defaults spelled out.
				config: {
					type: "http",
					url: "https://api.example.com/health",
					method: "GET",
					headers: {},
					assertions: [{ type: "status", op: "is", value: "2xx" }],
					timeout_ms: 10000,
				},
				state: { status: "pending", consecutive_failures: 0, last_check: null, recent: [] },
			})
			const id: string = created.body.id

			const listed = await harness.request("GET", "/v2/uptime_monitors", token)
			expect(listed.status).toBe(200)
			expect(listed.body.data.map((monitor: { id: string }) => monitor.id)).toEqual([id])

			const retrieved = await harness.request("GET", `/v2/uptime_monitors/${id}`, token)
			expect(retrieved.body.name).toBe("API health")

			const paused = await harness.request("PATCH", `/v2/uptime_monitors/${id}`, token, {
				enabled: false,
			})
			expect(paused.status).toBe(200)
			expect(paused.body.enabled).toBe(false)
			expect(paused.body.state.status).toBe("paused")

			const resumed = await harness.request("PATCH", `/v2/uptime_monitors/${id}`, token, {
				enabled: true,
			})
			expect(resumed.body.state.status).toBe("pending")

			const removed = await harness.request("DELETE", `/v2/uptime_monitors/${id}`, token)
			expect(removed.body).toEqual({ id, object: "uptime_monitor", deleted: true })

			const missing = await harness.request("GET", `/v2/uptime_monitors/${id}`, token)
			expect(missing.status).toBe(404)
			expect(missing.body.error._tag).toBe("@maple/http/errors/UptimeMonitorNotFoundError")
		} finally {
			await harness.dispose()
		}
	})

	it("gives a heartbeat monitor its ping URL", async () => {
		const harness = makeHarness()
		try {
			const { secret: token } = await harness.bootstrapKey()
			const created = await harness.request("POST", "/v2/uptime_monitors", token, {
				name: "nightly backup",
				kind: "heartbeat",
				config: {
					type: "heartbeat",
					schedule: { type: "interval", seconds: 86400 },
					grace_seconds: 600,
				},
			})
			expect(created.status).toBe(200)
			expect(created.body.heartbeat_url).toMatch(/^https:\/\/api\.maple\.test\/hb\/[A-Za-z0-9_-]{22,}$/)
		} finally {
			await harness.dispose()
		}
	})

	it("rejects invalid monitors and tests of non-HTTP checks", async () => {
		const harness = makeHarness()
		try {
			const { secret: token } = await harness.bootstrapKey()
			const mismatch = await harness.request("POST", "/v2/uptime_monitors", token, {
				name: "db",
				kind: "tcp",
				config: { type: "http", url: "https://api.example.com" },
			})
			expect(mismatch.status).toBe(400)
			expect(mismatch.body.error._tag).toBe("@maple/http/errors/UptimeMonitorValidationError")

			const privateHost = await harness.request("POST", "/v2/uptime_monitors", token, {
				name: "metadata",
				kind: "http",
				config: { type: "http", url: "http://169.254.169.254/latest/meta-data" },
			})
			expect(privateHost.status).toBe(400)

			const tcpTest = await harness.request("POST", "/v2/uptime_monitors/test", token, {
				config: { type: "tcp", host: "db.example.com", port: 5432 },
			})
			expect(tcpTest.status).toBe(400)
			expect(tcpTest.body.error.message).toContain("after it is created")

			const listed = await harness.request("GET", "/v2/uptime_monitors", token)
			expect(listed.body.data).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("shows header values to admins only and keeps redacted values on update", async () => {
		const harness = makeHarness()
		try {
			const { secret: admin } = await harness.bootstrapKey()
			const { secret: member } = await harness.bootstrapKey({
				source: "maple_cli",
				roles: ["org:member"],
				deviceName: "laptop",
			})
			const created = await harness.request("POST", "/v2/uptime_monitors", admin, {
				name: "API health",
				kind: "http",
				config: {
					type: "http",
					url: "https://api.example.com/health",
					headers: { Authorization: "Bearer s3cret", "X-Env": "prod" },
				},
			})
			expect(created.status).toBe(200)
			const id: string = created.body.id

			const adminRead = await harness.request("GET", `/v2/uptime_monitors/${id}`, admin)
			expect(adminRead.body.config.headers).toEqual({ Authorization: "Bearer s3cret", "X-Env": "prod" })

			const memberRead = await harness.request("GET", `/v2/uptime_monitors/${id}`, member)
			expect(memberRead.body.config.headers).toEqual({
				Authorization: "[redacted]",
				"X-Env": "[redacted]",
			})
			const memberList = await harness.request("GET", "/v2/uptime_monitors", member)
			expect(memberList.body.data[0].config.headers).toEqual({
				Authorization: "[redacted]",
				"X-Env": "[redacted]",
			})

			// Round-tripping a redacted config keeps the stored secret and applies the real change.
			const updated = await harness.request("PATCH", `/v2/uptime_monitors/${id}`, admin, {
				config: {
					...memberRead.body.config,
					headers: { Authorization: "[redacted]", "X-Env": "staging" },
				},
			})
			expect(updated.status).toBe(200)
			expect(updated.body.config.headers).toEqual({
				Authorization: "Bearer s3cret",
				"X-Env": "staging",
			})

			// A redacted value for a header that was never stored has nothing to keep.
			const orphan = await harness.request("PATCH", `/v2/uptime_monitors/${id}`, admin, {
				config: { ...memberRead.body.config, headers: { "X-New": "[redacted]" } },
			})
			expect(orphan.status).toBe(400)
			const after = await harness.request("GET", `/v2/uptime_monitors/${id}`, admin)
			expect(after.body.config.headers).toEqual({ Authorization: "Bearer s3cret", "X-Env": "staging" })
		} finally {
			await harness.dispose()
		}
	})

	it("refuses writes from non-admin members but lets them read", async () => {
		const harness = makeHarness()
		try {
			const { secret: token } = await harness.bootstrapKey({
				source: "maple_cli",
				roles: ["org:member"],
				deviceName: "laptop",
			})
			const create = await harness.request("POST", "/v2/uptime_monitors", token, {
				name: "API health",
				kind: "http",
				config: { type: "http", url: "https://api.example.com/health" },
			})
			expect(create.status).toBe(403)
			const test = await harness.request("POST", "/v2/uptime_monitors/test", token, {
				config: { type: "http", url: "https://api.example.com/health" },
			})
			expect(test.status).toBe(403)
			const listed = await harness.request("GET", "/v2/uptime_monitors", token)
			expect(listed.status).toBe(200)
		} finally {
			await harness.dispose()
		}
	})
})
