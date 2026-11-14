import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { OrgId, UserId, type TenantContext } from "@maple/domain/http"
import { SETUP_AUDIT_CHECKS } from "./setup-audit"
import { compiledQueryOf } from "@maple/query-engine/execution"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import { SignalPresenceService } from "@maple/backend/services/org/SignalPresenceService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => {
	rowsBySql = []
	return cleanupTestDbs(trackedDbs)
})

const ORG = Schema.decodeSync(OrgId)("org_setup_audit")
const USER = Schema.decodeSync(UserId)("user_setup_audit")
const tenant: TenantContext = { orgId: ORG, userId: USER, roles: ["org:admin"], authMode: "self_hosted" }

type Probe = "present" | "absent" | "unavailable"

const signalPresence = (probe: Probe) =>
	Layer.succeed(SignalPresenceService, {
		read: () =>
			Effect.succeed({
				generatedAt: 0,
				windowStart: 0,
				windowEnd: 0,
				warehouseAvailable: probe !== "unavailable",
				signals: [
					{
						signal: "traces",
						status: probe === "unavailable" ? "unknown" : probe,
						count: probe === "present" ? 1 : 0,
						firstSeen: null,
						lastSeen: null,
					},
					{
						signal: "sessions",
						status: probe === "unavailable" ? "unknown" : "present",
						count: 1,
						firstSeen: null,
						lastSeen: null,
					},
				],
			}),
	})

/** The SQL of each warehouse query the last audit ran, by its `context`. */
const sqlByContext = new Map<string, string>()

/** Rows served to any query whose SQL contains the key; everything else returns no rows. */
let rowsBySql: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]> = []
const allSql: Array<string> = []

const warehouse = Layer.succeed(
	WarehouseQueryService,
	makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled, options) => {
			const query = compiledQueryOf(compiled)
			if (options?.context) sqlByContext.set(options.context, query.sql)
			allSql.push(query.sql)
			const rows = Option.match(
				Arr.findFirst(rowsBySql, ([needle]) => Str.includes(needle)(query.sql)),
				{ onNone: () => [], onSome: ([, served]) => served },
			)
			return query.decodeRows(rows).pipe(Effect.orDie)
		},
	}),
)

const ORG_CREATED_AT = Date.UTC(2025, 0, 1)

const organizations = Layer.succeed(OrganizationService, {
	retrieve: (orgId) =>
		Effect.succeed({ id: orgId, name: null, slug: null, imageUrl: null, createdAtMs: ORG_CREATED_AT }),
})

const makeLayer = (testDb: TestDb, probe: Probe) =>
	Layer.effect(SetupAuditService, SetupAuditService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				warehouse,
				signalPresence(probe),
				OnboardingService.layer,
				organizations,
				IntegrationInventoryService.layer,
			),
		),
		Layer.provideMerge(testDb.layer),
	)

const firstDataInDb = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ first_data_received_at: Date | null; created_at: Date }>(
			testDb,
			`SELECT first_data_received_at, created_at FROM org_onboarding_state WHERE org_id = $1`,
			[ORG],
		),
	)

