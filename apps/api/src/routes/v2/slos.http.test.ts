import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema, Array as Arr } from "effect"
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
import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { formatWarehouseDateTime } from "@maple/query-engine"
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

/** `/v2/slos` over an embedded PGlite with the real service. */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeSync(OrgId)("org_slo_e2e")
const USER = Schema.decodeSync(UserId)("user_slo_e2e")

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

/** A warehouse whose SLO reads answer from fixed rows, decoded like real ones. */
const sloWarehouse = (
	rowsByContext: Record<string, ReadonlyArray<Record<string, unknown>>>,
): WarehouseQueryServiceApi =>
	makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled, options) =>
			compiledQueryOf(compiled)
				.decodeRows(rowsByContext[options?.context ?? ""] ?? [])
				.pipe(Effect.orDie),
	})

const makeHarness = (warehouse: WarehouseQueryServiceApi = makeWarehouseServiceStub()) => {
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

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		// Ahead of the stub bundles, which carry an inert warehouse of their own.
		Layer.provide(Layer.succeed(WarehouseQueryService, warehouse)),
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

	const bootstrapKey = (metadataJson?: Record<string, unknown>, scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, {
					name: "slo-test",
					metadataJson,
					...(scopes === undefined ? undefined : { scopes: [...scopes] }),
				})
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

const withHarness = (
	body: (harness: ReturnType<typeof makeHarness>) => Promise<void>,
	warehouse?: WarehouseQueryServiceApi,
) =>
	Effect.runPromise(
		Effect.acquireUseRelease(
			Effect.sync(() => makeHarness(warehouse)),
			(harness) => Effect.promise(() => body(harness)),
			(harness) => Effect.promise(() => harness.dispose()),
		),
	)

const MEMBER = { source: "maple_cli", roles: ["org:member"], deviceName: "laptop" }

const checkoutSlo = {
	name: "Checkout availability",
	service_name: "checkout",
	environments: ["production", "production"],
	sli: { type: "availability" },
	target_percent: 99.9,
}

describe("v2 slos", () => {
	it("creates, lists, retrieves, updates and deletes an SLO", () =>
		withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()

			const created = await harness.request("POST", "/v2/slos", token, checkoutSlo)
			expect(created.status).toBe(200)
			expect(created.body.id).toMatch(/^slo_/)
			// Environments are deduplicated; the window defaults to 30 days.
			expect(created.body).toMatchObject({
				object: "slo",
				name: "Checkout availability",
				description: null,
				service_name: "checkout",
				environments: ["production"],
				sli: { type: "availability" },
				target_percent: 99.9,
				window_days: 30,
			})
			const id: string = created.body.id
			// Every SLO gets its burn-rate rule, alerting with no destinations until some are added.
			expect(created.body.alert_rule_id).toMatch(/^alrt_/)
			expect(created.body.alerting).toEqual({
				enabled: true,
				critical_destination_ids: [],
				warning_destination_ids: [],
			})
			const paused = await harness.request("PATCH", `/v2/slos/${id}`, token, {
				alerting: { enabled: false },
			})
			expect(paused.body.alerting.enabled).toBe(false)
			expect(paused.body.alert_rule_id).toBe(created.body.alert_rule_id)

			const listed = await harness.request("GET", "/v2/slos", token)
			expect(listed.body.data.map((slo: { readonly id: string }) => slo.id)).toEqual([id])

			const updated = await harness.request("PATCH", `/v2/slos/${id}`, token, {
				sli: { type: "latency", threshold_ms: 250 },
				target_percent: 99,
				window_days: 7,
				environments: [],
			})
			expect(updated.status).toBe(200)
			expect(updated.body).toMatchObject({
				name: "Checkout availability",
				sli: { type: "latency", threshold_ms: 250 },
				target_percent: 99,
				window_days: 7,
				environments: [],
				alerting: { enabled: false },
			})

			const retrieved = await harness.request("GET", `/v2/slos/${id}`, token)
			expect(retrieved.body).toEqual(updated.body)

			const removed = await harness.request("DELETE", `/v2/slos/${id}`, token)
			expect(removed.body).toEqual({ id, object: "slo", deleted: true })
			const missing = await harness.request("GET", `/v2/slos/${id}`, token)
			expect(missing.status).toBe(404)
			expect(missing.body.error.code).toBe("slo_not_found")
		}))

	it("rejects a target, window or latency threshold off the allowed values", () =>
		withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			const statuses = await Promise.all(
				Arr.map(
					[
						{ ...checkoutSlo, target_percent: 100 },
						{ ...checkoutSlo, target_percent: 10 },
						{ ...checkoutSlo, window_days: 14 },
						{ ...checkoutSlo, sli: { type: "latency", threshold_ms: 300 } },
						{ ...checkoutSlo, service_name: "" },
					],
					async (body) => (await harness.request("POST", "/v2/slos", token, body)).status,
				),
			)
			expect(statuses).toEqual([400, 400, 400, 400, 400])
			expect((await harness.request("GET", "/v2/slos", token)).body.data).toEqual([])
		}))

	it("keeps names unique within the org", () =>
		withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			expect((await harness.request("POST", "/v2/slos", token, checkoutSlo)).status).toBe(200)
			const other = await harness.request("POST", "/v2/slos", token, { ...checkoutSlo, name: "Other" })
			expect(other.status).toBe(200)

			const duplicate = await harness.request("POST", "/v2/slos", token, checkoutSlo)
			expect(duplicate.status).toBe(400)
			expect(duplicate.body.error.code).toBe("slo_invalid")
			const rename = await harness.request("PATCH", `/v2/slos/${other.body.id}`, token, {
				name: checkoutSlo.name,
			})
			expect(rename.status).toBe(400)
		}))

	it("lets members read but not write", () =>
		withHarness(async (harness) => {
			const { secret: admin } = await harness.bootstrapKey()
			const { secret: member } = await harness.bootstrapKey(MEMBER)
			const created = await harness.request("POST", "/v2/slos", admin, checkoutSlo)
			const path = `/v2/slos/${created.body.id}`

			expect((await harness.request("GET", "/v2/slos", member)).status).toBe(200)
			expect((await harness.request("GET", path, member)).status).toBe(200)
			const writes = [
				await harness.request("POST", "/v2/slos", member, { ...checkoutSlo, name: "Mine" }),
				await harness.request("PATCH", path, member, { target_percent: 99 }),
				await harness.request("DELETE", path, member),
			]
			expect(Arr.map(writes, (response) => response.status)).toEqual([403, 403, 403])
		}))

	it("enforces the slos read and write scopes derived from the route", () =>
		withHarness(async (harness) => {
			const { secret: full } = await harness.bootstrapKey()
			const created = await harness.request("POST", "/v2/slos", full, checkoutSlo)
			const path = `/v2/slos/${created.body.id}`

			const { secret: reader } = await harness.bootstrapKey(undefined, ["slos:read"])
			expect((await harness.request("GET", path, reader)).status).toBe(200)
			const denied = await harness.request("PATCH", path, reader, { target_percent: 99 })
			expect([denied.status, denied.body.error.code]).toEqual([403, "insufficient_scope"])

			const { secret: writer } = await harness.bootstrapKey(undefined, ["slos:write"])
			expect((await harness.request("PATCH", path, writer, { target_percent: 99 })).status).toBe(200)
		}))

	it("reports the SLI, budget left and burn windows from the warehouse", () => {
		const nowMinute = Math.floor(Date.now() / 60_000) * 60_000
		// 2% of every minute is bad: 20x the 0.1% budget in every window.
		const minutes = Arr.makeBy(400, (index) => ({
			bucket: formatWarehouseDateTime(nowMinute - (index - 1) * 60_000),
			total: 100,
			good: 98,
		}))
		const warehouse = sloWarehouse({
			sloWindowTotals: [{ total: 10_000, good: 9_995 }],
			sloBurnWindows: minutes,
		})
		return withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			const created = await harness.request("POST", "/v2/slos", token, checkoutSlo)
			const status = await harness.request("GET", `/v2/slos/${created.body.id}/status`, token)
			expect(status.status).toBe(200)
			expect(status.body).toMatchObject({ object: "slo.status", slo_id: created.body.id })
			expect(status.body.total_events).toBe(10_000)
			expect(status.body.sli).toBeCloseTo(0.9995)
			expect(status.body.budget_remaining).toBeCloseTo(0.5)
			expect(
				Arr.map(status.body.burn_windows, (window: { window_minutes: number; burn_rate: number }) => [
					window.window_minutes,
					Math.round(window.burn_rate),
				]),
			).toEqual([
				[5, 20],
				[30, 20],
				[60, 20],
				[360, 20],
			])

			// An SLO that is gone, or another org's, is a 404 on both reads.
			const gone = "slo_YofPTrK9782DWwcnXhpcCw"
			const missing = await Promise.all([
				harness.request("GET", `/v2/slos/${gone}/status`, token),
				harness.request("GET", `/v2/slos/${gone}/history`, token),
			])
			expect(Arr.map(missing, (response) => [response.status, response.body.error.code])).toEqual([
				[404, "slo_not_found"],
				[404, "slo_not_found"],
			])

			const history = await harness.request("GET", `/v2/slos/${created.body.id}/history`, token)
			expect(history.status).toBe(200)
			// 30 days of hourly points, untouched since the stub has no hourly rows.
			expect(history.body.points).toHaveLength(720)
			expect(history.body.points[0].budget_remaining).toBe(1)
		}, warehouse)
	})

	it("reads every SLO's status in one batch, counting only each SLO's service and environments", () => {
		const burn = (total: number, good: number) => ({
			total5: total,
			good5: good,
			total30: total * 6,
			good30: good * 6,
			total60: total * 12,
			good60: good * 12,
			total360: total * 72,
			good360: good * 72,
		})
		const warehouse = sloWarehouse({
			sloStatusTotals: [
				{ serviceName: "checkout", environment: "production", total: 10_000, good: 9_995 },
				// Outside the checkout SLO's environments: counting it would spend the whole budget.
				{ serviceName: "checkout", environment: "staging", total: 500, good: 0 },
				{ serviceName: "search", environment: "production", total: 2_000, good: 2_000 },
			],
			sloStatusBurn: [
				{ serviceName: "checkout", environment: "production", ...burn(100, 98) },
				{ serviceName: "checkout", environment: "staging", ...burn(100, 0) },
				{ serviceName: "search", environment: "production", ...burn(100, 100) },
			],
		})
		return withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			const checkout = await harness.request("POST", "/v2/slos", token, checkoutSlo)
			const search = await harness.request("POST", "/v2/slos", token, {
				name: "Search latency",
				service_name: "search",
				sli: { type: "latency", threshold_ms: 500 },
				target_percent: 99,
			})
			const listed = await harness.request("GET", "/v2/slos/statuses", token)
			expect(listed.status).toBe(200)
			expect(listed.body.object).toBe("slo.status_list")
			const byId = new Map(
				Arr.map(listed.body.data, (status: { slo_id: string }) => [status.slo_id, status] as const),
			)
			const checkoutStatus = byId.get(checkout.body.id)
			expect(checkoutStatus.total_events).toBe(10_000)
			expect(checkoutStatus.budget_remaining).toBeCloseTo(0.5)
			expect(Math.round(checkoutStatus.burn_windows[0].burn_rate)).toBe(20)
			const searchStatus = byId.get(search.body.id)
			expect(searchStatus.sli).toBe(1)
			expect(searchStatus.burn_windows[3].burn_rate).toBe(0)
		}, warehouse)
	})
})
