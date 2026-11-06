import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import { ApnsClient } from "@maple/backend/platform/Apns"
import { MobilePushService } from "@maple/backend/services/push/MobilePushService"
import { ChatAlertPoster } from "@maple/backend/services/alerts/ChatAlertPoster"
import { afterEach, describe, expect, it } from "@effect/vitest"
import {
	Clock,
	ConfigProvider,
	Context,
	Effect,
	Layer,
	ManagedRuntime,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import {
	AlertMemberDirectoryUnavailableError,
	AlertSilenceId,
	IntegrationsRevokedError,
	OrgId,
	UserId,
	WarehouseQuotaExceededError,
} from "@maple/domain/http"
import { AlertSilencePublicId, encodePublicId, MapleApiV2 } from "@maple/domain/http/v2"
import { BucketCacheService } from "@maple/query-engine/caching"
import { EdgeCacheService } from "@maple/cache"
import { CacheBackendLive } from "@maple/backend/platform/CacheBackendLive"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { AlertRuntime, AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { UptimeAlertSource } from "@maple/backend/services/uptime/UptimeAlertSource"
import { SloAlertSource } from "@maple/backend/services/slos/SloAlertSource"
import { AlertDestinationsService } from "@maple/backend/services/alerts/AlertDestinationsService"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import {
	LinearOAuthService,
	type LinearOAuthServiceApi,
} from "@maple/backend/services/auth/LinearOAuthService"
import { LinearIssueTracker } from "@maple/backend/services/alerts/LinearIssueTracker"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { OrgMembersService, type OrgMembersServiceApi } from "@maple/backend/services/org/OrgMembersService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	makeWarehouseServiceStub,
	PlanetScaleServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import { compiledQueryOf } from "@maple/query-engine/execution"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3480",
			MCP_PORT: "3481",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

/** The v2 alert CRUD endpoints never reach the warehouse; stub it inert. */
const warehouseStub = makeWarehouseServiceStub({
	query: () => Effect.die(new Error("unexpected warehouse pipe query")),
	rawSqlQuery: () => Effect.succeed([]),
	compiledQuery: (_tenant, compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: () => Effect.die(new Error("unexpected compiled query")),
	ingest: () => Effect.void,
})

const makeHarness = (
	warehouseService: WarehouseQueryServiceApi = warehouseStub,
	linearOAuthService?: LinearOAuthServiceApi,
	orgMembersService?: OrgMembersServiceApi,
) => {
	const testDb = createTestDb(createdDbs)
	const configLive = testConfig()
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const warehouseLive = Layer.succeed(WarehouseQueryService, warehouseService)
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
	const bucketCacheLive = BucketCacheService.layer.pipe(Layer.provide(edgeCacheLive))
	const queryEngineLive = Layer.effect(QueryEngineService, QueryEngineService.make).pipe(
		Layer.provide(warehouseLive),
		Layer.provide(edgeCacheLive),
		Layer.provide(bucketCacheLive),
		Layer.provide(configLive),
	)
	const runtimeLive = Layer.succeed(AlertRuntime, {
		now: Clock.currentTimeMillis,
		makeUuid: () => crypto.randomUUID(),
		deliveryTimeoutMs: () => 15_000,
		schedulerTickBudgetMs: () => 25_000,
		schedulerEvalTimeoutMs: () => 15_000,
		schedulerSpreadMs: () => 0,
	})
	const linearOAuthLive =
		linearOAuthService === undefined
			? LinearOAuthService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, testDb.layer)))
			: Layer.succeed(LinearOAuthService, linearOAuthService)
	const linearIssuesLive = Layer.effect(LinearIssueTracker, LinearIssueTracker.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.mergeAll(linearOAuthLive, testDb.layer)),
	)
	const emailLive = Layer.succeed(EmailService, {
		isConfigured: false,
		send: () => Effect.void,
	})
	const orgMembersLive = Layer.succeed(
		OrgMembersService,
		orgMembersService ?? { resolveMembers: () => Effect.succeed([]) },
	)
	// Held by AlertsService only to hand an autonomous investigation turn its `submit_diagnosis`
	// tool; nothing in these tests starts one. The real layer is cheap — Env plus the database.
	const investigationsLive = InvestigationService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, testDb.layer)),
	)
	const orgChSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, testDb.layer, edgeCacheLive)),
	)
	const alertDestinationsLive = Layer.effect(AlertDestinationsService, AlertDestinationsService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(ChatAlertPoster.layer),
		Layer.provide(
			Layer.mergeAll(
				envLive,
				testDb.layer,
				runtimeLive,
				linearOAuthLive,
				linearIssuesLive,
				emailLive,
				orgMembersLive,
			),
		),
	)
	const alertReadModelsLive = Layer.effect(AlertReadModelsService, AlertReadModelsService.make).pipe(
		Layer.provide(Layer.mergeAll(testDb.layer, warehouseLive)),
	)
	const alertRulesLive = AlertRulesService.layer.pipe(
		Layer.provide(Layer.mergeAll(testDb.layer, runtimeLive)),
	)
	const alertsLive = Layer.effect(AlertsService, AlertsService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(ChatAlertPoster.layer),
		Layer.provide(
			Layer.effect(MobilePushService, MobilePushService.make).pipe(
				Layer.provide(
					Layer.mergeAll(ApnsClient.layer, MobileDevicesService.layer, LiveActivitiesService.layer),
				),
			),
		),
		Layer.provide(
			Layer.mergeAll(
				envLive,
				testDb.layer,
				queryEngineLive,
				warehouseLive,
				runtimeLive,
				linearOAuthLive,
				linearIssuesLive,
				emailLive,
				orgMembersLive,
				orgChSettingsLive,
				investigationsLive,
				alertDestinationsLive,
				alertReadModelsLive,
				alertRulesLive,
				UptimeAlertSource.layer.pipe(Layer.provide(testDb.layer)),
				Layer.effect(SloAlertSource, SloAlertSource.make).pipe(
					Layer.provide(Layer.mergeAll(testDb.layer, warehouseLive)),
				),
			),
		),
	)
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
		alertDestinationsLive,
		alertReadModelsLive,
		alertRulesLive,
		alertsLive,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	const runtime = ManagedRuntime.make(servicesLive)
	const ORG = Schema.decodeSync(OrgId)("org_alerts_e2e")
	const USER = Schema.decodeSync(UserId)("user_alerts_e2e")

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "alerts-test", scopes })
			}),
		)

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

	return {
		bootstrapKey,
		request,
		testDb,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 alerts over HTTP", () => {
	const createWebhookAndRule = async (harness: ReturnType<typeof makeHarness>, token: string) => {
		const destination = await harness.request("POST", "/v2/alerts/destinations", token, {
			type: "webhook",
			name: "Ops hook",
			url: "https://example.com/hooks/maple",
		})
		const rule = await harness.request("POST", "/v2/alerts/rules", token, {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			destination_ids: [destination.body.id],
		})
		return { destination, rule }
	}

	it("supports destination + rule CRUD with v2 wire conventions", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])

		const destCreated = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Ops hook",
			url: "https://example.com/hooks/maple",
		})
		expect(destCreated.status).toBe(200)
		expect(destCreated.body.object).toBe("alert_destination")
		expect(destCreated.body.id).toMatch(/^dest_/)
		expect(destCreated.body.type).toBe("webhook")
		expect(destCreated.body.txid).toMatch(/^\d+$/)
		// Secrets never round-trip: only the redacted summary comes back.
		expect(JSON.stringify(destCreated.body)).not.toContain("signing")
		expect("url" in destCreated.body).toBe(false)

		const destId: string = destCreated.body.id

		const destUpdated = await harness.request("PATCH", `/v2/alerts/destinations/${destId}`, key.secret, {
			type: "webhook",
			name: "Primary ops hook",
		})
		expect(destUpdated.status).toBe(200)
		expect(destUpdated.body.name).toBe("Primary ops hook")
		expect(destUpdated.body.txid).toMatch(/^\d+$/)

		const ruleCreated = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			destination_ids: [destId],
			tags: ["payments"],
		})
		expect(ruleCreated.status).toBe(200)
		expect(ruleCreated.body.object).toBe("alert_rule")
		expect(ruleCreated.body.id).toMatch(/^alrt_/)
		expect(ruleCreated.body.destination_ids).toEqual([destId])
		expect(ruleCreated.body.no_data_behavior).toBe("skip")
		expect(ruleCreated.body.txid).toMatch(/^\d+$/)
		expect("signalType" in ruleCreated.body).toBe(false)

		const ruleId: string = ruleCreated.body.id

		const listed = await harness.request("GET", "/v2/alerts/rules?limit=1", key.secret)
		expect(listed.status).toBe(200)
		expect(listed.body).toMatchObject({ object: "list", has_more: false, next_cursor: null })
		expect(listed.body.data[0].id).toBe(ruleId)
		expect("txid" in listed.body.data[0]).toBe(false)

		const retrieved = await harness.request("GET", `/v2/alerts/rules/${ruleId}`, key.secret)
		expect(retrieved.status).toBe(200)
		expect(retrieved.body.name).toBe("Checkout error rate")

		// PATCH is a true partial update: pausing the rule keeps the condition.
		const patched = await harness.request("PATCH", `/v2/alerts/rules/${ruleId}`, key.secret, {
			enabled: false,
		})
		expect(patched.status).toBe(200)
		expect(patched.body.enabled).toBe(false)
		expect(patched.body.threshold).toBe(0.05)
		expect(patched.body.tags).toEqual(["payments"])
		expect(patched.body.txid).toMatch(/^\d+$/)

		const checks = await harness.request("GET", `/v2/alerts/rules/${ruleId}/checks`, key.secret)
		expect(checks.status).toBe(200)
		expect(checks.body).toMatchObject({ object: "list", data: [], has_more: false })
		const summary = await harness.request(
			"GET",
			`/v2/alerts/rules/${ruleId}/checks/summary?since=2025-01-01T00%3A00%3A00.000Z&until=2025-12-31T00%3A00%3A00.000Z`,
			key.secret,
		)
		expect(summary.status).toBe(200)
		expect(summary.body).toMatchObject({
			object: "alert_check.summary",
			top_group_keys: [],
			totals: { total: 0 },
			points: [],
		})
		expect(summary.body.bucket_seconds).toBeGreaterThan(0)
		expect((364 * 24 * 60 * 60) / summary.body.bucket_seconds).toBeLessThanOrEqual(720)

		const incidents = await harness.request("GET", "/v2/alerts/incidents", key.secret)
		expect(incidents.status).toBe(200)
		expect(incidents.body).toMatchObject({ object: "list", data: [] })

		// A destination referenced by a rule cannot be deleted.
		const conflicted = await harness.request("DELETE", `/v2/alerts/destinations/${destId}`, key.secret)
		expect(conflicted.status).toBe(409)
		expect(conflicted.body.error).toMatchObject({
			type: "conflict_error",
			code: "alert_destination_in_use",
		})

		const ruleDeleted = await harness.request("DELETE", `/v2/alerts/rules/${ruleId}`, key.secret)
		expect(ruleDeleted.status).toBe(200)
		expect(ruleDeleted.body).toMatchObject({ id: ruleId, object: "alert_rule", deleted: true })

		const destDeleted = await harness.request("DELETE", `/v2/alerts/destinations/${destId}`, key.secret)
		expect(destDeleted.status).toBe(200)
		expect(destDeleted.body).toMatchObject({ id: destId, object: "alert_destination", deleted: true })
		expect(destDeleted.body.txid).toMatch(/^\d+$/)

		const missing = await harness.request("GET", `/v2/alerts/rules/${ruleId}`, key.secret)
		expect(missing.status).toBe(404)
		expect(missing.body.error).toMatchObject({ type: "not_found_error", code: "alert_rule_not_found" })

		await harness.dispose()
	})

	it("paginates delivery history beyond the first 100 rows", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		await createWebhookAndRule(harness, key.secret)

		await executeSql(
			harness.testDb,
			`insert into alert_delivery_events (
				id, org_id, rule_id, destination_id, delivery_key, event_type,
				attempt_number, status, scheduled_at, payload_json, created_at, updated_at
			)
			select
				'00000000-0000-4000-8000-' || lpad(series::text, 12, '0'),
				rules.org_id, rules.id, destinations.id, 'delivery-' || series,
				'trigger', 1, 'success',
				timestamp '2026-07-31 12:00:00+00' - series * interval '1 second',
				'{}'::jsonb,
				timestamp '2026-07-31 12:00:00+00' - series * interval '1 second',
				timestamp '2026-07-31 12:00:00+00' - series * interval '1 second'
			from generate_series(1, 105) as series
			cross join lateral (
				select id, org_id from alert_rules where org_id = 'org_alerts_e2e' limit 1
			) as rules
			cross join lateral (
				select id from alert_destinations where org_id = 'org_alerts_e2e' limit 1
			) as destinations`,
		)
		await executeSql(
			harness.testDb,
			`insert into alert_delivery_events (
				id, org_id, rule_id, destination_id, delivery_key, event_type,
				attempt_number, status, scheduled_at, payload_json, created_at, updated_at
			) values (
				'00000000-0000-4000-9000-000000000001', 'org_other',
				'00000000-0000-4000-9000-000000000002', '00000000-0000-4000-9000-000000000003',
				'foreign-delivery', 'trigger', 1, 'success', timestamp '2026-08-01 12:00:00+00',
				'{}'::jsonb, timestamp '2026-08-01 12:00:00+00', timestamp '2026-08-01 12:00:00+00'
			)`,
		)

		// An internal PagerDuty acknowledgement sync is not a notification: the public list leaves it out.
		await executeSql(
			harness.testDb,
			`insert into alert_delivery_events (
				id, org_id, rule_id, destination_id, delivery_key, event_type,
				attempt_number, status, scheduled_at, payload_json, created_at, updated_at
			)
			select '00000000-0000-4000-9000-0000000000ac', rules.org_id, rules.id, destinations.id,
				'ack-sync', 'acknowledge', 1, 'success', timestamp '2026-08-02 12:00:00+00', '{}'::jsonb,
				timestamp '2026-08-02 12:00:00+00', timestamp '2026-08-02 12:00:00+00'
			from (select id, org_id from alert_rules where org_id = 'org_alerts_e2e' limit 1) as rules
			cross join (select id from alert_destinations where org_id = 'org_alerts_e2e' limit 1) as destinations`,
		)
		const first = await harness.request("GET", "/v2/alerts/deliveries?limit=60", key.secret)
		expect(first.status).toBe(200)
		expect(first.body.data).toHaveLength(60)
		expect(first.body.has_more).toBe(true)
		expect(first.body.next_cursor).toEqual(expect.any(String))
		expect(first.body.data[0].id).toMatch(/^evt_/)
		expect(first.body.data[0].scheduled_at > first.body.data[1].scheduled_at).toBe(true)

		const second = await harness.request(
			"GET",
			`/v2/alerts/deliveries?limit=60&cursor=${encodeURIComponent(first.body.next_cursor)}`,
			key.secret,
		)
		expect(second.status).toBe(200)
		expect(second.body.data).toHaveLength(45)
		expect(second.body.has_more).toBe(false)
		expect(second.body.next_cursor).toBeNull()
		expect(new Set(Arr.map([...first.body.data, ...second.body.data], (item) => item.id)).size).toBe(105)
		expect(
			Arr.some(
				[...first.body.data, ...second.body.data],
				(item) => item.delivery_key === "foreign-delivery" || item.delivery_key === "ack-sync",
			),
		).toBe(false)

		await harness.dispose()
	})

	it("clears stored raw SQL when a rule switches to a structured signal", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const destination = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Raw transition hook",
			url: "https://example.com/hooks/raw-transition",
		})
		expect(destination.status).toBe(200)

		const created = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Raw transition rule",
			severity: "warning",
			signal_type: "raw_query",
			raw_query_sql:
				"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
			raw_query_reducer: "max",
			comparator: "gt",
			threshold: 10,
			window_minutes: 5,
			destination_ids: [destination.body.id],
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)
		expect(created.body.raw_query_sql).toContain("$__orgFilter")

		const patched = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			signal_type: "error_rate",
		})
		expect(patched.status, JSON.stringify(patched.body)).toBe(200)
		expect(patched.body.signal_type).toBe("error_rate")
		expect(patched.body.raw_query_sql).toBeNull()
		expect(patched.body.raw_query_reducer).toBeNull()
		await harness.dispose()
	})

	it("clears the upper threshold when a rule leaves a range comparator", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const destination = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Range transition hook",
			url: "https://example.com/hooks/range-transition",
		})
		expect(destination.status).toBe(200)

		const created = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Range transition rule",
			severity: "warning",
			signal_type: "error_rate",
			comparator: "between",
			threshold: 1,
			threshold_upper: 10,
			window_minutes: 5,
			destination_ids: [destination.body.id],
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)

		const patched = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			comparator: "gt",
		})
		expect(patched.status, JSON.stringify(patched.body)).toBe(200)
		expect(patched.body.comparator).toBe("gt")
		expect(patched.body.threshold_upper).toBeNull()

		// A bound sent explicitly is validated, not silently dropped.
		const explicit = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			threshold_upper: 5,
		})
		expect(explicit.status, JSON.stringify(explicit.body)).toBe(400)
		await harness.dispose()
	})

	it("rejects hidden raw SQL on structured rules", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const response = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Disguised raw rule",
			severity: "warning",
			signal_type: "error_rate",
			raw_query_sql: "SELECT count() AS value FROM traces WHERE $__orgFilter",
			comparator: "gt",
			threshold: 0.1,
			window_minutes: 5,
			destination_ids: [],
		})
		expect(response.status).toBe(400)
		expect(response.body.error).toMatchObject({ type: "invalid_request_error" })
		await harness.dispose()
	})

	it("returns the exact rule-destination tag for a missing destination_id", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const destination = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Temporary destination",
			url: "https://example.com/hooks/temporary",
		})
		expect(destination.status).toBe(200)
		const removed = await harness.request(
			"DELETE",
			`/v2/alerts/destinations/${destination.body.id}`,
			key.secret,
		)
		expect(removed.status).toBe(200)

		const response = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Missing destination",
			severity: "warning",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.1,
			window_minutes: 5,
			destination_ids: [destination.body.id],
		})
		expect(response.status).toBe(404)
		expect(response.body.error).toMatchObject({
			_tag: "@maple/http/errors/AlertRuleDestinationNotFoundError",
			code: "alert_rule_destination_not_found",
			param: "destination_ids",
		})

		await harness.dispose()
	})

	it("keeps a rule's check interval through PATCH until it is set or cleared", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const destination = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Ops hook",
			url: "https://example.com/hooks/maple",
		})
		const created = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Hourly error rate",
			signal_type: "error_rate",
			severity: "warning",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 60,
			evaluation_interval_minutes: 30,
			destination_ids: [destination.body.id],
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)
		expect(created.body.evaluation_interval_minutes).toBe(30)

		const renamed = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			name: "Renamed",
		})
		expect(renamed.body.evaluation_interval_minutes).toBe(30)

		const tooShort = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			window_minutes: 15,
		})
		expect(tooShort.status).toBe(400)
		expect(JSON.stringify(tooShort.body)).toContain("evaluationIntervalMinutes")

		const cleared = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			window_minutes: 15,
			evaluation_interval_minutes: null,
		})
		expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
		expect(cleared.body.evaluation_interval_minutes).toBeNull()

		await harness.dispose()
	})

	it("keeps a rule's severity tiers through PATCH and rejects single-threshold edits on them", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const destination = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Ops hook",
			url: "https://example.com/hooks/maple",
		})
		const pager = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Pager hook",
			url: "https://example.com/hooks/pager",
		})
		const tiers = [
			{
				severity: "warning",
				value: 0.02,
				upper: null,
				recovery_value: 0.015,
				destination_ids: [destination.body.id],
				escalation_chain_id: null,
			},
			{
				severity: "critical",
				value: 0.05,
				upper: null,
				recovery_value: null,
				destination_ids: [pager.body.id],
				escalation_chain_id: null,
			},
		]
		const created = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Checkout error rate tiers",
			signal_type: "error_rate",
			comparator: "gt",
			window_minutes: 5,
			thresholds: tiers,
			consecutive_breaches_required: 3,
			breaches_out_of: 5,
		})
		expect(created.status).toBe(200)
		expect(created.body.thresholds).toEqual(tiers)
		expect(created.body.severity).toBe("critical")
		expect(created.body.threshold).toBe(0.02)
		expect(created.body.breaches_out_of).toBe(5)

		const toggled = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			enabled: false,
		})
		expect(toggled.status).toBe(200)
		expect(toggled.body.thresholds).toEqual(tiers)
		expect(toggled.body.breaches_out_of).toBe(5)

		const ambiguous = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			threshold: 0.1,
		})
		expect(ambiguous.status).toBe(400)
		expect(JSON.stringify(ambiguous.body)).toContain("thresholds")

		// Echoing the derived single-threshold fields back unchanged is not an edit.
		const echoed = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			name: "Echoed",
			severity: created.body.severity,
			threshold: created.body.threshold,
			threshold_upper: created.body.threshold_upper,
			destination_ids: [...created.body.destination_ids].reverse(),
		})
		expect(echoed.status, JSON.stringify(echoed.body)).toBe(200)
		expect(echoed.body.name).toBe("Echoed")
		expect(echoed.body.thresholds).toEqual(tiers)
		expect(echoed.body).toMatchObject({
			severity: "critical",
			threshold: 0.02,
			threshold_upper: null,
			breaches_out_of: 5,
		})
		expect([...echoed.body.destination_ids].sort()).toEqual([destination.body.id, pager.body.id].sort())
		expect(echoed.body.severity).toBe(created.body.severity)
		expect(echoed.body.threshold).toBe(created.body.threshold)
		expect(echoed.body.threshold_upper).toBe(created.body.threshold_upper)
		expect(echoed.body.breaches_out_of).toBe(5)
		expect(echoed.body.destination_ids).toEqual(created.body.destination_ids)

		await harness.dispose()
	})

	it("reads omitted tier bounds as null and names what an invalid rule got wrong", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const destination = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Ops hook",
			url: "https://example.com/hooks/maple",
		})
		const created = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Bare tier",
			signal_type: "error_rate",
			comparator: "gt",
			window_minutes: 5,
			thresholds: [{ severity: "warning", value: 0.02, destination_ids: [destination.body.id] }],
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)
		expect(created.body.thresholds).toEqual([
			{
				severity: "warning",
				value: 0.02,
				upper: null,
				recovery_value: null,
				destination_ids: [destination.body.id],
				escalation_chain_id: null,
			},
		])

		const missingUpper = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Open range",
			signal_type: "error_rate",
			comparator: "between",
			window_minutes: 5,
			thresholds: [{ severity: "warning", value: 0.02, destination_ids: [destination.body.id] }],
		})
		expect(missingUpper.status).toBe(400)
		expect(missingUpper.body.error.message).toContain("is required for between / not_between comparators")

		await harness.dispose()
	})

	it("reports malformed stored rules as a redacted storage failure", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const created = await createWebhookAndRule(harness, key.secret)
		expect(created.rule.status).toBe(200)
		await executeSql(
			harness.testDb,
			`update alert_rules set thresholds_json = '[{"severity":"not-a-severity","value":1,"upper":null,"recoveryValue":null,"destinationIds":[]}]'::jsonb where org_id = $1`,
			["org_alerts_e2e"],
		)

		const response = await harness.request("GET", "/v2/alerts/rules", key.secret)
		expect(response.status).toBe(500)
		expect(response.body.error).toMatchObject({
			_tag: "@maple/http/errors/AlertRuleStoredConfigInvalidError",
			code: "alert_rule_stored_config_invalid",
			retryable: false,
			recovery: "contact_support",
		})
		expect(JSON.stringify(response.body)).not.toContain("not-a-severity")

		await harness.dispose()
	})

	it("does not erase malformed optional stored rule fields", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const created = await createWebhookAndRule(harness, key.secret)
		expect(created.rule.status).toBe(200)

		await executeSql(harness.testDb, "update alert_rules set tags_json = '{}'::jsonb where org_id = $1", [
			"org_alerts_e2e",
		])

		const response = await harness.request("GET", `/v2/alerts/rules/${created.rule.body.id}`, key.secret)
		expect(response.status).toBe(500)
		expect(response.body.error).toMatchObject({
			_tag: "@maple/http/errors/AlertRuleStoredConfigInvalidError",
			code: "alert_rule_stored_config_invalid",
		})
		expect(JSON.stringify(response.body)).not.toContain("tags_json")

		await harness.dispose()
	})

	it("refuses to delete a destination when stored rule references cannot be decoded", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const created = await createWebhookAndRule(harness, key.secret)
		expect(created.destination.status).toBe(200)
		expect(created.rule.status).toBe(200)

		await executeSql(
			harness.testDb,
			"update alert_rules set destination_ids_json = '{}'::jsonb where org_id = $1",
			["org_alerts_e2e"],
		)

		const response = await harness.request(
			"DELETE",
			`/v2/alerts/destinations/${created.destination.body.id}`,
			key.secret,
		)
		expect(response.status).toBe(500)
		expect(response.body.error).toMatchObject({
			_tag: "@maple/http/errors/AlertRuleStoredConfigInvalidError",
			code: "alert_rule_stored_config_invalid",
			retryable: false,
			recovery: "contact_support",
		})
		expect(JSON.stringify(response.body)).not.toContain("destination_ids")

		const destination = await harness.request(
			"GET",
			`/v2/alerts/destinations/${created.destination.body.id}`,
			key.secret,
		)
		expect(destination.status).toBe(200)

		await harness.dispose()
	})

	it("blocks raw SQL preview for non-admin keys without querying the warehouse", async () => {
		let warehouseCalls = 0
		const harness = makeHarness({
			...warehouseStub,
			rawSqlQuery: () => {
				warehouseCalls += 1
				return Effect.succeed([{ value: 42 }])
			},
		})
		// Preview needs only `alerts:read`, but replaying a raw_query rule executes
		// user-authored ClickHouse — the same capability creating one requires. A
		// read-only key must not get there via preview.
		const key = await harness.bootstrapKey(["alerts:read"])
		const response = await harness.request("POST", "/v2/alerts/rules/preview", key.secret, {
			rule: {
				name: "Raw preview",
				severity: "warning",
				signal_type: "raw_query",
				raw_query_sql:
					"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
				raw_query_reducer: "max",
				comparator: "gt",
				threshold: 10,
				window_minutes: 5,
				destination_ids: [],
			},
			start_time: "2026-01-01T00:00:00.000Z",
			end_time: "2026-01-01T00:30:00.000Z",
		})
		expect(response.status).toBe(403)
		expect(warehouseCalls).toBe(0)
		await harness.dispose()
	})

	it("previews a raw SQL alert for alerts:write keys", async () => {
		const harness = makeHarness({
			...warehouseStub,
			rawSqlQuery: () => Effect.succeed([{ bucket: "2026-01-01 00:10:00", value: 42, samples: 20 }]),
		})
		const key = await harness.bootstrapKey(["alerts:write"])
		const response = await harness.request("POST", "/v2/alerts/rules/preview", key.secret, {
			rule: {
				name: "Raw preview",
				severity: "warning",
				signal_type: "raw_query",
				raw_query_sql:
					"SELECT $__timeGroup(Timestamp) AS bucket, count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY bucket",
				raw_query_reducer: "max",
				comparator: "gt",
				threshold: 10,
				window_minutes: 5,
				destination_ids: [],
			},
			start_time: "2026-01-01T00:00:00.000Z",
			end_time: "2026-01-01T00:30:00.000Z",
		})
		expect(response.status).toBe(200)
		expect(response.body.object).toBe("alert_rule.preview")
		expect(response.body.series.length).toBeGreaterThan(0)
		// A 5-minute window is checked every minute, whose limit is 5s.
		expect(response.body.query_timing).toMatchObject({
			failure: null,
			interval_minutes: 1,
			limit_ms: 5000,
			probe_limit_ms: 25000,
		})
		expect(response.body.query_timing.fits_interval_minutes).toContain(1)
		await harness.dispose()
	})

	it("previews a raw SQL alert too heavy to chart with its one-check timing and series_failure", async () => {
		// The chart reads the requested 2026 range; the timing probe reads the latest window.
		const harness = makeHarness({
			...warehouseStub,
			rawSqlQuery: (_tenant, sql) =>
				Str.includes("2026-01-01")(sql)
					? Effect.fail(
							new WarehouseQuotaExceededError({
								message: "Memory limit exceeded",
								pipeName: "rawSqlQuery",
								setting: "max_memory_usage",
							}),
						)
					: Effect.succeed([{ value: 1, samples: 1 }]),
		})
		const key = await harness.bootstrapKey(["alerts:write"])
		const response = await harness.request("POST", "/v2/alerts/rules/preview", key.secret, {
			rule: {
				name: "Heavy raw preview",
				severity: "warning",
				signal_type: "raw_query",
				raw_query_sql:
					"SELECT count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
				comparator: "gt",
				threshold: 10,
				window_minutes: 5,
				destination_ids: [],
			},
			start_time: "2026-01-01T00:00:00.000Z",
			end_time: "2026-01-01T00:30:00.000Z",
		})
		expect(response.status, JSON.stringify(response.body)).toBe(200)
		expect(response.body.series_failure).toBe("query_too_much_memory")
		expect(response.body.series).toEqual([])
		expect(response.body.query_timing).toMatchObject({ failure: null })
		await harness.dispose()
	})

	it("paginates alert checks beyond the former 2,000-row window", async () => {
		const checkRows = Array.from({ length: 2_005 }, (_, index) => {
			const timestamp = new Date(Date.UTC(2026, 0, 1) + (2_005 - index) * 1_000).toISOString()
			return {
				timestamp,
				groupKey: `service=api-${Str.padStart(4, "0")(String(index))}`,
				status: "healthy",
				signalType: "error_rate",
				comparator: "gt",
				threshold: 0.05,
				observedValue: 0.01,
				sampleCount: 100,
				windowMinutes: 5,
				windowStart: timestamp,
				windowEnd: timestamp,
				consecutiveBreaches: 0,
				consecutiveHealthy: 1,
				incidentId: null,
				incidentTransition: "none",
				evaluationDurationMs: 8,
				errorMessage: null,
				errorCategory: "",
				skipReason: "",
				level: "",
			}
		})
		const pagedWarehouse: WarehouseQueryServiceApi = {
			...warehouseStub,
			compiledQuery: (_tenant, compiled, options) => {
				if (options?.context !== "listAlertChecks")
					return compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie)
				const limit = Number(/LIMIT\s+(\d+)/i.exec(compiledQueryOf(compiled).sql)?.[1] ?? 100)
				const before = /Timestamp < '([^']+)'/i.exec(compiledQueryOf(compiled).sql)?.[1]
				const status = /Status = '([^']+)'/i.exec(compiledQueryOf(compiled).sql)?.[1]
				const beforeMs =
					before === undefined ? undefined : Date.parse(`${Str.replace(" ", "T")(before)}Z`)
				const rows = Arr.filter(
					checkRows,
					(row) =>
						(beforeMs === undefined || Date.parse(row.timestamp) < beforeMs) &&
						(status === undefined || row.status === status),
				)
				return compiledQueryOf(compiled).decodeRows(rows.slice(0, limit)).pipe(Effect.orDie)
			},
		}
		const harness = makeHarness(pagedWarehouse)
		const key = await harness.bootstrapKey(["alerts:write"])
		const destination = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Pagination hook",
			url: "https://example.com/hooks/pagination",
		})
		expect(destination.status).toBe(200)
		const created = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Pagination rule",
			severity: "warning",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			destination_ids: [destination.body.id],
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)

		let cursor: string | null = null
		const seen = new Set<string>()
		do {
			const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
			const page = await harness.request(
				"GET",
				`/v2/alerts/rules/${created.body.id}/checks?limit=100${suffix}`,
				key.secret,
			)
			expect(page.status).toBe(200)
			for (const check of page.body.data) seen.add(`${check.timestamp}:${check.group_key}`)
			cursor = page.body.next_cursor
		} while (cursor !== null)

		expect(seen.size).toBe(2_005)

		const filtered = await harness.request(
			"GET",
			`/v2/alerts/rules/${created.body.id}/checks?limit=10&status=healthy`,
			key.secret,
		)
		expect(filtered.status).toBe(200)
		expect(filtered.body.data).toHaveLength(10)
		expect(filtered.body.data.every((check: { status: string }) => check.status === "healthy")).toBe(true)
		await harness.dispose()
	})

	it("preserves the exact Linear integration failure on destination create", async () => {
		const unavailable = () => Effect.die("unexpected Linear OAuth method")
		const linearOAuth: LinearOAuthServiceApi = {
			startConnect: unavailable,
			completeConnect: unavailable,
			getStatus: unavailable,
			withAccessToken: unavailable,
			listTeams: unavailable,
			getTeam: () =>
				Effect.fail(
					new IntegrationsRevokedError({
						message: "Linear rejected the access token, reconnect required",
					}),
				),
			disconnect: unavailable,
		}
		const harness = makeHarness(warehouseStub, linearOAuth)
		const key = await harness.bootstrapKey(["alerts:write"])

		const response = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "linear",
			name: "Linear incidents",
			team_id: "9cfb482a-81e3-4154-b5b9-2c805e70a02d",
		})

		expect(response.status).toBe(401)
		expect(response.body.error._tag).toBe("@maple/http/errors/IntegrationsRevokedError")
		await harness.dispose()
	})

	it("preserves a member-directory outage on email destination create", async () => {
		const orgMembers: OrgMembersServiceApi = {
			resolveMembers: () =>
				Effect.fail(
					new AlertMemberDirectoryUnavailableError({
						message: "Clerk member lookup failed",
						cause: new Error("Clerk unavailable"),
					}),
				),
		}
		const harness = makeHarness(warehouseStub, undefined, orgMembers)
		const key = await harness.bootstrapKey(["alerts:write"])

		const response = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "email",
			name: "On-call email",
			member_user_ids: ["user_2Nk8mXqPfR3yZ1aB4cD5eF6g"],
		})

		expect(response.status).toBe(503)
		expect(response.body.error._tag).toBe("@maple/http/errors/AlertMemberDirectoryUnavailableError")
		expect(JSON.stringify(response.body)).not.toContain("Clerk")
		await harness.dispose()
	})

	it("preserves exact stored destination failures through the HTTP envelope", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])

		const invalidConfig = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Invalid stored config",
			url: "https://example.com/hooks/invalid-config",
		})
		expect(invalidConfig.status).toBe(200)
		await executeSql(
			harness.testDb,
			"update alert_destinations set config_json = '{}'::jsonb where name = $1",
			["Invalid stored config"],
		)
		const invalidConfigList = await harness.request("GET", "/v2/alerts/destinations", key.secret)
		expect(invalidConfigList.status).toBe(500)
		expect(invalidConfigList.body.error._tag).toBe(
			"@maple/http/errors/AlertDestinationStoredConfigInvalidError",
		)

		const invalidConfigTest = await harness.request(
			"POST",
			`/v2/alerts/destinations/${invalidConfig.body.id}/test`,
			key.secret,
		)
		expect(invalidConfigTest.status).toBe(500)
		expect(invalidConfigTest.body.error).toMatchObject({
			_tag: "@maple/http/errors/AlertDestinationStoredConfigInvalidError",
			code: "alert_destination_stored_config_invalid",
			retryable: false,
			recovery: "contact_support",
		})
		expect(JSON.stringify(invalidConfigTest.body)).not.toContain("public_config")

		const unreadableSecret = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Unreadable stored secret",
			url: "https://example.com/hooks/unreadable-secret",
		})
		expect(unreadableSecret.status).toBe(200)
		await executeSql(harness.testDb, "update alert_destinations set secret_tag = '' where name = $1", [
			"Unreadable stored secret",
		])

		const unreadableSecretTest = await harness.request(
			"POST",
			`/v2/alerts/destinations/${unreadableSecret.body.id}/test`,
			key.secret,
		)
		expect(unreadableSecretTest.status).toBe(500)
		expect(unreadableSecretTest.body.error).toMatchObject({
			_tag: "@maple/http/errors/AlertDestinationDecryptionError",
			code: "alert_destination_decryption_failed",
			retryable: false,
			recovery: "contact_support",
		})
		expect(JSON.stringify(unreadableSecretTest.body)).not.toContain("Decryption failed")

		await harness.dispose()
	})

	it("acknowledges and unacknowledges an open incident and lists its events", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const readOnly = await harness.bootstrapKey(["alerts:read"])
		await createWebhookAndRule(harness, key.secret)
		await executeSql(
			harness.testDb,
			`insert into alert_incidents (
				id, org_id, rule_id, incident_key, rule_name, group_key, signal_type, severity, status,
				comparator, threshold, first_triggered_at, last_triggered_at, resolved_at, dedupe_key,
				created_at, updated_at
			)
			select v.id, rules.org_id, rules.id, v.id, 'Checkout error rate', '__total__', 'error_rate',
				'critical', v.status, 'gt', 0.05, now(), now(), v.resolved_at, v.id, now(), now()
			from (values
				('00000000-0000-4000-8000-0000000000a1', 'open', null::timestamptz),
				('00000000-0000-4000-8000-0000000000a2', 'resolved', now())
			) as v(id, status, resolved_at)
			cross join lateral (
				select id, org_id from alert_rules where org_id = 'org_alerts_e2e' limit 1
			) as rules`,
		)
		const list = await harness.request("GET", "/v2/alerts/incidents?status=open", key.secret)
		const open = Arr.findFirst(
			list.body.data,
			(incident: { status: string }) => incident.status === "open",
		)
		const openId: string = open._tag === "Some" ? open.value.id : ""
		expect(open._tag === "Some" && open.value.acknowledged_at).toBeNull()

		const acked = await harness.request("POST", `/v2/alerts/incidents/${openId}/acknowledge`, key.secret)
		expect(acked.status).toBe(200)
		expect(acked.body.status).toBe("open")
		expect(acked.body.acknowledged_at).toEqual(expect.any(String))
		// An API key is not a person: it is named by its label and has no user.
		expect(acked.body.acknowledged_by).toEqual({ user_id: null, name: "alerts-test" })
		expect(acked.body.acknowledged_via).toBe("api")

		const unacknowledgedOnly = await harness.request(
			"GET",
			"/v2/alerts/incidents?acknowledged=false",
			key.secret,
		)
		expect(unacknowledgedOnly.body.data).toEqual([])
		const acknowledgedOnly = await harness.request(
			"GET",
			"/v2/alerts/incidents?acknowledged=true",
			key.secret,
		)
		expect(Arr.map(acknowledgedOnly.body.data, (incident: { id: string }) => incident.id)).toEqual([
			openId,
		])

		// alerts:read can see the history but not change it.
		const denied = await harness.request(
			"POST",
			`/v2/alerts/incidents/${openId}/unacknowledge`,
			readOnly.secret,
		)
		expect(denied.status).toBe(403)

		const unacked = await harness.request(
			"POST",
			`/v2/alerts/incidents/${openId}/unacknowledge`,
			key.secret,
		)
		expect(unacked.status).toBe(200)
		expect(unacked.body.acknowledged_at).toBeNull()
		expect(unacked.body.acknowledged_by).toBeNull()

		const events = await harness.request("GET", `/v2/alerts/incidents/${openId}/events`, readOnly.secret)
		expect(events.status).toBe(200)
		expect(Arr.map(events.body.data, (event: { type: string }) => event.type)).toEqual([
			"acknowledged",
			"unacknowledged",
		])
		expect(events.body.data[0]).toMatchObject({
			object: "alert_incident_event",
			incident_id: openId,
			actor: { user_id: null, name: "alerts-test" },
			source: "api",
		})
		expect(events.body.data[0].id).toMatch(/^evt_/)

		const all = await harness.request("GET", "/v2/alerts/incidents", key.secret)
		const resolved = Arr.findFirst(
			all.body.data,
			(incident: { status: string }) => incident.status === "resolved",
		)
		const resolvedId: string = resolved._tag === "Some" ? resolved.value.id : ""
		const conflict = await harness.request(
			"POST",
			`/v2/alerts/incidents/${resolvedId}/acknowledge`,
			key.secret,
		)
		expect(conflict.status).toBe(409)
		expect(conflict.body.error).toMatchObject({ code: "alert_incident_resolved" })

		const missing = await harness.request(
			"POST",
			"/v2/alerts/incidents/inc_tC4d9V79DCDzgbGKhAnff9/acknowledge",
			key.secret,
		)
		expect(missing.status).toBe(404)

		await harness.dispose()
	})

	it("enforces the alerts scope family and rejects malformed ids", async () => {
		const harness = makeHarness()
		const readOnly = await harness.bootstrapKey(["alerts:read"])

		const list = await harness.request("GET", "/v2/alerts/rules", readOnly.secret)
		expect(list.status).toBe(200)

		const create = await harness.request("POST", "/v2/alerts/rules", readOnly.secret, {
			name: "Denied",
			severity: "warning",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.5,
			window_minutes: 5,
			destination_ids: [],
		})
		expect(create.status).toBe(403)
		expect(create.body.error).toMatchObject({ type: "permission_error", code: "insufficient_scope" })

		// The /v2/alerts/* namespace is one scope family: alerts:read spans all three groups...
		const destinations = await harness.request("GET", "/v2/alerts/destinations", readOnly.secret)
		expect(destinations.status).toBe(200)

		// ...but another family's scope grants nothing here.
		const foreign = await harness.bootstrapKey(["dashboards:read"])
		const denied = await harness.request("GET", "/v2/alerts/destinations", foreign.secret)
		expect(denied.status).toBe(403)
		expect(denied.body.error).toMatchObject({ type: "permission_error", code: "insufficient_scope" })

		const malformed = await harness.request("GET", "/v2/alerts/rules/dash_notARuleId", readOnly.secret)
		expect(malformed.status).toBe(400)
		expect(malformed.body.error).toMatchObject({ type: "invalid_request_error" })

		await harness.dispose()
	})

	const createWebhook = (harness: ReturnType<typeof makeHarness>, token: string, name: string) =>
		harness.request("POST", "/v2/alerts/destinations", token, {
			type: "webhook",
			name,
			url: `https://example.com/hooks/${name}`,
		})

	it("runs escalation chain CRUD and refuses to delete a chain a rule tier names", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const primary = await createWebhook(harness, key.secret, "primary")
		const secondary = await createWebhook(harness, key.secret, "secondary")
		const steps = [
			{ targets: [{ type: "destination", destination_id: primary.body.id }], wait_minutes: 10 },
			{ targets: [{ type: "destination", destination_id: secondary.body.id }], wait_minutes: 15 },
		]

		const created = await harness.request("POST", "/v2/alerts/escalation_chains", key.secret, {
			name: "Checkout on-call",
			steps,
			repeat_count: 1,
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)
		expect(created.body).toMatchObject({
			object: "escalation_chain",
			name: "Checkout on-call",
			description: null,
			steps,
			repeat_count: 1,
			rule_ids: [],
		})
		expect(created.body.id).toMatch(/^esc_/)
		const chainId: string = created.body.id

		const listed = await harness.request("GET", "/v2/alerts/escalation_chains", key.secret)
		expect(listed.status).toBe(200)
		expect(listed.body).toMatchObject({ object: "list", has_more: false })
		expect(listed.body.data.map((chain: { id: string }) => chain.id)).toEqual([chainId])

		const rule = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Checkout errors",
			signal_type: "error_rate",
			comparator: "gt",
			window_minutes: 5,
			thresholds: [
				{
					severity: "critical",
					value: 0.05,
					destination_ids: [primary.body.id],
					escalation_chain_id: chainId,
				},
			],
		})
		expect(rule.status, JSON.stringify(rule.body)).toBe(200)
		expect(rule.body.thresholds[0].escalation_chain_id).toBe(chainId)

		// A PATCH that leaves the tiers alone keeps the chain on them.
		const toggled = await harness.request("PATCH", `/v2/alerts/rules/${rule.body.id}`, key.secret, {
			enabled: false,
		})
		expect(toggled.status).toBe(200)
		expect(toggled.body.thresholds[0].escalation_chain_id).toBe(chainId)

		const fetched = await harness.request("GET", `/v2/alerts/escalation_chains/${chainId}`, key.secret)
		expect(fetched.status).toBe(200)
		expect(fetched.body.rule_ids).toEqual([rule.body.id])

		const renamed = await harness.request(
			"PATCH",
			`/v2/alerts/escalation_chains/${chainId}`,
			key.secret,
			{
				name: "Checkout paging",
				repeat_count: 0,
				steps: [steps[1]],
			},
		)
		expect(renamed.status, JSON.stringify(renamed.body)).toBe(200)
		expect(renamed.body).toMatchObject({ name: "Checkout paging", repeat_count: 0, steps: [steps[1]] })

		const inUse = await harness.request("DELETE", `/v2/alerts/escalation_chains/${chainId}`, key.secret)
		expect(inUse.status).toBe(409)
		expect(inUse.body.error.code).toBe("escalation_chain_in_use")

		// A client that predates chains edits the tiers without the field: the chain stays.
		const retuned = await harness.request("PATCH", `/v2/alerts/rules/${rule.body.id}`, key.secret, {
			thresholds: [{ severity: "critical", value: 0.06, destination_ids: [primary.body.id] }],
		})
		expect(retuned.status, JSON.stringify(retuned.body)).toBe(200)
		expect(retuned.body.thresholds[0]).toMatchObject({ value: 0.06, escalation_chain_id: chainId })

		const detached = await harness.request("PATCH", `/v2/alerts/rules/${rule.body.id}`, key.secret, {
			thresholds: [
				{
					severity: "critical",
					value: 0.05,
					destination_ids: [primary.body.id],
					escalation_chain_id: null,
				},
			],
		})
		expect(detached.status).toBe(200)
		expect(detached.body.thresholds[0].escalation_chain_id).toBeNull()

		const deleted = await harness.request("DELETE", `/v2/alerts/escalation_chains/${chainId}`, key.secret)
		expect(deleted.status, JSON.stringify(deleted.body)).toBe(200)
		expect(deleted.body).toEqual({ id: chainId, object: "escalation_chain", deleted: true })

		const gone = await harness.request("GET", `/v2/alerts/escalation_chains/${chainId}`, key.secret)
		expect(gone.status).toBe(404)
		expect(gone.body.error.code).toBe("escalation_chain_not_found")

		await harness.dispose()
	})

	it("rejects escalation chains with unknown destinations or bad steps, and rules naming an unknown chain", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const primary = await createWebhook(harness, key.secret, "primary")
		const post = (body: unknown) =>
			harness.request("POST", "/v2/alerts/escalation_chains", key.secret, body)
		const step = (destinationId: string, waitMinutes = 10) => ({
			targets: [{ type: "destination", destination_id: destinationId }],
			wait_minutes: waitMinutes,
		})

		const unknownDestination = await post({
			name: "Ghost",
			steps: [step(encodePublicId("dest", "0b8f7c1e-2f61-4f1e-9d2a-3c4b5d6e7f80"))],
		})
		const noSteps = await post({ name: "Empty", steps: [] })
		const noWait = await post({ name: "Instant", steps: [step(primary.body.id, 0)] })
		const tooManyRepeats = await post({ name: "Loop", steps: [step(primary.body.id)], repeat_count: 6 })
		for (const response of [unknownDestination, noSteps, noWait, tooManyRepeats]) {
			expect(response.status, JSON.stringify(response.body)).toBe(400)
			expect(response.body.error.type).toBe("invalid_request_error")
		}

		const unknownChain = encodePublicId("esc", "0b8f7c1e-2f61-4f1e-9d2a-3c4b5d6e7f80")
		const missing = await harness.request(
			"PATCH",
			`/v2/alerts/escalation_chains/${unknownChain}`,
			key.secret,
			{
				name: "Nope",
			},
		)
		expect(missing.status).toBe(404)

		const rule = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Unknown chain",
			signal_type: "error_rate",
			comparator: "gt",
			window_minutes: 5,
			thresholds: [
				{
					severity: "critical",
					value: 0.05,
					destination_ids: [primary.body.id],
					escalation_chain_id: unknownChain,
				},
			],
		})
		expect(rule.status).toBe(400)
		expect(rule.body.error.type).toBe("invalid_request_error")

		const readOnly = await harness.bootstrapKey(["alerts:read"])
		const denied = await harness.request("POST", "/v2/alerts/escalation_chains", readOnly.secret, {
			name: "Denied",
			steps: [step(primary.body.id)],
		})
		expect(denied.status).toBe(403)

		await harness.dispose()
	})

	it("names the step field and what is wrong when escalation chain steps are empty or too long", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const primary = await createWebhook(harness, key.secret, "primary")
		const target = { type: "destination", destination_id: primary.body.id }
		const step = { targets: [target], wait_minutes: 10 }
		const created = await harness.request("POST", "/v2/alerts/escalation_chains", key.secret, {
			name: "Paging",
			steps: [step],
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)
		const post = (body: unknown) =>
			harness.request("POST", "/v2/alerts/escalation_chains", key.secret, body)
		const patch = (body: unknown) =>
			harness.request("PATCH", `/v2/alerts/escalation_chains/${created.body.id}`, key.secret, body)

		const responses = await Promise.all([
			post({ name: "Empty", steps: [] }),
			post({ name: "No targets", steps: [{ targets: [], wait_minutes: 10 }] }),
			post({ name: "Long", steps: Arr.makeBy(11, () => step) }),
			post({ name: "Wide", steps: [{ targets: Arr.makeBy(11, () => target), wait_minutes: 10 }] }),
			patch({ steps: [] }),
			patch({ steps: [step, { targets: [], wait_minutes: 5 }] }),
		])
		expect(
			Arr.map(responses, (response) => [
				response.status,
				response.body.error.param,
				response.body.error.message,
			]),
		).toEqual([
			[400, "steps", "steps: needs at least one step"],
			[400, "steps[0].targets", "steps[0].targets: needs at least one target"],
			[400, "steps", "steps: allows at most 10 steps"],
			[400, "steps[0].targets", "steps[0].targets: allows at most 10 targets per step"],
			[400, "steps", "steps: needs at least one step"],
			[400, "steps[1].targets", "steps[1].targets: needs at least one target"],
		])

		await harness.dispose()
	})

	it("refuses to delete a destination only an escalation chain uses, naming chains in the conflict", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const primary = await createWebhook(harness, key.secret, "primary")
		const chain = await harness.request("POST", "/v2/alerts/escalation_chains", key.secret, {
			name: "Chain only",
			steps: [
				{ targets: [{ type: "destination", destination_id: primary.body.id }], wait_minutes: 10 },
			],
		})
		expect(chain.status, JSON.stringify(chain.body)).toBe(200)

		const conflicted = await harness.request(
			"DELETE",
			`/v2/alerts/destinations/${primary.body.id}`,
			key.secret,
		)
		expect([conflicted.status, conflicted.body.error.code, conflicted.body.error.message]).toEqual([
			409,
			"alert_destination_in_use",
			"The alert destination is currently used by one or more alert rules or escalation chains.",
		])

		await harness.dispose()
	})

	it("creates, lists, extends and ends an alert silence", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const { rule } = await createWebhookAndRule(harness, key.secret)

		const created = await harness.request("POST", "/v2/alerts/silences", key.secret, {
			reason: "Deploying checkout v2.3",
			matchers: { rule_ids: [rule.body.id], services: ["checkout"] },
			duration_minutes: 60,
		})
		expect(created.status).toBe(200)
		expect(created.body).toMatchObject({
			object: "alert_silence",
			status: "active",
			matchers: { rule_ids: [rule.body.id], services: ["checkout"] },
		})
		expect(created.body.id).toMatch(/^sil_/)
		expect(Date.parse(created.body.ends_at) - Date.parse(created.body.starts_at)).toBe(60 * 60_000)
		const id: string = created.body.id

		const active = await harness.request("GET", "/v2/alerts/silences?status=active", key.secret)
		expect(active.body.data.map((silence: { id: string }) => silence.id)).toEqual([id])

		const endsAt = new Date(Date.parse(created.body.ends_at) + 60 * 60_000).toISOString()
		const extended = await harness.request("PATCH", `/v2/alerts/silences/${id}`, key.secret, {
			ends_at: endsAt,
		})
		expect(extended.status).toBe(200)
		expect(extended.body.ends_at).toBe(endsAt)

		const ended = await harness.request("POST", `/v2/alerts/silences/${id}/end`, key.secret)
		expect(ended.status).toBe(200)
		expect(ended.body.status).toBe("ended")
		const stillActive = await harness.request("GET", "/v2/alerts/silences?status=active", key.secret)
		expect(stillActive.body.data).toEqual([])

		const unknownId = Schema.encodeSync(AlertSilencePublicId)(
			Schema.decodeSync(AlertSilenceId)("0b8f7c1e-2f61-4f1e-9d2a-3c4b5d6e7f80"),
		)
		const missing = await harness.request("GET", `/v2/alerts/silences/${unknownId}`, key.secret)
		expect(missing.status).toBe(404)

		await harness.dispose()
	})

	it("rejects a silence without a matcher, an end or a sensible window", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const post = (body: unknown) => harness.request("POST", "/v2/alerts/silences", key.secret, body)

		const noMatcher = await post({ reason: "x", matchers: {}, duration_minutes: 10 })
		const noEnd = await post({ reason: "x", matchers: { tags: ["db"] } })
		const both = await post({
			reason: "x",
			matchers: { tags: ["db"] },
			duration_minutes: 10,
			ends_at: new Date(Date.now() + 60_000).toISOString(),
		})
		const tooLong = await post({
			reason: "x",
			matchers: { tags: ["db"] },
			duration_minutes: 31 * 24 * 60,
		})
		const ended = await post({
			reason: "x",
			matchers: { tags: ["db"] },
			ends_at: new Date(Date.now() - 60_000).toISOString(),
		})
		for (const response of [noMatcher, noEnd, both, tooLong, ended]) {
			expect(response.status).toBe(400)
			expect(response.body.error.type).toBe("invalid_request_error")
		}

		const readOnly = await harness.bootstrapKey(["alerts:read"])
		const denied = await harness.request("POST", "/v2/alerts/silences", readOnly.secret, {
			reason: "x",
			matchers: { tags: ["db"] },
			duration_minutes: 10,
		})
		expect(denied.status).toBe(403)

		await harness.dispose()
	})
})