const seedUnstampedRow = (testDb: TestDb) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO org_onboarding_state (org_id, demo_data_requested, created_at, updated_at)
			 VALUES ($1, false, now(), now())`,
			[ORG],
		),
	)

describe("SetupAuditService first-data stamping", () => {
	it.effect("runs the audit and stamps the row when an unstamped org has telemetry", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedUnstampedRow(testDb)
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			assert.strictEqual(report.dataStatus, "ok")
			assert.isAbove(report.checks.length, 0)
			const row = yield* firstDataInDb(testDb)
			assert.isNotNull(row?.first_data_received_at ?? null)
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})

	it.effect("creates the row dated by the org's creation time when the org has no onboarding state", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			assert.strictEqual(report.dataStatus, "ok")
			const row = yield* firstDataInDb(testDb)
			assert.isNotNull(row?.first_data_received_at ?? null)
			assert.strictEqual(row?.created_at.getTime(), ORG_CREATED_AT)
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})

	it.effect("keeps no_data and leaves the row unstamped when the org has no telemetry", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedUnstampedRow(testDb)
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			assert.strictEqual(report.dataStatus, "no_data")
			assert.strictEqual(report.checks.length, 0)
			const row = yield* firstDataInDb(testDb)
			assert.isNull(row?.first_data_received_at ?? null)
		}).pipe(Effect.provide(makeLayer(testDb, "absent")))
	})

	it.effect(
		"runs the config checks, skips telemetry checks, and leaves the row unstamped when the probe cannot read the warehouse",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* seedUnstampedRow(testDb)
				const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
				assert.strictEqual(report.dataStatus, "ok")
				assert.isFalse(report.warehouseAvailable)
				const skipped = Arr.map(
					Arr.filter(report.checks, (row) => row.status === "skip"),
					(row) => row.id,
				)
				const needsWarehouse = Arr.filter(SETUP_AUDIT_CHECKS, (row) => row.needsWarehouse === true)
				assert.deepStrictEqual(
					skipped,
					Arr.map(needsWarehouse, (row) => row.id),
				)
				assert.isAbove(report.checks.length, skipped.length)
				const row = yield* firstDataInDb(testDb)
				assert.isNull(row?.first_data_received_at ?? null)
			}).pipe(Effect.provide(makeLayer(testDb, "unavailable")))
		},
	)
})

describe("SetupAuditService ingest sampling", () => {
	const seedSamplingPolicy = (testDb: TestDb, ratio: number) =>
		Effect.promise(() =>
			executeSql(
				testDb,
				`INSERT INTO org_ingest_sampling_policies (org_id, trace_sample_ratio, always_keep_error_spans, always_keep_slow_spans_ms)
				 VALUES ($1, $2, true, 2000)`,
				[ORG, ratio],
			),
		)

	const rootlessSql = (testDb: TestDb, ratio: number) =>
		Effect.gen(function* () {
			sqlByContext.clear()
			yield* seedSamplingPolicy(testDb, ratio)
			yield* SetupAuditService.use((audit) => audit.run(tenant))
			return sqlByContext.get("setupAuditRootlessTraces") ?? ""
		}).pipe(Effect.provide(makeLayer(testDb, "present")))

	it.effect("treats the spans the ingest sampler keeps as sampled when it drops traces", () =>
		Effect.gen(function* () {
			const sql = yield* rootlessSql(createTestDb(trackedDbs), 0.25)
			assert.include(sql, "traces.StatusCode = 'Error' OR traces.Duration >= 2000000000")
		}),
	)

	it.effect("ignores the keep rules when the ingest sampler keeps every trace", () =>
		Effect.gen(function* () {
			const sql = yield* rootlessSql(createTestDb(trackedDbs), 1)
			assert.include(sql, "unkeptSpans")
			assert.notInclude(sql, "Duration >=")
		}),
	)
})

describe("SetupAuditService alert routing reads", () => {
	const DEST_OFF = "00000000-0000-4000-8000-000000000001"
	const RULE_DISABLED_ROUTE = "00000000-0000-4000-8000-000000000002"
	const RULE_CHAIN = "00000000-0000-4000-8000-000000000003"
	const seed = (testDb: TestDb) =>
		Effect.promise(async () => {
			await executeSql(
				testDb,
				`INSERT INTO alert_destinations
				   (id, org_id, name, type, enabled, config_json, secret_ciphertext, secret_iv, secret_tag,
				    consecutive_failures, disabled_at, disabled_reason, created_at, updated_at, created_by, updated_by)
				 VALUES ($1, $2, 'pager', 'webhook', false, '{}'::jsonb, '', '', '',
				         5, now() - interval '2 hours', 'channel_not_found', now(), now(), $3, $3)`,
				[DEST_OFF, ORG, USER],
			)
			const insertRule = (
				id: string,
				name: string,
				destinationIds: ReadonlyArray<string>,
				thresholds: unknown,
			) =>
				executeSql(
					testDb,
					`INSERT INTO alert_rules
					   (id, org_id, name, enabled, severity, signal_type, comparator, threshold, window_minutes,
					    destination_ids_json, thresholds_json, reducer, no_data_behavior, last_scheduled_at,
					    created_at, updated_at, created_by, updated_by)
					 VALUES ($1, $2, $6, true, 'warning', 'error_rate', 'gt', 0.05, 5,
					         $3::jsonb, $4::jsonb, 'avg', 'skip', now(), now(), now(), $5, $5)`,
					[
						id,
						ORG,
						JSON.stringify(destinationIds),
						thresholds === null ? null : JSON.stringify(thresholds),
						USER,
						name,
					],
				)
			await insertRule(RULE_DISABLED_ROUTE, "routes-to-disabled", [DEST_OFF], null)
			await insertRule(
				RULE_CHAIN,
				"pages-a-chain",
				[],
				[
					{
						severity: "warning",
						value: 0.05,
						upper: null,
						recoveryValue: null,
						destinationIds: [],
						escalationChainId: "chain-1",
					},
				],
			)
		})

	it.effect("reports a destination Maple auto-disabled, and treats an escalation chain as a route", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seed(testDb)
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			const byId = (id: string) =>
				Option.getOrUndefined(Arr.findFirst(report.checks, (row) => row.id === id))
			const delivery = byId("CFG-ALERT-04")
			assert.strictEqual(delivery?.status, "fail")
			assert.include(delivery?.affected[0]?.note ?? "", "channel_not_found")
			assert.deepStrictEqual(
				Arr.map(byId("CFG-ALERT-03")?.affected ?? [], (row) => row.name),
				["routes-to-disabled"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})
})

describe("SetupAuditService telemetry mapping", () => {
	const spanProfile = (serviceName: string, rootSpanName: string, rootSpanKind: string) => ({
		serviceName,
		weightedSpanCount: 500,
		weightedErrorCount: 0,
		serverCount: 0,
		consumerCount: 0,
		clientCount: 0,
		producerCount: 0,
		noEnvCount: 0,
		spanNameCount: 3,
		badStatusCodes: [],
		badSpanKinds: [],
		rootSpanNames: [rootSpanName],
		rootSpanKinds: [rootSpanKind],
	})

	it.effect("classifies services, names root spans and attributes invented keys to their emitter", () => {
		const testDb = createTestDb(trackedDbs)
		rowsBySql = [
			[
				"FROM traces_aggregates_hourly",
				[
					spanProfile("reviews", "ReviewQueue.processMessage", "Internal"),
					spanProfile("maple-uptime", "GET /health", "Client"),
					spanProfile("web", "foldkit.view", "Internal"),
				],
			],
			[
				"FROM service_overview_hourly\n",
				[
					{ serviceName: "reviews", namespaces: ["core"], environments: ["production"] },
					{ serviceName: "maple-uptime", namespaces: ["maple-services"], environments: [] },
					{ serviceName: "web", namespaces: ["core"], environments: ["production"] },
				],
			],
			["FROM service_runtimes_hourly", [{ serviceName: "web", sdkLanguages: ["webjs"] }]],
			[
				"FROM attribute_keys_hourly",
				[{ scope: "resource", attributeKey: "deployment.commit_sha", usageCount: 40 }],
			],
			[
				"AttributeScope = 'resource'",
				[{ attributeKey: "deployment.commit_sha", attributeValue: "0.1.0+685", usageCount: 40 }],
			],
			[
				"mapContains(traces.ResourceAttributes",
				[{ serviceName: "ios", keyCounts: ["32"], duplicateCounts: ["0", "0"] }],
			],
		]
		return Effect.gen(function* () {
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			const byId = (id: string) =>
				Option.getOrUndefined(Arr.findFirst(report.checks, (row) => row.id === id))
			assert.deepStrictEqual(byId("STAT-04")?.affected, [
				{
					kind: "service",
					name: "reviews",
					note: 'traces start at "ReviewQueue.processMessage" (Internal), not a Server or Consumer span',
				},
			])
			assert.strictEqual(
				byId("RES-06")?.affected[0]?.note,
				'from ios; e.g. "0.1.0+685"; holds a version, so send it as `service.version`',
			)
			// Maple's own services never reach the raw log read.
			const logRead = Arr.findFirst(allSql, Str.includes("FROM logs\n"))
			assert.include(
				Option.getOrElse(logRead, () => ""),
				"ServiceName NOT IN ('maple-uptime', 'github-actions')",
			)
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})

	it.effect("says remove a duplicated key and names who sends a sensitive span key", () => {
		const testDb = createTestDb(trackedDbs)
		sqlByContext.clear()
		const secret = "http.request.header.x-maple-maintenance-token"
		rowsBySql = [
			[
				"FROM attribute_keys_hourly",
				[
					{ scope: "resource", attributeKey: "deployment.commit_sha", usageCount: 40 },
					{ scope: "span", attributeKey: secret, usageCount: 4 },
				],
			],
			[
				"SpanName AS spanName",
				[{ serviceName: "cli", spanName: "http.client POST", keyCounts: ["4"] }],
			],
			[
				"mapContains(traces.ResourceAttributes",
				[{ serviceName: "ios", keyCounts: ["32"], duplicateCounts: ["0", "32"] }],
			],
		]
		return Effect.gen(function* () {
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			const byId = (id: string) =>
				Option.getOrUndefined(Arr.findFirst(report.checks, (row) => row.id === id))
			// The second pair compares the commit key with `service.version`.
			assert.strictEqual(
				byId("RES-06")?.affected[0]?.note,
				"same value as its `service.version`, so remove this key; from ios",
			)
			assert.strictEqual(byId("PII-01")?.affected[0]?.note, 'span; sent by cli on "http.client POST"')
			// The suspected secret's value is never selected.
			assert.isTrue(sqlByContext.has("setupAuditSensitiveKeyEmitters"))
			assert.notInclude(
				sqlByContext.get("setupAuditSensitiveKeyEmitters") ?? "",
				`SpanAttributes['${secret}']`,
			)
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})

	it.effect("reads log bodies only for the services LOG-02 quotes a message for", () => {
		const testDb = createTestDb(trackedDbs)
		allSql.length = 0
		const usage = (serviceName: string) => ({
			serviceName,
			totalLogCount: 1_000,
			totalLogSizeBytes: 0,
			totalTraceCount: 1_000,
			totalTraceSizeBytes: 0,
			totalSumMetricCount: 0,
			totalSumMetricSizeBytes: 0,
			totalGaugeMetricCount: 0,
			totalGaugeMetricSizeBytes: 0,
			totalHistogramMetricCount: 0,
			totalHistogramMetricSizeBytes: 0,
			totalExpHistogramMetricCount: 0,
			totalExpHistogramMetricSizeBytes: 0,
			totalSizeBytes: 0,
		})
		const correlation = (serviceName: string, uncorrelatedCount: number) => ({
			serviceName,
			logCount: 1_000,
			uncorrelatedCount,
			errorLogCount: 0,
			uncorrelatedErrorCount: 0,
			numberedOddSeverities: [],
			unnumberedOddSeverities: [],
		})
		rowsBySql = [
			["topK(1)(leftUTF8(Body", [{ serviceName: "api", topMessages: ["listening on :3000"] }]],
			["FROM service_usage", [usage("api"), usage("worker")]],
			// api correlates some logs (the bridge works); worker none (no bridge, no message needed).
			["FROM logs\n", [correlation("api", 950), correlation("worker", 1_000)]],
		]
		return Effect.gen(function* () {
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			const notes = Arr.map(
				Option.getOrUndefined(Arr.findFirst(report.checks, (row) => row.id === "LOG-02"))?.affected ??
					[],
				(entity) => entity.note,
			)
			assert.include(notes, '95% of logs are emitted outside any span, mostly: "listening on :3000"')
			const bodyReads = Arr.filter(allSql, Str.includes("leftUTF8(Body"))
			assert.strictEqual(bodyReads.length, 1)
			assert.include(bodyReads[0] ?? "", "logs.ServiceName IN ('api')")
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})

	it.effect("skips the raw attribution reads when no check flagged a key", () => {
		const testDb = createTestDb(trackedDbs)
		sqlByContext.clear()
		return Effect.gen(function* () {
			yield* SetupAuditService.use((audit) => audit.run(tenant))
			assert.isFalse(sqlByContext.has("setupAuditResourceKeyServices"))
			assert.isFalse(sqlByContext.has("setupAuditMetricLabelSeries"))
			assert.isFalse(sqlByContext.has("setupAuditInboundRoutes"))
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})

	it.effect(
		"confirms label cardinality per metric, release keys per service and outside callers' routes",
		() => {
			const testDb = createTestDb(trackedDbs)
			sqlByContext.clear()
			const rootless = (
				entryService: string,
				externalParentCount: number,
				externalTraceIds: ReadonlyArray<string>,
			) => ({
				entryService,
				traceCount: 7_000,
				rootlessCount: externalParentCount,
				sampledRootlessCount: 0,
				externalParentCount,
				externalTraceIds,
				orgTraceCount: 14_000,
				orgRootlessCount: 44,
				orgSampledRootlessCount: 0,
				orgExternalParentCount: 44,
			})
			rowsBySql = [
				[
					"FROM service_overview_hourly\n",
					[
						{ serviceName: "api", namespaces: [], environments: ["production"] },
						{ serviceName: "landing", namespaces: [], environments: ["production"] },
					],
				],
				["FROM service_runtimes_hourly", [{ serviceName: "landing", sdkLanguages: ["webjs"] }]],
				[
					"AttributeScope = 'metric'",
					[{ attributeKey: "url.path", valueCardinality: 3_383, usageCount: 100 }],
				],
				[
					"FROM metrics_sum",
					[
						{
							serviceName: "api",
							metricName: "http.requests.by_path",
							valueCardinalities: ["1500"],
						},
					],
				],
				[
					"traces.IsEntryPoint = 1",
					[
						{ serviceName: "api", spanCount: 10, keyCounts: [10, 10, 10] },
						{ serviceName: "landing", spanCount: 5, keyCounts: [0, 0, 0] },
					],
				],
				["AS entryService", [rootless("api", 44, ["t1", "t2"]), rootless("cli", 0, [])]],
				["AS route", [{ serviceName: "api", route: "/mcp", traceCount: 2 }]],
			]
			return Effect.gen(function* () {
				const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
				const byId = (id: string) =>
					Option.getOrUndefined(Arr.findFirst(report.checks, (row) => row.id === id))
				assert.strictEqual(
					byId("MET-01")?.affected[0]?.note,
					"~1,500 values on `http.requests.by_path` (api)",
				)
				// Maple's integration services fold into one row per prefix, so they cannot fill the row cap.
				assert.include(
					sqlByContext.get("setupAuditMetricLabelSeries") ?? "",
					"multiIf(metrics_sum.ServiceName LIKE 'cloudflare/%', 'cloudflare/'",
				)
				assert.deepStrictEqual(
					Arr.map(byId("RES-02")?.affected ?? [], (entity) => entity.name),
					["landing"],
				)
				// Only the services that reported outside callers, and only their sampled trace ids.
				const routesSql = sqlByContext.get("setupAuditInboundRoutes") ?? ""
				assert.include(routesSql, "traces.ServiceName IN ('api')")
				assert.include(routesSql, "traces.TraceId IN ('t1', 't2')")
				assert.strictEqual(
					byId("TRC-04")?.affected[0]?.note,
					"44 traces started by an outside caller, mostly via `/mcp`",
				)
				assert.strictEqual(byId("TRC-02")?.status, "pass")
			}).pipe(Effect.provide(makeLayer(testDb, "present")))
		},
	)
})

describe("Cloudflare unavailable dataset audit projection", () => {
	it.effect("keeps unavailable disabled datasets visible and available errors failing", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			for (const [id, dataset, enabled, settings] of [
				["cf-unavailable", "firewall_events", false, { enabled: false, maxDuration: 0 }],
				["cf-available", "http_requests", true, { enabled: true, maxDuration: 3600 }],
			] as const) {
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`INSERT INTO cloudflare_analytics_state (id, org_id, dataset, zone_id, zone_name, enabled, settings_json, last_error, last_error_at, created_at, updated_at)
					 VALUES ($1, $2, $3, 'zone-audit', 'example.com', $4, $5, 'upstream timeout', now(), now(), now())`,
						[id, ORG, dataset, enabled, JSON.stringify(settings)],
					),
				)
			}
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			const check = report.checks.find((check) => check.id === "CFG-INTEG-02")!
			assert.strictEqual(check.status, "fail")
			assert.include(check.detail!, "1 unavailable")
			assert.isTrue(
				check.affected.some(
					(entity) =>
						entity.name === "firewall_events · example.com" &&
						entity.note?.includes("unavailable"),
				),
			)
			assert.isTrue(
				check.affected.some(
					(entity) =>
						entity.name === "http_requests · example.com" &&
						entity.note?.includes("upstream timeout"),
				),
			)
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})
})
