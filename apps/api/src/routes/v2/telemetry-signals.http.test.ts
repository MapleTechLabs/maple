import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import type { WarehouseQueryServiceApi } from "@/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { Env } from "@/platform/Env"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { IngestAttributeMappingService } from "@/services/org/IngestAttributeMappingService"
import { OrgIngestKeysService } from "@/services/org/OrgIngestKeysService"
import { RecommendationIssueService } from "@/services/errors/RecommendationIssueService"
import { ScrapeTargetsService } from "@/services/integrations/ScrapeTargetsService"
import { SetupAuditService } from "@/services/org/SetupAuditService"
import { PlanetScaleDiscoveryService } from "@/services/integrations/PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "@/services/auth/PlanetScaleOAuthService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { SignalPresenceService } from "@/services/org/SignalPresenceService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	makeWarehouseServiceStub,
	Phase1ResourceStubsLayer,
	PlanetScaleServiceStubsLayer,
	SlackIntegrationServiceStubLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"

/**
 * Wire-contract tests for `GET /v2/instrumentation/signals`. The SQL shape is covered in
 * packages/query-engine; what matters here is the promise the empty states depend on — every signal
 * always present in the response, and a warehouse outage degrading to `unknown` with a 200 rather
 * than failing the view that asked.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_signals_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_signals_e2e")

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3496",
			MCP_PORT: "3497",
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

/**
 * Rows are written the way ClickHouse actually returns them — 64-bit counts as strings — so this
 * also proves the derived row schema decodes the BYO-ClickHouse wire shape.
 */
const warehouseStub = (rows: ReadonlyArray<Record<string, unknown>>): WarehouseQueryServiceApi =>
	makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie),
		warmRoute: () => Effect.void,
	})

const unavailableWarehouse: WarehouseQueryServiceApi = makeWarehouseServiceStub({
	compiledQuery: () => Effect.die(new Error("warehouse unreachable")),
	warmRoute: () => Effect.void,
})

const die = () => Effect.die(new Error("not available in this test harness"))

/** `ScrapeTargetsService` reaches these for `planetscale` targets; nothing here does. */
const planetScaleStubs = Layer.mergeAll(
	Layer.succeed(PlanetScaleDiscoveryService, {
		discover: die,
		lastError: () => Effect.succeed(null),
		invalidate: () => Effect.void,
	}),
	Layer.succeed(PlanetScaleOAuthService, {
		startConnect: die,
		completeConnect: die,
		getValidAccessToken: die,
		listOrganizations: die,
		hasConnection: die,
		connectedByUserId: die,
		disconnect: die,
	}),
)

const makeHarness = (warehouse: WarehouseQueryServiceApi) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const warehouseLive = Layer.succeed(WarehouseQueryService, warehouse)

	// Real config-resource services rather than `ConfigResourceServiceStubsLayer`:
	// that bundle carries an inert SignalPresenceService, which would shadow the
	// one under test. Same trap the setup-audit harness documents.
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
		IngestAttributeMappingService.layer,
		OrgIngestKeysService.layer,
		RecommendationIssueService.layer.pipe(Layer.provide(warehouseLive)),
		ScrapeTargetsService.layer.pipe(Layer.provide(planetScaleStubs)),
		SetupAuditService.layer.pipe(Layer.provide(warehouseLive)),
		SignalPresenceService.layer.pipe(Layer.provide(warehouseLive)),
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provide(warehouseLive),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)

	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (token?: string) => {
		const response = await handler(
			new Request("http://maple.test/v2/instrumentation/signals", {
				method: "GET",
				headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null }
	}

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "signals-test", scopes })
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

describe("GET /v2/instrumentation/signals", () => {
	it("reports a signal the org is sending as present, with its window", async () => {
		const harness = makeHarness(
			warehouseStub([
				{
					signal: "traces",
					count: "1842013",
					firstSeen: "2026-08-12 09:00:00",
					lastSeen: "2026-09-11 11:00:00",
				},
			]),
		)
		try {
			const key = await harness.bootstrapKey()
			const { status, body } = await harness.request(key.secret)

			expect(status).toBe(200)
			expect(body.object).toBe("telemetry_signals")
			expect(body.warehouse_available).toBe(true)

			const traces = body.signals.find((s: { signal: string }) => s.signal === "traces")
			expect(traces).toMatchObject({
				object: "telemetry_signal",
				status: "present",
				count: 1842013,
			})
			// Naive ClickHouse literals are UTC. Reading them as local time would shift
			// every timestamp by the server's offset, silently.
			expect(traces.last_seen).toBe("2026-09-11T11:00:00.000Z")
		} finally {
			await harness.dispose()
		}
	})

	it("always returns every signal, reporting the unsent ones as absent", async () => {
		const harness = makeHarness(
			warehouseStub([
				{
					signal: "traces",
					count: "12",
					firstSeen: "2026-09-11 10:00:00",
					lastSeen: "2026-09-11 11:00:00",
				},
			]),
		)
		try {
			const key = await harness.bootstrapKey()
			const { body } = await harness.request(key.secret)

			// The whole point: an empty state keys its copy on this array, so a signal
			// dropping out would silently turn "wire up a log bridge" into no advice.
			expect(body.signals.map((s: { signal: string }) => s.signal)).toEqual([
				"traces",
				"logs",
				"metrics",
				"sessions",
				"product_events",
			])
			const logs = body.signals.find((s: { signal: string }) => s.signal === "logs")
			expect(logs).toMatchObject({ status: "absent", count: 0, first_seen: null, last_seen: null })
		} finally {
			await harness.dispose()
		}
	})

	it("treats a zero-count row as absent rather than present", async () => {
		const harness = makeHarness(
			warehouseStub([
				{
					signal: "sessions",
					count: "0",
					firstSeen: "1970-01-01 00:00:00",
					lastSeen: "1970-01-01 00:00:00",
				},
			]),
		)
		try {
			const key = await harness.bootstrapKey()
			const { body } = await harness.request(key.secret)

			const sessions = body.signals.find((s: { signal: string }) => s.signal === "sessions")
			expect(sessions).toMatchObject({ status: "absent", first_seen: null, last_seen: null })
		} finally {
			await harness.dispose()
		}
	})

	it("degrades to unknown on a warehouse outage instead of failing the caller", async () => {
		const harness = makeHarness(unavailableWarehouse)
		try {
			const key = await harness.bootstrapKey()
			const { status, body } = await harness.request(key.secret)

			// A 5xx here would break the very views this endpoint exists to repair.
			expect(status).toBe(200)
			expect(body.warehouse_available).toBe(false)
			for (const signal of body.signals) {
				expect(signal).toMatchObject({ status: "unknown", count: null })
			}
		} finally {
			await harness.dispose()
		}
	})

	it("requires authentication", async () => {
		const harness = makeHarness(warehouseStub([]))
		try {
			const { status } = await harness.request()
			expect(status).toBe(401)
		} finally {
			await harness.dispose()
		}
	})
})
