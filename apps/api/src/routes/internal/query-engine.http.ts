// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import { HttpApiBuilder } from "effect/http-api"
import { mergeSupabaseSeries } from "./supabase-infra-series"
import { apiTrafficResponse, mergeSupabaseCallers, mergeSupabaseProjects } from "./supabase-insights-merge"
import {
	CurrentTenant,
	MapleInternalApi,
	RawSqlExecuteResponse,
	SpanHierarchyResponse,
	SpanDetailResponse,
	TraceSpanEventsResponse,
	ErrorsByTypeResponse,
	ErrorsSparkResponse,
	ErrorsSummaryResponse,
	ErrorDetailTracesResponse,
	ErrorRateByServiceResponse,
	ServiceOverviewResponse,
	ServiceHealthSnapshotResponse,
	ServiceHealthBaselineResponse,
	ServiceApdexResponse,
	PlanetScaleInfraTimeseriesResponse,
	RailwayInfraRowsResponse,
	VercelAiGatewayResponse,
	VercelAuditLogResponse,
	VercelInfraDependenciesResponse,
	VercelInfraFunctionsResponse,
	VercelInfraProjectDetailResponse,
	VercelInfraProjectsResponse,
	VercelInfraRequestTimeseriesResponse,
	VercelInfraLatencyTimeseriesResponse,
	VercelInfraBreakdownResponse,
	VercelSpeedInsightsResponse,
	VercelWebAnalyticsResponse,
	SupabaseInfraRowsResponse,
	SupabaseApiPath,
	SupabaseApiTopPathsResponse,
	SupabaseLogIssue,
	SupabaseLogIssuesResponse,
	SupabaseProjectCallersResponse,
	AwsInfraMetricsResponse,
	AwsInfraPresenceResponse,
	AwsInfraSparklinesResponse,
	AwsInfraTimeseriesResponse,
	GcpInfraMetricsResponse,
	GcpInfraPresenceResponse,
	GcpInfraSparklinesResponse,
	GcpCloudSqlDatabasesResponse,
	GcpCloudSqlStatementSpansResponse,
	GcpCloudSqlTopQueriesResponse,
	GcpInfraTimeseriesResponse,
	ServiceCloudflareStatsResponse,
	ServicePlanetScaleStatsResponse,
	CloudflareInfraZonesResponse,
	CloudflareInfraZoneTimeseriesResponse,
	CloudflareInfraZoneDetailResponse,
	CloudflareInfraWorkerDetailResponse,
	CloudflareInfraZoneSecurityResponse,
	CloudflareInfraZoneBreakdownResponse,
	CloudflareInfraZoneDnsResponse,
	CloudflareInfraZoneFacetsResponse,
	CloudflareInfraPlatformResourcesResponse,
	CloudflareInfraWorkersResponse,
	ServiceDbQuerySummaryResponse,
	ServiceDetailOverviewResponse,
	ReleasesListResponse,
	UptimeChecksResponse,
	UptimePhaseTimingsResponse,
	ReleaseDetailResponse,
	type ReleaseRow,
	ServiceDependenciesBundleResponse,
	ServiceMapBundleResponse,
	ServiceWorkloadsResponse,
	ServiceRuntimesResponse,
	ServiceUsageResponse,
	ServiceEndpointsResponse,
	ServiceApiOverviewResponse,
	ServiceEndpointsTimeseriesResponse,
	ServiceEndpointStatusBreakdownResponse,
	ServiceEndpointDetailResponse,
	ServiceOperationsResponse,
	ListLogsResponse,
	GetLogResponse,
	ListMetricsResponse,
	MetricsSummaryResponse,
	InfraPresenceResponse,
	InfraSurfaceLiteral,
	ListHostsResponse,
	HostDetailSummaryResponse,
	HostInfraTimeseriesResponse,
	ListPodsResponse,
	PodsSummaryResponse,
	PodDetailSummaryResponse,
	PodRestartsResponse,
	PodInfraTimeseriesResponse,
	PodFacetsResponse,
	ListContainersResponse,
	ContainersSummaryResponse,
	ContainerDetailSummaryResponse,
	ContainerInfraTimeseriesResponse,
	ContainerFacetsResponse,
	ListNodesResponse,
	NodeDetailSummaryResponse,
	NodeInfraTimeseriesResponse,
	NodeFacetsResponse,
	ListWorkloadsResponse,
	WorkloadDetailSummaryResponse,
	WorkloadInfraTimeseriesResponse,
	WorkloadFacetsResponse,
	WebAnalyticsSummaryResponse,
	WebAnalyticsLiveResponse,
	WebAnalyticsTimeseriesResponse,
	WebAnalyticsPageviewsResponse,
	WebAnalyticsPagesResponse,
	WebAnalyticsEventsResponse,
	WebAnalyticsBreakdownsResponse,
	WebAnalyticsAiReferralsResponse,
	WebAnalyticsAiCrawlersResponse,
	SecurityExposureResponse,
	SecurityRuntimesResponse,
	ProductEventsFunnelResponse,
	ProductEventsFunnelBreakdownResponse,
	ProductEventsFunnelTimingResponse,
	ProductEventsFunnelLeaversResponse,
	ProductEventsPathsResponse,
	ProductEventNamesResponse,
	ProductEventsForTraceResponse,
	ProductEventTraceSamplesResponse,
	SearchConsoleLandingPagesResponse,
	SearchConsoleOverviewResponse,
	SearchConsoleTimeseriesResponse,
	SearchConsoleTopPagesResponse,
	SearchConsoleTopQueriesResponse,
	CommitSha,
	FingerprintHash,
	SpanName,
	StatusCode,
	type TenantContext,
} from "@maple/domain/http"
import { AWS_INFRA_KIND_IDS, AWS_INFRA_KINDS } from "@maple/domain/aws-infra"
import { GCP_INFRA_SERVICE_IDS, gcpInfraMetrics } from "@maple/domain/gcp-infra"
import { SESSION_LIVE_WINDOW_SECONDS } from "@maple/domain/query-engine"
import { isAiContentFormat } from "@maple/domain/ai-traffic"
import { DateTime, Duration, Effect, Option, Order, Schema, Array as Arr } from "effect"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import {
	isMissingProductEvents,
	isMissingServiceEndpointDetails,
	isMissingServiceMapDbEdgesMinutely,
} from "@maple/backend/services/warehouse/missing-table"
import type { QueryEngineDirectError } from "@maple/query-engine/runtime"
import { makeRunAuditedRawSql } from "@maple/backend/services/warehouse/audited-raw-sql"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	alignServiceApiBucketSeconds,
	CH,
	formatWarehouseDateTime,
	parseSpanEvents,
} from "@maple/query-engine"
import { QueryEngineExecuteBatchResponse } from "@maple/domain/query-engine"

import {
	containerMetricSpec,
	hostMetricSpec,
	nodeMetricSpec,
	podMetricSpec,
	toCloudflareFilters,
	validateFunnelDefinition,
	validatePathsDefinition,
	workloadMetricSpec,
} from "@maple/backend/queries/query-helpers"
import { Queries } from "@maple/backend/queries/registry"
import { isMapleService } from "@maple/domain/uptime"
import { productEventsFunnelOpts, productEventsPathsOpts } from "@maple/query-engine/registry"
import {
	makeDashboardReads,
	makeRollupFallback,
	mapExecError,
	withinBudget,
	withServiceApiFallback,
} from "@maple/backend/queries/dashboard-reads"
import { makeSearchConsoleReads } from "@maple/backend/queries/search-console-reads"
import { runQueryEngineBatch } from "@/routes/query-engine-batch"
import { RuntimeAdvisoryCatalog } from "@maple/backend/services/security/RuntimeAdvisoryCatalog"
import { RuntimeReleaseCatalog } from "@maple/backend/services/security/RuntimeReleaseCatalog"
import { advisoryTargetOf } from "@maple/domain/runtime-advisories"
import { attackStagesOf } from "@maple/domain/security-telemetry"
import { type RuntimeProduct, runtimeProductOf } from "@maple/domain/runtime-posture"
import * as Integrations from "@maple/query-engine-integrations"
import { CLOUDFLARE_BREAKDOWN_OTHER_KEY } from "@maple/domain/cloud-platform"
import { decodeTraceId, decodeSpanId, decodeServiceName } from "../warehouse-ids"
import { makeServeRows, serveData } from "./serve-rows"

/**
 * Payload → query-engine filter opts. Every Cloudflare zone endpoint carries the same optional
 * filter bag, and which of them a given panel can honor depends on the metric families it reads —
 * `Integrations.cloudflareIgnoredFiltersFor` answers that, and the answer ships in the response so the UI can
 * mark a panel zone-wide instead of pretending the filter applied.
 */

const withProductEventsFallback = makeRollupFallback(
	isMissingProductEvents,
	"product_events is absent on this cluster; reading raw session_events. Apply ClickHouse schema to restore the fast path.",
)

const withDbEdgesMinutelyFallback = makeRollupFallback(
	isMissingServiceMapDbEdgesMinutely,
	"service_map_db_edges_minutely is absent on this cluster; reading raw traces for the partial hours. Apply ClickHouse schema to restore the fast path.",
)

/**
 * The map's database edges are a decoration on the service graph, so they get a budget
 * under the request's own 30s: past it the map renders without them instead of 504ing.
 */
const DB_EDGES_BUDGET = Duration.seconds(12)

/** A list's denominator: the count query's total, or the rows on screen when that read failed or found none. */
const countOrRowCount = (count: number | undefined, rowCount: number): number =>
	count !== undefined && count > 0 ? count : rowCount

/** Endpoint detail has no raw fallback: without migration 0048 the panel is empty. */
const orEmptyWithoutEndpointDetails = <A, E, R>(effect: Effect.Effect<A, E, R>, empty: A) =>
	effect.pipe(
		Effect.catchIf(isMissingServiceEndpointDetails, () =>
			Effect.as(Effect.annotateCurrentSpan("query.rollup.missing", true), empty),
		),
	)

const emptyServiceApiTotals: CH.ServiceApiTotalsOutput = {
	spanCount: 0,
	estimatedSpanCount: 0,
	httpClassifiedSpanCount: 0,
	httpStatusCount: 0,
	http4xxCount: 0,
	http5xxCount: 0,
	requestBodyBytes: 0,
	requestBodyCount: 0,
	p50DurationMs: 0,
	p95DurationMs: 0,
	p99DurationMs: 0,
}

const toServiceApiBucket = (row: CH.ServiceApiTimeseriesOutput) => ({
	bucket: DateTime.formatIso(row.bucket),
	spanName: row.spanName,
	estimatedSpanCount: row.estimatedSpanCount,
	httpStatusCount: row.httpStatusCount,
	http4xxCount: row.http4xxCount,
	httpClassifiedSpanCount: row.httpClassifiedSpanCount,
	http5xxCount: row.http5xxCount,
	requestBodyBytes: row.requestBodyBytes,
	p50DurationMs: row.p50DurationMs,
	p95DurationMs: row.p95DurationMs,
	p99DurationMs: row.p99DurationMs,
})

const decodeSpanName = Schema.decodeUnknownSync(SpanName)
const decodeFingerprintHash = Schema.decodeUnknownSync(FingerprintHash)
const decodeCommitSha = Schema.decodeUnknownSync(CommitSha)

// Warehouse stores span status in Title Case (Ok/Error/Unset). Coerce any
// unexpected/empty value to "Unset" rather than throwing during response build.
const decodeStatusCodeOption = Schema.decodeUnknownOption(StatusCode)
const coerceStatusCode = (value: string): StatusCode =>
	Option.getOrElse(decodeStatusCodeOption(value), () => "Unset" as const)

const toServicePlatformRow = (row: CH.ServicePlatformsOutput) => {
	const k8sCluster = row.k8sCluster
	const k8sPodName = row.k8sPodName
	const k8sDeploymentName = row.k8sDeploymentName
	const cloudPlatform = row.cloudPlatform
	const cloudProvider = row.cloudProvider
	const faasName = row.faasName
	const mapleSdkType = row.mapleSdkType
	const processRuntimeName = row.processRuntimeName
	// cluster.name alone does not prove the service runs in Kubernetes.
	const isKubernetes = k8sPodName !== "" || k8sDeploymentName !== ""
	// Host infrastructure takes precedence over SDK self-report. Google Cloud's
	// detector sets `faas.name` on Cloud Run and Cloud Functions, so it is checked
	// before the Lambda rule.
	const platform: "kubernetes" | "cloudflare" | "gcp" | "vercel" | "lambda" | "web" | "unknown" =
		cloudPlatform === "cloudflare.workers" || cloudProvider === "cloudflare"
			? "cloudflare"
			: cloudProvider === "gcp"
				? "gcp"
				: cloudProvider === "vercel"
					? "vercel"
					: faasName !== "" || cloudPlatform === "aws_lambda"
						? "lambda"
						: isKubernetes
							? "kubernetes"
							: mapleSdkType === "client"
								? "web"
								: "unknown"
	return {
		serviceName: decodeServiceName(row.serviceName),
		platform,
		k8sCluster,
		cloudPlatform,
		cloudProvider,
		faasName,
		mapleSdkType,
		processRuntimeName,
	}
}

const toReleaseRow = (row: CH.ReleasesListOutput): ReleaseRow => {
	const spanCount = row.spanCount
	const satisfied = row.apdexSatisfiedCount
	const tolerating = row.apdexToleratingCount
	return {
		serviceName: decodeServiceName(row.serviceName),
		environment: row.environment,
		commitSha: decodeCommitSha(row.commitSha),
		firstSeen: DateTime.formatIso(row.firstSeen),
		spanCount,
		errorCount: row.errorCount,
		p50LatencyMs: row.p50LatencyMs,
		p95LatencyMs: row.p95LatencyMs,
		p99LatencyMs: row.p99LatencyMs,
		apdexScore:
			spanCount > 0 ? Math.round(((satisfied + tolerating * 0.5) / spanCount) * 10_000) / 10_000 : 0,
	}
}

const toReleaseTimelinePoint = (row: CH.ReleasesTimelineOutput) => ({
	bucket: DateTime.formatIso(row.bucket),
	serviceName: decodeServiceName(row.serviceName),
	commitSha: decodeCommitSha(row.commitSha),
	count: row.count,
})

const toServiceWorkloadRow = (row: CH.ServiceWorkloadsOutput) => ({
	serviceName: decodeServiceName(row.serviceName),
	workloadKind: row.workloadKind,
	workloadName: row.workloadName,
	namespace: row.namespace,
	clusterName: row.clusterName,
	podCount: row.podCount,
	avgCpuLimitUtilization: row.avgCpuLimitUtilization == null ? null : row.avgCpuLimitUtilization,
	avgMemoryLimitUtilization: row.avgMemoryLimitUtilization == null ? null : row.avgMemoryLimitUtilization,
})

const toServiceRuntimeRows = (
	rows: ReadonlyArray<CH.ServiceRuntimesOutput>,
	requested: ReadonlyArray<string>,
) =>
	Arr.map(CH.serviceRuntimeResources(rows, requested), (row) => ({
		...row,
		serviceName: decodeServiceName(row.serviceName),
	}))

export const HttpQueryEngineLive = HttpApiBuilder.group(MapleInternalApi, "queryEngine", (handlers) =>
	Effect.gen(function* () {
		const queryEngine = yield* QueryEngineService
		const warehouse = yield* WarehouseQueryService
		const runtimeReleases = yield* RuntimeReleaseCatalog
		const runtimeAdvisories = yield* RuntimeAdvisoryCatalog
		const reads = makeDashboardReads({ warehouse, queryEngine })
		const { runQuery, runQueryFirst } = reads
		const serve = makeServeRows(runQuery, runQueryFirst)
		const searchConsole = makeSearchConsoleReads({ warehouse, queryEngine })

		const dbEdgesWithinBudget = <A, P, E extends QueryEngineDirectError, R>(
			rollup: (tenant: TenantContext, payload: P) => Effect.Effect<ReadonlyArray<A>, E, R>,
			raw: (tenant: TenantContext, payload: P) => Effect.Effect<ReadonlyArray<A>, E, R>,
			tenant: TenantContext,
			payload: P,
		) =>
			withinBudget(withDbEdgesMinutelyFallback(rollup, raw, tenant, payload), DB_EDGES_BUDGET, [], {
				orgId: tenant.orgId,
				layer: "serviceDbEdges",
			})

		const runAuditedRawSql = makeRunAuditedRawSql(warehouse)

		return (
			handlers
				.handle("executeBatch", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Resolve the org's warehouse route + config ONCE for the batch.
						// Without it each item independently races resolveRuntimeConfig
						// and they contend — the same ordering problem the other
						// fan-out routes call warmRoute for.
						yield* warehouse.warmRoute(tenant)

						const results = yield* runQueryEngineBatch({
							requests: payload.requests,
							execute: (request) =>
								queryEngine
									.execute(tenant, request)
									.pipe(Effect.map((response) => response.result)),
						})
						return new QueryEngineExecuteBatchResponse({ results })
					}),
				)
				.handle("spanHierarchy", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const { rows } = yield* reads.spanHierarchy(tenant, payload)
						const typedRows = Arr.map(rows, (row) => ({
							...row,
							startTime: DateTime.formatIso(row.startTime),
							traceId: decodeTraceId(row.traceId),
							spanId: decodeSpanId(row.spanId),
							spanName: decodeSpanName(row.spanName),
							serviceName: decodeServiceName(row.serviceName),
							statusCode: coerceStatusCode(row.statusCode),
						}))
						return new SpanHierarchyResponse({ data: typedRows })
					}),
				)
				.handle("spanDetail", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.spanDetail, tenant, payload)
						if (!row) return new SpanDetailResponse({ data: null })
						// Events are read separately: the detail row resolves the span's
						// service and start second, which seek its granules.
						const startMs = DateTime.toEpochMillis(row.startTime)
						const events = yield* runQueryFirst(Queries.spanEvents, tenant, {
							traceId: row.traceId,
							spanId: row.spanId,
							serviceName: row.serviceName,
							spanName: row.rawSpanName,
							startTime: formatWarehouseDateTime(startMs),
							endTime: formatWarehouseDateTime(startMs + 1000),
						}).pipe(
							Effect.map((raw) => (raw ? parseSpanEvents(raw) : [])),
							// Events are supplementary; a failed lookup must not hide the attributes.
							Effect.tapError((error) => Effect.logWarning("span events lookup failed", error)),
							Effect.orElseSucceed(() => []),
						)
						return new SpanDetailResponse({
							data: {
								traceId: decodeTraceId(row.traceId),
								spanId: decodeSpanId(row.spanId),
								spanAttributes: row.spanAttributes,
								resourceAttributes: row.resourceAttributes,
								events,
							},
						})
					}),
				)
				.handle("traceSpanEvents", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.traceSpanEvents, tenant, payload)
						return new TraceSpanEventsResponse({
							data: Arr.flatMap(rows, (row) => {
								const events = Arr.map(parseSpanEvents(row), ({ name, offsetMs }) => ({
									name,
									offsetMs,
								}))
								return events.length === 0
									? []
									: [{ spanId: decodeSpanId(row.spanId), events }]
							}),
						})
					}),
				)
				.handle("errorsByType", serve.rows(Queries.errorsByType, ErrorsByTypeResponse))
				.handle("errorsSpark", serve.rows(Queries.errorsSpark, ErrorsSparkResponse))
				.handle("errorsSummary", serve.first(Queries.errorsSummary, ErrorsSummaryResponse))
				.handle("errorDetailTraces", serve.rows(Queries.errorDetailTraces, ErrorDetailTracesResponse))
				.handle(
					"errorRateByService",
					serve.rows(Queries.errorRateByService, ErrorRateByServiceResponse),
				)
				.handle("serviceOverview", serve.rows(Queries.serviceOverview, ServiceOverviewResponse))
				.handle("serviceHealthSnapshot", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* reads.serviceHealthSnapshot(tenant, payload)
						return new ServiceHealthSnapshotResponse({
							data: Arr.map(rows, (row) => ({
								serviceName: decodeServiceName(row.serviceName),
								environment: row.environment || "unknown",
								requestCount: row.requestCount,
								errorCount: row.errorCount,
								p95LatencyMs: row.p95LatencyMs,
							})),
						})
					}),
				)
				.handle(
					"serviceHealthBaseline",
					serveData(reads.serviceHealthBaseline, ServiceHealthBaselineResponse),
				)
				.handle("serviceApdex", serve.rows(Queries.serviceApdex, ServiceApdexResponse))
				.handle("serviceCloudflareStats", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Counters (metrics_sum) + percentiles (metrics_gauge) run
						// concurrently, then merge by ServiceName. Routed through the org's
						// configured warehouse exactly like the metric explorer reads these
						// same `cloudflare.*` metrics — no special ingest pin needed.
						yield* warehouse.warmRoute(tenant)
						const [counterRows, latencyRows] = yield* Effect.all(
							[
								runQuery(Queries.cloudflareServiceCounters, tenant, payload),
								runQuery(Queries.cloudflareServiceLatency, tenant, payload),
							],
							{ concurrency: 2 },
						)
						const latencyByService = new Map(
							Arr.map(latencyRows, (row) => [row.serviceName, row]),
						)
						const data = Arr.map(counterRows, (row) => {
							const latency = latencyByService.get(row.serviceName)
							return {
								serviceName: row.serviceName,
								requests: row.requests,
								errorCount: row.errorCount,
								latencyP99Ms: latency?.latencyP99Ms ?? 0,
								cpuP99Ms: latency?.cpuP99Ms ?? 0,
							}
						})
						return new ServiceCloudflareStatsResponse({ data })
					}),
				)
				.handle("servicePlanetScaleStats", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const byBranch = payload.database !== undefined
						// Utilization gauges + the two-level connections rollup run
						// concurrently, then merge by database(+branch). Routed through the
						// org's configured warehouse like the metric explorer reads the same
						// scraped `planetscale_*` metrics.
						yield* warehouse.warmRoute(tenant)
						const [gaugeRows, connectionRows, storageRows] = yield* Effect.all(
							[
								runQuery(Queries.planetscaleServiceGauges, tenant, payload),
								runQuery(Queries.planetscaleServiceConnections, tenant, payload),
								runQuery(Queries.planetscaleServiceStorage, tenant, payload),
							],
							{ concurrency: 3 },
						)
						const keyOf = (row: { database: string; branch?: string }) =>
							byBranch ? `${row.database}\x00${row.branch ?? ""}` : row.database
						const connectionsByKey = new Map(Arr.map(connectionRows, (row) => [keyOf(row), row]))
						const storageByKey = new Map(Arr.map(storageRows, (row) => [keyOf(row), row]))
						const seen = new Set<string>()
						type MergedStatsRow = {
							readonly database: string
							readonly branch?: string
							readonly cpuMaxPercent: number
							readonly memMaxPercent: number
							readonly replicaLagMaxSeconds: number
							readonly connectionsAvg: number
							readonly connectionsMax: number
							readonly storageUsedPercent: number
							/** 0 = the volume gauges never reported; the client must not render 0% used. */
							readonly storageSamples: number
						}
						const storageFor = (key: string) => {
							const storage = storageByKey.get(key)
							return {
								storageUsedPercent: storage?.storageUsedPercent ?? 0,
								storageSamples: storage?.storageSamples ?? 0,
							}
						}
						// The storage rollup is per-database or per-branch depending on the
						// request; only the latter carries a branch to forward.
						const branchOf = (
							row:
								| { readonly database: string }
								| { readonly database: string; readonly branch: string },
						): { readonly branch?: string } => ("branch" in row ? { branch: row.branch } : {})
						const data: Array<MergedStatsRow> = Arr.map(gaugeRows, (row) => {
							const key = keyOf(row)
							seen.add(key)
							const connections = connectionsByKey.get(key)
							return {
								...row,
								connectionsAvg: connections?.connectionsAvg ?? 0,
								connectionsMax: connections?.connectionsMax ?? 0,
								...storageFor(key),
							}
						})
						// Databases with connection samples but no utilization gauges still
						// deserve a row (e.g. filtered scrape sets).
						for (const row of connectionRows) {
							const key = keyOf(row)
							if (seen.has(key)) continue
							seen.add(key)
							data.push({
								...row,
								cpuMaxPercent: 0,
								memMaxPercent: 0,
								replicaLagMaxSeconds: 0,
								...storageFor(key),
							})
						}
						// …and so do volumes reporting with no gauges or connections at all —
						// an idle branch still filling its disk is exactly what to surface.
						for (const row of storageRows) {
							const key = keyOf(row)
							if (seen.has(key)) continue
							seen.add(key)
							data.push({
								database: row.database,
								...branchOf(row),
								cpuMaxPercent: 0,
								memMaxPercent: 0,
								replicaLagMaxSeconds: 0,
								connectionsAvg: 0,
								connectionsMax: 0,
								storageUsedPercent: row.storageUsedPercent,
								storageSamples: row.storageSamples,
							})
						}
						return new ServicePlanetScaleStatsResponse({ data })
					}),
				)
				.handle(
					"planetscaleInfraTimeseries",
					serve.rows(Queries.planetscaleInfraTimeseries, PlanetScaleInfraTimeseriesResponse),
				)
				.handle(
					"railwayInfraServices",
					serve.rows(Queries.railwayInfraServices, RailwayInfraRowsResponse),
				)
				.handle(
					"railwayInfraServiceTimeseries",
					serve.rows(Queries.railwayInfraServiceTimeseries, RailwayInfraRowsResponse),
				)
				// Gauges, CPU and the logs summary are three reads; a project with no CPU samples yet
				// reads 0% CPU, one with logs but no metrics reads zero metrics.
				.handle("supabaseInfraProjects", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [gauges, cpu, logs] = yield* Effect.all(
							[
								runQuery(Queries.supabaseInfraProjectGauges, tenant, payload),
								runQuery(Queries.supabaseInfraProjectCpu, tenant, payload),
								runQuery(Queries.supabaseLogsProjectsSummary, tenant, payload),
							],
							{ concurrency: 3 },
						)
						return new SupabaseInfraRowsResponse({
							data: mergeSupabaseProjects(gauges, cpu, logs),
						})
					}),
				)
				// Buckets present in either read; a missing half reads as zeros.
				.handle("supabaseInfraProjectTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [gauges, rates] = yield* Effect.all(
							[
								runQuery(Queries.supabaseInfraProjectGaugeSeries, tenant, payload),
								runQuery(Queries.supabaseInfraProjectRateSeries, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new SupabaseInfraRowsResponse({ data: mergeSupabaseSeries(gauges, rates) })
					}),
				)
				.handle("supabaseApiTraffic", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [series, totals] = yield* Effect.all(
							[
								runQuery(Queries.supabaseApiTrafficSeries, tenant, payload),
								runQuery(Queries.supabaseApiTrafficTotals, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return apiTrafficResponse(series, totals[0])
					}),
				)
				.handle("supabaseApiTopPaths", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.supabaseApiTopPaths, tenant, payload)
						return new SupabaseApiTopPathsResponse({
							paths: Arr.map(rows, (row) => new SupabaseApiPath(row)),
						})
					}),
				)
				.handle("supabaseProjectCallers", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [callers, series] = yield* Effect.all(
							[
								runQuery(Queries.supabaseProjectCallers, tenant, payload),
								runQuery(Queries.supabaseProjectCallerSeries, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new SupabaseProjectCallersResponse({
							callers: mergeSupabaseCallers(callers, series),
						})
					}),
				)
				.handle("supabaseLogIssues", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.supabaseLogIssues, tenant, payload)
						return new SupabaseLogIssuesResponse({
							issues: Arr.map(
								rows,
								(row) =>
									new SupabaseLogIssue({
										...row,
										lastSeen: DateTime.formatIso(row.lastSeen),
									}),
							),
						})
					}),
				)
				.handle("awsInfraPresence", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.awsInfraPresence, tenant, payload)
						const reported = new Set(Arr.map(rows, (row) => row.metric))
						return new AwsInfraPresenceResponse({
							kinds: Arr.filter(AWS_INFRA_KIND_IDS, (kind) =>
								Arr.some(AWS_INFRA_KINDS[kind].metrics, (metric) =>
									reported.has(metric.name),
								),
							),
						})
					}),
				)
				.handle("awsInfraMetrics", serve.rows(Queries.awsInfraMetrics, AwsInfraMetricsResponse))
				.handle(
					"awsInfraSparklines",
					serve.rows(Queries.awsInfraSparklines, AwsInfraSparklinesResponse),
				)
				.handle(
					"awsInfraTimeseries",
					serve.rows(Queries.awsInfraTimeseries, AwsInfraTimeseriesResponse),
				)
				.handle("vercelInfraProjects", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [requestRows, latencyRows, functionRows] = yield* Effect.all(
							[
								runQuery(Queries.vercelInfraProjectRequests, tenant, payload),
								runQuery(Queries.vercelInfraProjectLatency, tenant, payload),
								runQuery(Queries.vercelInfraProjectFunctions, tenant, payload),
							],
							{ concurrency: 3 },
						)
						const latencyByProject = new Map(Arr.map(latencyRows, (row) => [row.projectId, row]))
						const functionsByProject = new Map(
							Arr.map(functionRows, (row) => [row.projectId, row]),
						)
						const functionUsage = (projectId: string) => ({
							invocations: functionsByProject.get(projectId)?.invocations ?? 0,
							coldStarts: functionsByProject.get(projectId)?.coldStarts ?? 0,
						})
						const withLogs = new Set(Arr.map(requestRows, (row) => row.projectId))
						const withLatency = new Set(Arr.map(latencyRows, (row) => row.projectId))
						// Projects that only send traces: the logs drain is off, or not delivering.
						const tracesOnly = (row: {
							projectId: string
							serviceName: string
							lastSeen: DateTime.Utc
						}) => ({
							projectId: row.projectId,
							projectName: "",
							// The project's own service, which ingest gives its invocations; the edge's otherwise.
							serviceName:
								functionsByProject.get(row.projectId)?.serviceName || row.serviceName,
							requests: 0,
							requests4xx: 0,
							requests5xx: 0,
							cacheHits: 0,
							cacheLookups: 0,
							errorLogs: 0,
							lastSeen: DateTime.formatIso(row.lastSeen),
							...functionUsage(row.projectId),
						})
						return new VercelInfraProjectsResponse({
							projects: [
								...Arr.map(requestRows, (row) => {
									const latency = latencyByProject.get(row.projectId)
									return {
										...row,
										lastSeen: DateTime.formatIso(row.lastSeen),
										p50DurationMs: latency?.p50DurationMs ?? null,
										p95DurationMs: latency?.p95DurationMs ?? null,
										...functionUsage(row.projectId),
									}
								}),
								...Arr.map(
									Arr.filter(latencyRows, (row) => !withLogs.has(row.projectId)),
									(row) => ({
										...tracesOnly(row),
										p50DurationMs: row.p50DurationMs,
										p95DurationMs: row.p95DurationMs,
									}),
								),
								...Arr.map(
									Arr.filter(
										functionRows,
										(row) =>
											!withLogs.has(row.projectId) && !withLatency.has(row.projectId),
									),
									(row) => ({
										...tracesOnly(row),
										p50DurationMs: null,
										p95DurationMs: null,
									}),
								),
							],
						})
					}),
				)
				.handle("vercelInfraRequestTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const buckets = yield* runQuery(Queries.vercelInfraRequestTimeseries, tenant, payload)
						return new VercelInfraRequestTimeseriesResponse({ buckets })
					}),
				)
				.handle("vercelInfraLatencyTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [edge, functions] = yield* Effect.all(
							[
								runQuery(Queries.vercelInfraEdgeLatencyTimeseries, tenant, payload),
								runQuery(Queries.vercelInfraFunctionTimeseries, tenant, payload),
							],
							{ concurrency: 2 },
						)
						const edgeByBucket = new Map(Arr.map(edge, (row) => [row.bucket, row] as const))
						const functionsByBucket = new Map(
							Arr.map(functions, (row) => [row.bucket, row] as const),
						)
						const buckets = Arr.sort(
							[...new Set([...edgeByBucket.keys(), ...functionsByBucket.keys()])],
							Order.String,
						)
						return new VercelInfraLatencyTimeseriesResponse({
							buckets: Arr.map(buckets, (bucket) => {
								const e = edgeByBucket.get(bucket)
								const f = functionsByBucket.get(bucket)
								const invocations = f?.invocations ?? 0
								return {
									bucket,
									edgeP50Ms: e?.p50DurationMs ?? null,
									edgeP95Ms: e?.p95DurationMs ?? null,
									invocations,
									coldStarts: f?.coldStarts ?? 0,
									invokeP50Ms: invocations > 0 ? (f?.invokeP50Ms ?? null) : null,
									invokeP95Ms: invocations > 0 ? (f?.invokeP95Ms ?? null) : null,
								}
							}),
						})
					}),
				)
				.handle("vercelInfraBreakdown", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.vercelInfraBreakdown, tenant, payload)
						return new VercelInfraBreakdownResponse({ rows })
					}),
				)
				.handle("vercelInfraProjectDetail", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [paths, errors] = yield* Effect.all(
							[
								runQuery(Queries.vercelInfraTopPaths, tenant, payload),
								runQuery(Queries.vercelInfraTopErrors, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new VercelInfraProjectDetailResponse({
							paths,
							errors: Arr.map(errors, (row) => ({
								...row,
								lastSeen: DateTime.formatIso(row.lastSeen),
							})),
						})
					}),
				)
				.handle("vercelAiGateway", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [summaryRows, models, projects, timeseries] = yield* Effect.all(
							[
								runQuery(Queries.vercelAiGatewaySummary, tenant, payload),
								runQuery(Queries.vercelAiGatewayByModel, tenant, payload),
								payload.projectId === undefined
									? runQuery(Queries.vercelAiGatewayByProject, tenant, payload)
									: Effect.succeed([]),
								runQuery(Queries.vercelAiGatewayTimeseries, tenant, payload),
							],
							{ concurrency: 4 },
						)
						// An aggregate without GROUP BY always returns its one row.
						const summary = summaryRows[0] ?? {
							requests: 0,
							costUsd: 0,
							inputTokens: 0,
							outputTokens: 0,
							errors: 0,
							p50DurationMs: null,
							p95DurationMs: null,
						}
						return new VercelAiGatewayResponse({ summary, models, projects, timeseries })
					}),
				)
				.handle("vercelInfraFunctions", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const functions = yield* runQuery(Queries.vercelInfraFunctionRoutes, tenant, payload)
						return new VercelInfraFunctionsResponse({ functions })
					}),
				)
				.handle("vercelInfraDependencies", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const dependencies = yield* runQuery(Queries.vercelInfraDependencies, tenant, payload)
						return new VercelInfraDependenciesResponse({ dependencies })
					}),
				)
				.handle("vercelSpeedInsights", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						// Route and device breakdowns only for one project: across projects they mix sites.
						const scoped = payload.projectId !== undefined
						const [metrics, routes, devices] = yield* Effect.all(
							[
								runQuery(Queries.vercelSpeedInsightsMetrics, tenant, payload),
								scoped
									? runQuery(Queries.vercelSpeedInsightsRoutes, tenant, payload)
									: Effect.succeed([]),
								scoped
									? runQuery(Queries.vercelSpeedInsightsDevices, tenant, payload)
									: Effect.succeed([]),
							],
							{ concurrency: 3 },
						)
						return new VercelSpeedInsightsResponse({ metrics, routes, devices })
					}),
				)
				.handle("vercelWebAnalytics", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [summaryRows, pages, referrers, countries, events] = yield* Effect.all(
							[
								runQuery(Queries.vercelWebAnalyticsSummary, tenant, payload),
								runQuery(Queries.vercelWebAnalyticsPages, tenant, payload),
								runQuery(Queries.vercelWebAnalyticsReferrers, tenant, payload),
								runQuery(Queries.vercelWebAnalyticsCountries, tenant, payload),
								runQuery(Queries.vercelWebAnalyticsEvents, tenant, payload),
							],
							{ concurrency: 5 },
						)
						// An aggregate without GROUP BY always returns its one row.
						const summary = summaryRows[0] ?? { pageViews: 0, uniqueDevices: 0, customEvents: 0 }
						return new VercelWebAnalyticsResponse({
							summary,
							pages,
							referrers,
							countries,
							events,
						})
					}),
				)
				.handle("vercelAuditLog", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.vercelAuditLog, tenant, payload)
						return new VercelAuditLogResponse({
							events: Arr.map(rows, (row) => ({
								...row,
								timestamp: DateTime.formatIso(row.timestamp),
							})),
						})
					}),
				)
				.handle("gcpInfraPresence", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.gcpInfraPresence, tenant, payload)
						const reported = new Set(Arr.map(rows, (row) => row.metric))
						return new GcpInfraPresenceResponse({
							services: Arr.filter(GCP_INFRA_SERVICE_IDS, (service) =>
								Arr.some(gcpInfraMetrics(service), (metric) => reported.has(metric.name)),
							),
						})
					}),
				)
				.handle("gcpInfraMetrics", serve.rows(Queries.gcpInfraMetrics, GcpInfraMetricsResponse))
				.handle(
					"gcpInfraTimeseries",
					serve.rows(Queries.gcpInfraTimeseries, GcpInfraTimeseriesResponse),
				)
				.handle(
					"gcpInfraSparklines",
					serve.rows(Queries.gcpInfraSparklines, GcpInfraSparklinesResponse),
				)
				.handle(
					"gcpCloudSqlTopQueries",
					serve.rows(Queries.gcpCloudSqlTopQueries, GcpCloudSqlTopQueriesResponse),
				)
				.handle("gcpCloudSqlDatabases", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.gcpCloudSqlDatabases, tenant, payload)
						return new GcpCloudSqlDatabasesResponse({
							databases: Arr.map(rows, (row) => row.database),
						})
					}),
				)
				.handle(
					"gcpCloudSqlStatementSpans",
					serve.rows(Queries.gcpCloudSqlStatementSpans, GcpCloudSqlStatementSpansResponse),
				)
				.handle("cloudflareInfraZones", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Counters (metrics_sum) + percentiles (metrics_gauge) run
						// concurrently, then merge by ServiceName — same shape as
						// serviceCloudflareStats above.
						const filters = toCloudflareFilters(payload)
						yield* warehouse.warmRoute(tenant)
						const [counterRows, latencyRows] = yield* Effect.all(
							[
								runQuery(Queries.cloudflareInfraZoneCounters, tenant, payload),
								runQuery(Queries.cloudflareInfraZoneLatency, tenant, payload),
							],
							{ concurrency: 2 },
						)
						const latencyByService = new Map(
							Arr.map(latencyRows, (row) => [row.serviceName, row]),
						)
						const data = Arr.map(counterRows, (row) => {
							const latency = latencyByService.get(row.serviceName)
							return {
								serviceName: row.serviceName,
								requests: row.requests,
								errors5xx: row.errors5xx,
								errors4xx: row.errors4xx,
								requests2xx: row.requests2xx,
								requests3xx: row.requests3xx,
								cacheHits: row.cacheHits,
								cacheableRequests: row.cacheableRequests,
								bytes: row.bytes,
								visits: row.visits,
								ttfbP50Ms: latency?.ttfbP50Ms ?? 0,
								ttfbP95Ms: latency?.ttfbP95Ms ?? 0,
								ttfbP99Ms: latency?.ttfbP99Ms ?? 0,
								originP50Ms: latency?.originP50Ms ?? 0,
								originP95Ms: latency?.originP95Ms ?? 0,
								originP99Ms: latency?.originP99Ms ?? 0,
							}
						})
						return new CloudflareInfraZonesResponse({
							data,
							// The latency columns are zone-wide by construction, so a dimension filter
							// narrows the counters but never the percentiles beside them.
							ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
								Integrations.CF_METRIC.requests,
								Integrations.CF_METRIC.bytes,
								Integrations.CF_METRIC.visits,
							]),
						})
					}),
				)
				.handle("cloudflareInfraZoneTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const filters = toCloudflareFilters(payload)
						const rows = yield* runQuery(Queries.cloudflareInfraZoneTimeseries, tenant, payload)
						return new CloudflareInfraZoneTimeseriesResponse({
							data: Arr.map(rows, (row) => ({ ...row })),
							ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
								Integrations.CF_METRIC.requests,
							]),
						})
					}),
				)
				.handle("cloudflareInfraZoneDetail", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const filters = toCloudflareFilters(payload)
						yield* warehouse.warmRoute(tenant)
						const [statusRows, cacheRows, latencyRows] = yield* Effect.all(
							[
								runQuery(Queries.cloudflareInfraZoneDetailStatus, tenant, payload),
								runQuery(Queries.cloudflareInfraZoneDetailCache, tenant, payload),
								runQuery(Queries.cloudflareInfraZoneDetailLatency, tenant, payload),
							],
							{ concurrency: 3 },
						)
						return new CloudflareInfraZoneDetailResponse({
							statusBuckets: Arr.map(statusRows, (row) => ({ ...row })),
							cacheBuckets: Arr.map(cacheRows, (row) => ({ ...row })),
							latencyBuckets: Arr.map(latencyRows, (row) => ({ ...row })),
							ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
								Integrations.CF_METRIC.requests,
							]),
							latencyIgnoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
								Integrations.CF_METRIC.edgeTtfb,
								Integrations.CF_METRIC.originDuration,
							]),
						})
					}),
				)
				.handle("cloudflareInfraWorkerDetail", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [outcomeRows, latencyRows, durableObjectRows] = yield* Effect.all(
							[
								runQuery(Queries.cloudflareInfraWorkerDetailOutcomes, tenant, payload),
								runQuery(Queries.cloudflareInfraWorkerDetailLatency, tenant, payload),
								runQuery(Queries.cloudflareInfraWorkerDetailDurableObjects, tenant, payload),
							],
							{ concurrency: 3 },
						)
						return new CloudflareInfraWorkerDetailResponse({
							outcomeBuckets: Arr.map(outcomeRows, (row) => ({ ...row })),
							latencyBuckets: Arr.map(latencyRows, (row) => ({ ...row })),
							durableObjectBuckets: Arr.map(durableObjectRows, (row) => ({ ...row })),
						})
					}),
				)
				.handle("cloudflareInfraZoneSecurity", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const filters = toCloudflareFilters(payload)
						yield* warehouse.warmRoute(tenant)
						const [bucketRows, topRows] = yield* Effect.all(
							[
								runQuery(Queries.cloudflareInfraZoneFirewallTimeseries, tenant, payload),
								runQuery(Queries.cloudflareInfraZoneFirewallTop, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new CloudflareInfraZoneSecurityResponse({
							buckets: Arr.map(bucketRows, (row) => ({ ...row })),
							top: Arr.map(topRows, (row) => ({ ...row })),
							ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
								Integrations.CF_METRIC.firewallEvents,
							]),
						})
					}),
				)
				.handle("cloudflareInfraZoneDns", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const filters = toCloudflareFilters(payload)
						yield* warehouse.warmRoute(tenant)
						const [bucketRows, nameRows] = yield* Effect.all(
							[
								runQuery(Queries.cloudflareInfraZoneDnsTimeseries, tenant, payload),
								runQuery(Queries.cloudflareInfraZoneDnsBreakdown, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new CloudflareInfraZoneDnsResponse({
							buckets: Arr.map(bucketRows, (row) => ({ ...row })),
							names: Arr.map(nameRows, (row) => ({ ...row })),
							ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
								Integrations.CF_METRIC.dnsQueries,
							]),
						})
					}),
				)
				.handle("cloudflareInfraZoneBreakdown", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const filters = toCloudflareFilters(payload)
						yield* warehouse.warmRoute(tenant)
						const [totalRows, coverageRows, zoneRows] = yield* Effect.all(
							[
								runQuery(Queries.cloudflareInfraZoneBreakdownTotals, tenant, payload),
								runQuery(Queries.cloudflareInfraZoneBreakdownCoverage, tenant, payload),
								runQuery(Queries.cloudflareInfraZoneBreakdownZoneTotal, tenant, payload),
							],
							{ concurrency: 3 },
						)
						const topKeys = Arr.map(
							Arr.filter(totalRows, (row) => row.key !== CLOUDFLARE_BREAKDOWN_OTHER_KEY).slice(
								0,
								Integrations.CLOUDFLARE_BREAKDOWN_SERIES_LIMIT,
							),
							(row) => row.key,
						)
						const bucketRows: ReadonlyArray<Integrations.CloudflareZoneBreakdownTimeseriesOutput> =
							topKeys.length === 0
								? []
								: yield* runQuery(Queries.cloudflareInfraZoneBreakdownTimeseries, tenant, {
										...payload,
										topKeys,
									})
						const coverage = coverageRows[0]
						const zoneRequests = Option.match(
							Arr.findFirst(zoneRows, (row) => row.serviceName === payload.serviceName),
							{ onNone: () => 0, onSome: (row) => row.requests ?? 0 },
						)
						// Breakdown metrics are a per-window top-N fold of what Cloudflare returned, so
						// they can only ever undercount the zone. Clamp rather than surface a negative.
						const unattributed = Math.max(0, zoneRequests - (coverage?.attributedRequests ?? 0))
						return new CloudflareInfraZoneBreakdownResponse({
							totals: Arr.map(totalRows, (row) => ({ ...row })),
							buckets: Arr.map(bucketRows, (row) => ({ ...row })),
							unattributed,
							coverageStart:
								coverage?.coverageStart != null && coverage.coverageStart !== ""
									? coverage.coverageStart
									: null,
							ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(
								filters,
								Integrations.cloudflareBreakdownMetrics(payload.dimension),
							),
						})
					}),
				)
				.handle("cloudflareInfraZoneFacets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.cloudflareInfraZoneFacets, tenant, payload)
						const buckets = {
							hosts: [] as Array<{ name: string; count: number }>,
							cacheStatuses: [] as Array<{ name: string; count: number }>,
							statusClasses: [] as Array<{ name: string; count: number }>,
							paths: [] as Array<{ name: string; count: number }>,
							countries: [] as Array<{ name: string; count: number }>,
							methods: [] as Array<{ name: string; count: number }>,
							protocols: [] as Array<{ name: string; count: number }>,
							deviceTypes: [] as Array<{ name: string; count: number }>,
						}
						for (const row of rows) {
							// `count` is decoded by the union's derived row schema; `|| 0` only
							// covers a NaN sum.
							const entry = { name: row.name, count: row.count }
							switch (row.facetType) {
								case "host":
									buckets.hosts.push(entry)
									break
								case "cacheStatus":
									buckets.cacheStatuses.push(entry)
									break
								case "statusClass":
									buckets.statusClasses.push(entry)
									break
								case "path":
									buckets.paths.push(entry)
									break
								case "country":
									buckets.countries.push(entry)
									break
								case "method":
									buckets.methods.push(entry)
									break
								case "protocol":
									buckets.protocols.push(entry)
									break
								case "deviceType":
									buckets.deviceTypes.push(entry)
									break
							}
						}
						return new CloudflareInfraZoneFacetsResponse({ data: buckets })
					}),
				)
				.handle("cloudflareInfraPlatformResources", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [queueRows, doRows] = yield* Effect.all(
							[
								runQuery(Queries.cloudflareInfraQueueGauges, tenant, payload),
								runQuery(Queries.cloudflareInfraDurableObjects, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new CloudflareInfraPlatformResourcesResponse({
							queues: Arr.map(queueRows, (row) => ({ ...row })),
							durableObjects: Arr.map(doRows, (row) => ({ ...row })),
						})
					}),
				)
				.handle("cloudflareInfraWorkers", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [counterRows, latencyRows] = yield* Effect.all(
							[
								runQuery(Queries.cloudflareInfraWorkerCounters, tenant, payload),
								runQuery(Queries.cloudflareInfraWorkerLatency, tenant, payload),
							],
							{ concurrency: 2 },
						)
						// Keyed by account too: same-named scripts in two accounts are different Workers.
						const workerKey = (row: { serviceName: string; accountId: string }) =>
							`${row.accountId}|${row.serviceName}`
						const latencyByWorker = new Map(Arr.map(latencyRows, (row) => [workerKey(row), row]))
						const data = Arr.map(counterRows, (row) => {
							const latency = latencyByWorker.get(workerKey(row))
							return {
								serviceName: row.serviceName,
								accountId: row.accountId,
								requests: row.requests,
								errors: row.errors,
								subrequests: row.subrequests,
								cpuP50Ms: latency?.cpuP50Ms ?? 0,
								cpuP99Ms: latency?.cpuP99Ms ?? 0,
								durationP50Ms: latency?.durationP50Ms ?? 0,
								durationP99Ms: latency?.durationP99Ms ?? 0,
							}
						})
						return new CloudflareInfraWorkersResponse({ data })
					}),
				)
				.handle("serviceDetailOverview", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// One Worker invocation for the whole Overview tab: per-org config
						// resolves once (the first sub-query warms the in-isolate memo) and
						// the three queries run concurrently, replacing three separate
						// browser->Worker round-trips. The primary chart keeps its own
						// execute-path cache; releases is uncached (mirrors the standalone
						// handler); environments is edge-cached on a service-scoped key.
						yield* warehouse.warmRoute(tenant)
						const [timeseries, releaseRows, environmentRows] = yield* Effect.all(
							[
								queryEngine.execute(tenant, payload.timeseries),
								runQuery(Queries.serviceReleases, tenant, payload),
								runQuery(Queries.serviceEnvironments, tenant, {
									serviceName: payload.serviceName,
									startTime: payload.startTime,
									endTime: payload.endTime,
								}),
							],
							{ concurrency: 3 },
						)
						return new ServiceDetailOverviewResponse({
							timeseries,
							releases: Arr.map(releaseRows, (row) => ({
								bucket: DateTime.formatIso(row.bucket),
								commitSha: decodeCommitSha(row.commitSha),
								count: row.count,
								errorCount: row.errorCount,
							})),
							environments: Arr.filter(
								Arr.map(environmentRows, (row) => row.environment),
								(env) => env !== "",
							),
						})
					}),
				)
				.handle("releasesList", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// One Worker invocation for the page: the per-commit rows and the
						// swimlane timeline share a config resolution and run concurrently.
						yield* warehouse.warmRoute(tenant)
						const [rows, timelineRows] = yield* Effect.all(
							[
								runQuery(Queries.releasesList, tenant, payload),
								runQuery(Queries.releasesTimeline, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new ReleasesListResponse({
							releases: Arr.map(rows, toReleaseRow),
							timeline: Arr.map(timelineRows, toReleaseTimelinePoint),
							truncated: rows.length >= CH.RELEASES_LIST_CAP,
						})
					}),
				)
				.handle("uptimePhaseTimings", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.uptimePhaseTimings, tenant, payload)
						return new UptimePhaseTimingsResponse({
							points: Arr.map(
								Arr.filter(rows, (row) => row.timedChecks > 0),
								(row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) }),
							),
						})
					}),
				)
				.handle("uptimeChecks", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.uptimeChecks, tenant, payload)
						return new UptimeChecksResponse({
							checks: Arr.map(rows, (row) => ({
								at: DateTime.formatIso(row.at),
								traceId: decodeTraceId(row.traceId),
								durationMs: row.durationMs,
								ok: row.status !== "Error",
								statusCode: row.httpStatus > 0 ? row.httpStatus : null,
								phases:
									row.timed === 1
										? {
												dnsMs: row.dnsMs,
												connectMs: row.connectMs,
												tlsMs: row.tlsMs,
												ttfbMs: row.ttfbMs,
												transferMs: row.transferMs,
											}
										: null,
							})),
						})
					}),
				)
				.handle("releaseDetail", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [versionRows, timelineRows, timeseries, baselineTimeseries, fingerprintRows] =
							yield* Effect.all(
								[
									runQuery(Queries.releaseVersions, tenant, payload),
									runQuery(Queries.releaseTimeline, tenant, payload),
									queryEngine.execute(tenant, payload.timeseries),
									queryEngine.execute(tenant, payload.baselineTimeseries),
									runQuery(Queries.releaseErrorFingerprints, tenant, payload),
								],
								{ concurrency: 5 },
							)
						return new ReleaseDetailResponse({
							versions: Arr.map(versionRows, toReleaseRow),
							timeline: Arr.map(timelineRows, toReleaseTimelinePoint),
							timeseries,
							baselineTimeseries,
							errorFingerprints: Arr.map(fingerprintRows, (row) => ({
								fingerprintHash: decodeFingerprintHash(row.fingerprintHash),
								count: row.count,
								firstSeen: DateTime.formatIso(row.firstSeen),
							})),
						})
					}),
				)
				.handle("serviceDependenciesBundle", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Dependencies tab in one Worker invocation: the three service-map
						// edge queries run concurrently and share a single config
						// resolution, replacing three independent round-trips.
						yield* warehouse.warmRoute(tenant)
						const [dependencyRows, dbEdgeRows, externalEdgeRows] = yield* Effect.all(
							[
								runQuery(Queries.serviceDependenciesForService, tenant, payload),
								// One service's edges stay cheap, so no budget: the tab has no way to say they were dropped.
								withDbEdgesMinutelyFallback(
									(t, pl: typeof payload) =>
										runQuery(Queries.serviceDbEdgesForService, t, pl),
									(t, pl: typeof payload) =>
										runQuery(Queries.serviceDbEdgesForServiceRaw, t, pl),
									tenant,
									payload,
								),
								runQuery(Queries.serviceExternalEdges, tenant, payload),
							],
							{ concurrency: 3 },
						)
						return new ServiceDependenciesBundleResponse({
							dependencies: Arr.map(dependencyRows, (row) => ({ ...row })),
							dbEdges: Arr.map(dbEdgeRows, (row) => ({ ...row })),
							externalEdges: Arr.map(externalEdgeRows, (row) => ({ ...row })),
						})
					}),
				)
				.handle("serviceMapBundle", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Resolve warehouse routing once before the fan-out.
						yield* warehouse.warmRoute(tenant)
						const [dependencyRows, allOverviewRows, dbEdges, platformRows] = yield* Effect.all(
							[
								runQuery(Queries.serviceDependencies, tenant, payload),
								runQuery(Queries.serviceOverview, tenant, payload),
								dbEdgesWithinBudget(
									(t, pl: typeof payload) => runQuery(Queries.serviceDbEdges, t, pl),
									(t, pl: typeof payload) => runQuery(Queries.serviceDbEdgesRaw, t, pl),
									tenant,
									payload,
								),
								runQuery(Queries.servicePlatforms, tenant, payload),
							],
							{ concurrency: 4 },
						)
						// The edges already drop Maple's own callers; overview rows would still draw them as nodes.
						const overviewRows = Arr.filter(allOverviewRows, (row) => !isMapleService(row))

						const services = new Set<string>()
						for (const row of dependencyRows) {
							services.add(row.sourceService)
							services.add(row.targetService)
						}
						for (const row of overviewRows) services.add(row.serviceName)
						services.delete("")

						const serviceNames = Arr.map(Array.from(services).sort(), (name) =>
							decodeServiceName(name),
						)
						const range = { startTime: payload.startTime, endTime: payload.endTime }
						const [workloadRows, runtimeRows] =
							serviceNames.length === 0
								? [[], []]
								: yield* Effect.all(
										[
											runQuery(Queries.serviceWorkloads, tenant, {
												...range,
												services: serviceNames,
											}),
											// The map draws without platform labels rather than fail on them.
											runQuery(Queries.serviceRuntimes, tenant, {
												...range,
												services: serviceNames,
											}).pipe(
												Effect.tapCause((cause) =>
													Effect.logWarning("service map runtimes failed", cause),
												),
												Effect.orElseSucceed(
													(): ReadonlyArray<CH.ServiceRuntimesOutput> => [],
												),
											),
										],
										{ concurrency: 2 },
									)

						return new ServiceMapBundleResponse({
							dependencies: Arr.map(dependencyRows, (row) => ({ ...row })),
							dbEdges: Arr.map(dbEdges.value, (row) => ({ ...row })),
							dbEdgesTimedOut: dbEdges.timedOut,
							overview: Arr.map(overviewRows, (row) => ({ ...row })),
							platforms: Arr.map(platformRows, toServicePlatformRow),
							workloads: Arr.map(workloadRows, toServiceWorkloadRow),
							runtimes: toServiceRuntimeRows(runtimeRows, serviceNames),
						})
					}),
				)
				.handle("serviceDbQuerySummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context

						yield* warehouse.warmRoute(tenant)
						const [summary, timeseriesRows, topQueryRows] = yield* Effect.all(
							[
								runQueryFirst(Queries.serviceDbQuerySummary, tenant, payload),
								runQuery(Queries.serviceDbQueryTimeseries, tenant, payload),
								runQuery(Queries.serviceDbTopQueries, tenant, payload),
							],
							{ concurrency: 3 },
						)

						const toNumber = (value: unknown) => Number(value ?? 0)
						return new ServiceDbQuerySummaryResponse({
							summary:
								summary && toNumber(summary.queryCount) > 0
									? {
											queryCount: toNumber(summary.queryCount),
											estimatedQueryCount: toNumber(summary.estimatedQueryCount),
											errorCount: toNumber(summary.errorCount),
											estimatedErrorCount: toNumber(summary.estimatedErrorCount),
											errorRate: toNumber(summary.errorRate),
											avgDurationMs: toNumber(summary.avgDurationMs),
											p50DurationMs: toNumber(summary.p50DurationMs),
											p95DurationMs: toNumber(summary.p95DurationMs),
											activeServiceCount: toNumber(summary.activeServiceCount),
										}
									: null,
							timeseries: Arr.map(timeseriesRows, (row) => ({
								bucket: DateTime.formatIso(row.bucket),
								queryCount: toNumber(row.queryCount),
								estimatedQueryCount: toNumber(row.estimatedQueryCount),
								errorCount: toNumber(row.errorCount),
								errorRate: toNumber(row.errorRate),
								avgDurationMs: toNumber(row.avgDurationMs),
								p50DurationMs: toNumber(row.p50DurationMs),
								p95DurationMs: toNumber(row.p95DurationMs),
							})),
							topQueries: Arr.map(topQueryRows, (row) => ({
								queryKey: row.queryKey,
								queryLabel: row.queryLabel,
								sampleStatement: row.sampleStatement,
								sampleService: row.sampleService,
								serviceCount: toNumber(row.serviceCount),
								queryCount: toNumber(row.queryCount),
								estimatedQueryCount: toNumber(row.estimatedQueryCount),
								errorCount: toNumber(row.errorCount),
								errorRate: toNumber(row.errorRate),
								avgDurationMs: toNumber(row.avgDurationMs),
								p50DurationMs: toNumber(row.p50DurationMs),
								p95DurationMs: toNumber(row.p95DurationMs),
								lastSeen: DateTime.formatIso(row.lastSeen),
							})),
						})
					}),
				)
				.handle("serviceWorkloads", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						if (payload.services.length === 0) {
							return new ServiceWorkloadsResponse({ data: [] })
						}
						const rows = yield* runQuery(Queries.serviceWorkloads, tenant, payload)
						return new ServiceWorkloadsResponse({ data: Arr.map(rows, toServiceWorkloadRow) })
					}),
				)
				.handle("serviceRuntimes", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						if (payload.services.length === 0) {
							return new ServiceRuntimesResponse({ data: [] })
						}
						const rows = yield* runQuery(Queries.serviceRuntimes, tenant, payload)
						return new ServiceRuntimesResponse({
							data: toServiceRuntimeRows(rows, payload.services),
						})
					}),
				)
				.handle("serviceUsage", serve.rows(Queries.serviceUsage, ServiceUsageResponse))
				.handle("serviceOperations", serveData(reads.serviceOperations, ServiceOperationsResponse))
				.handle("serviceEndpoints", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* reads.serviceEndpoints(tenant, payload)
						// The split is display-only, so it happens after the cache read
						// rather than being baked into the cached payload.
						const data = Arr.map(rows, (row) => ({
							...row,
							...CH.splitEndpointName(row.spanName),
						}))
						return new ServiceEndpointsResponse({ data })
					}),
				)
				.handle("serviceApiOverview", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const bucketSeconds = alignServiceApiBucketSeconds(payload.bucketSeconds)
						const window = (startTime: string, endTime: string) => ({
							serviceName: payload.serviceName,
							environments: payload.environments,
							startTime,
							endTime,
						})
						const totals = (startTime: string, endTime: string) =>
							mapExecError(
								withServiceApiFallback(
									(t, pl) => runQuery(Queries.serviceApiTotals, t, pl),
									(t, pl) => runQuery(Queries.serviceApiTotalsRaw, t, pl),
									tenant,
									window(startTime, endTime),
								),
								"serviceApiTotals query failed",
							).pipe(Effect.map((rows) => rows[0] ?? emptyServiceApiTotals))
						const { previousStartTime, previousEndTime } = payload
						const overview = Effect.all(
							{
								totals: totals(payload.startTime, payload.endTime),
								previous:
									previousStartTime !== undefined && previousEndTime !== undefined
										? totals(previousStartTime, previousEndTime)
										: Effect.succeed(null),
								buckets: mapExecError(
									withServiceApiFallback(
										(t, pl) => runQuery(Queries.serviceApiTimeseries, t, pl),
										(t, pl) => runQuery(Queries.serviceApiTimeseriesRaw, t, pl),
										tenant,
										{ ...window(payload.startTime, payload.endTime), bucketSeconds },
									),
									"serviceApiTimeseries query failed",
								).pipe(Effect.map((rows) => Arr.map(rows, toServiceApiBucket))),
							},
							{ concurrency: "unbounded" },
						)
						const data = yield* queryEngine.cachedDirect(
							tenant,
							"serviceApiOverview",
							payload,
							overview,
							30,
						)
						return new ServiceApiOverviewResponse(data)
					}),
				)
				.handle("serviceEndpointsTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const input = {
							serviceName: payload.serviceName,
							environments: payload.environments,
							startTime: payload.startTime,
							endTime: payload.endTime,
							bucketSeconds: alignServiceApiBucketSeconds(payload.bucketSeconds),
							spanNames: payload.spanNames,
						}
						const buckets = yield* queryEngine.cachedDirect(
							tenant,
							"serviceEndpointsTimeseries",
							payload,
							mapExecError(
								withServiceApiFallback(
									(t, pl) => runQuery(Queries.serviceApiTimeseries, t, pl),
									(t, pl) => runQuery(Queries.serviceApiTimeseriesRaw, t, pl),
									tenant,
									input,
								),
								"serviceEndpointsTimeseries query failed",
							).pipe(Effect.map((rows) => Arr.map(rows, toServiceApiBucket))),
							30,
						)
						return new ServiceEndpointsTimeseriesResponse({ buckets })
					}),
				)
				.handle("serviceEndpointStatusBreakdown", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* queryEngine.cachedDirect(
							tenant,
							"serviceEndpointStatusBreakdown",
							payload,
							orEmptyWithoutEndpointDetails(
								mapExecError(
									runQuery(Queries.serviceEndpointStatusBreakdown, tenant, payload),
									"serviceEndpointStatusBreakdown query failed",
								).pipe(Effect.map((result) => Arr.map(result, (row) => ({ ...row })))),
								[],
							),
							30,
						)
						return new ServiceEndpointStatusBreakdownResponse({ rows })
					}),
				)
				.handle("serviceEndpointDetail", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const detail = Effect.all(
							{
								distribution: mapExecError(
									runQuery(Queries.serviceEndpointDistribution, tenant, payload),
									"serviceEndpointDistribution query failed",
								),
								slowest: mapExecError(
									runQuery(Queries.serviceEndpointSlowest, tenant, payload),
									"serviceEndpointSlowest query failed",
								),
							},
							{ concurrency: "unbounded" },
						).pipe(
							Effect.map(({ distribution: [row], slowest }) => ({
								latencyQuantileLevels: [...CH.ENDPOINT_LATENCY_QUANTILE_LEVELS],
								latencyQuantilesMs: [...(row?.latencyQuantilesMs ?? [])],
								body:
									row !== undefined && row.bodyCount > 0
										? {
												p50Bytes: row.bodyP50Bytes,
												p95Bytes: row.bodyP95Bytes,
												maxBytes: row.bodyMaxBytes,
												count: row.bodyCount,
											}
										: null,
								userAgents: Arr.map(row?.userAgents ?? [], (value, index) => ({
									value,
									count: row?.userAgentCounts[index] ?? null,
								})),
								slowest: Arr.map(slowest, (request) => ({
									traceId: request.traceId,
									timestamp: DateTime.formatIso(request.timestamp),
									durationMs: request.durationMs,
									httpStatusCode: request.httpStatusCode,
									// The rollup writes -1 for a request without a body size.
									bodyBytes: request.bodyBytes < 0 ? null : request.bodyBytes,
								})),
							})),
						)
						const data = yield* queryEngine.cachedDirect(
							tenant,
							"serviceEndpointDetail",
							payload,
							orEmptyWithoutEndpointDetails(detail, {
								latencyQuantileLevels: [...CH.ENDPOINT_LATENCY_QUANTILE_LEVELS],
								latencyQuantilesMs: [],
								body: null,
								userAgents: [],
								slowest: [],
							}),
							30,
						)
						return new ServiceEndpointDetailResponse(data)
					}),
				)
				.handle("listLogs", serve.rows(Queries.listLogs, ListLogsResponse))
				.handle("getLog", serve.rows(Queries.getLog, GetLogResponse))
				.handle("listMetrics", serve.rows(Queries.listMetrics, ListMetricsResponse))
				.handle("metricsSummary", serve.rows(Queries.metricsSummary, MetricsSummaryResponse))
				.handle("infraPresence", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.infraPresence, tenant, payload)
						// The union emits at most one row per surface, and only for
						// surfaces that reported — the row set IS the answer.
						return new InfraPresenceResponse({
							surfaces: Arr.flatMap(rows, (row) =>
								Schema.is(InfraSurfaceLiteral)(row.surface) ? [row.surface] : [],
							),
						})
					}),
				)
				.handle("listHosts", serve.rows(Queries.listHosts, ListHostsResponse))
				.handle(
					"hostDetailSummary",
					serve.first(Queries.hostDetailSummary, HostDetailSummaryResponse),
				)
				.handle("hostInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context

						const spec = hostMetricSpec(payload.metric)

						if (spec.family === "network") {
							const rows = yield* runQuery(Queries.hostInfraNetworkTimeseries, tenant, payload)
							return new HostInfraTimeseriesResponse({
								data: Arr.map(rows, (row) => ({
									bucket: DateTime.formatIso(row.bucket),
									attributeValue: row.attributeValue,
									value: row.rateValue,
								})),
								groupByAttributeKey: spec.groupByAttributeKey,
								unit: spec.unit,
							})
						}

						const rows = yield* runQuery(Queries.hostInfraGaugeTimeseries, tenant, payload)
						return new HostInfraTimeseriesResponse({
							data: Arr.map(rows, (row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: row.avgValue ?? 0,
							})),
							groupByAttributeKey: spec.groupByAttributeKey,
							unit: spec.unit,
						})
					}),
				)
				.handle("listPods", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [rows, countRow] = yield* Effect.all(
							[
								runQuery(Queries.listPods, tenant, payload),
								runQueryFirst(Queries.listPodsCount, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new ListPodsResponse({
							data: Arr.map(rows, (row) => ({
								podName: row.podName,
								namespace: row.namespace,
								nodeName: row.nodeName,
								clusterName: row.clusterName,
								environment: row.environment,
								deploymentName: row.deploymentName,
								statefulsetName: row.statefulsetName,
								daemonsetName: row.daemonsetName,
								jobName: row.jobName,
								qosClass: row.qosClass,
								podUid: row.podUid,
								computeType: row.computeType,
								lastSeen: DateTime.formatIso(row.lastSeen),
								cpuUsage: row.cpuUsage,
								cpuLimitPct: row.cpuLimitPct,
								memoryLimitPct: row.memoryLimitPct,
								cpuRequestPct: row.cpuRequestPct,
								memoryRequestPct: row.memoryRequestPct,
								cpuUsagePeak: row.cpuUsagePeak,
								cpuLimitPctPeak: row.cpuLimitPctPeak,
								memoryLimitPctPeak: row.memoryLimitPctPeak,
								saturation: row.saturation,
							})),
							// The denominator has to match the predicate the list ran, or a scoped
							// view reads "Top 17 of 541". The scope counts are already computed
							// within the requested lifecycle, so only the unscoped case has to
							// pick which lifecycle total it wants.
							totalCount: countOrRowCount(
								payload.scope === "saturated"
									? countRow?.saturatedPods
									: payload.scope === "elevated"
										? countRow?.elevatedPods
										: payload.scope === "unbounded"
											? countRow?.unboundedPods
											: payload.lifecycle === "ended"
												? countRow?.endedPods
												: payload.lifecycle === "all"
													? (countRow?.livePods ?? 0) + (countRow?.endedPods ?? 0)
													: countRow?.livePods,
								// A failed count must not render as "0 of 0" under a list with rows.
								rows.length,
							),
						})
					}),
				)
				.handle("podsSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.podsSummary, tenant, payload)
						return new PodsSummaryResponse({
							livePods: row?.livePods ?? 0,
							endedPods: row?.endedPods ?? 0,
							saturatedPods: row?.saturatedPods ?? 0,
							elevatedPods: row?.elevatedPods ?? 0,
							unboundedPods: row?.unboundedPods ?? 0,
						})
					}),
				)
				.handle("podDetailSummary", serve.first(Queries.podDetailSummary, PodDetailSummaryResponse))
				.handle("podRestarts", serve.rows(Queries.podRestarts, PodRestartsResponse))
				.handle("podInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const spec = podMetricSpec(payload.metric)
						const rows = yield* runQuery(Queries.podInfraTimeseries, tenant, payload)
						return new PodInfraTimeseriesResponse({
							data: Arr.map(rows, (row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: row.avgValue ?? 0,
							})),
							unit: spec.unit,
						})
					}),
				)
				.handle("listContainers", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [rows, countRow] = yield* Effect.all(
							[
								runQuery(Queries.listContainers, tenant, payload),
								runQueryFirst(Queries.listContainersCount, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new ListContainersResponse({
							data: Arr.map(rows, (row) => ({
								containerName: row.containerName,
								hostName: row.hostName,
								containerId: row.containerId,
								imageName: row.imageName,
								composeProject: row.composeProject,
								composeService: row.composeService,
								runtime: row.runtime,
								environment: row.environment,
								lastSeen: DateTime.formatIso(row.lastSeen),
								cpuPct: row.cpuPct,
								memoryPct: row.memoryPct,
								cpuPctPeak: row.cpuPctPeak,
								memoryPctPeak: row.memoryPctPeak,
								cpuLimitCores: row.cpuLimitCores,
								uptimeSeconds: row.uptimeSeconds,
								saturation: row.saturation,
							})),
							// The denominator has to match the predicate the list ran (see listPods).
							totalCount: countOrRowCount(
								payload.scope === "saturated"
									? countRow?.saturatedContainers
									: payload.scope === "elevated"
										? countRow?.elevatedContainers
										: payload.scope === "stale"
											? countRow?.staleContainers
											: countRow?.totalContainers,
								// A failed count must not render as "0 of 0" under a list with rows.
								rows.length,
							),
						})
					}),
				)
				.handle("containersSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.containersSummary, tenant, payload)
						return new ContainersSummaryResponse({
							totalContainers: row?.totalContainers ?? 0,
							saturatedContainers: row?.saturatedContainers ?? 0,
							elevatedContainers: row?.elevatedContainers ?? 0,
							staleContainers: row?.staleContainers ?? 0,
						})
					}),
				)
				.handle("containerDetailSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						// Gauge identity/summary and metrics_sum counters are separate scans;
						// merge them into the one detail shape the page renders.
						const [row, counters] = yield* Effect.all(
							[
								runQueryFirst(Queries.containerDetailSummary, tenant, payload),
								runQueryFirst(Queries.containerCountersSummary, tenant, payload),
							],
							{ concurrency: 2 },
						)
						return new ContainerDetailSummaryResponse({
							data: row
								? {
										containerName: row.containerName,
										hostName: row.hostName,
										containerId: row.containerId,
										imageName: row.imageName,
										composeProject: row.composeProject,
										composeService: row.composeService,
										runtime: row.runtime,
										sourceId: row.sourceId,
										firstSeen: DateTime.formatIso(row.firstSeen),
										lastSeen: DateTime.formatIso(row.lastSeen),
										cpuPct: row.cpuPct,
										memoryPct: row.memoryPct,
										cpuLimitCores: row.cpuLimitCores,
										uptimeSeconds: row.uptimeSeconds,
										memoryBytesAvg: counters?.memoryBytesAvg ?? 0,
										memoryLimitBytes: counters?.memoryLimitBytes ?? 0,
										restartsDelta: counters?.restartsDelta ?? 0,
										pidsAvg: counters?.pidsAvg ?? 0,
									}
								: null,
						})
					}),
				)
				.handle("containerInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const spec = containerMetricSpec(payload.metric)

						if (spec.isSum) {
							const rows = yield* runQuery(Queries.containerInfraSumTimeseries, tenant, payload)
							return new ContainerInfraTimeseriesResponse({
								data: Arr.map(rows, (row) => ({
									bucket: DateTime.formatIso(row.bucket),
									attributeValue: row.attributeValue,
									value: row.sumValue ?? 0,
								})),
								unit: spec.unit,
							})
						}

						const rows = yield* runQuery(Queries.containerInfraGaugeTimeseries, tenant, payload)
						return new ContainerInfraTimeseriesResponse({
							data: Arr.map(rows, (row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: row.avgValue ?? 0,
							})),
							unit: spec.unit,
						})
					}),
				)
				.handle("containerFacets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.containerFacets, tenant, payload)
						const buckets = {
							containers: [] as Array<{ name: string; count: number }>,
							hosts: [] as Array<{ name: string; count: number }>,
							images: [] as Array<{ name: string; count: number }>,
							composeProjects: [] as Array<{ name: string; count: number }>,
							composeServices: [] as Array<{ name: string; count: number }>,
							environments: [] as Array<{ name: string; count: number }>,
						}
						for (const row of rows) {
							const entry = { name: row.name, count: row.count }
							switch (row.facetType) {
								case "container":
									buckets.containers.push(entry)
									break
								case "host":
									buckets.hosts.push(entry)
									break
								case "image":
									buckets.images.push(entry)
									break
								case "composeProject":
									buckets.composeProjects.push(entry)
									break
								case "composeService":
									buckets.composeServices.push(entry)
									break
								case "environment":
									buckets.environments.push(entry)
									break
							}
						}
						return new ContainerFacetsResponse({ data: buckets })
					}),
				)
				.handle("listNodes", serve.rows(Queries.listNodes, ListNodesResponse))
				.handle(
					"nodeDetailSummary",
					serve.first(Queries.nodeDetailSummary, NodeDetailSummaryResponse),
				)
				.handle("nodeInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const spec = nodeMetricSpec(payload.metric)
						const rows = yield* runQuery(Queries.nodeInfraTimeseries, tenant, payload)
						return new NodeInfraTimeseriesResponse({
							data: Arr.map(rows, (row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: row.avgValue ?? 0,
							})),
							unit: spec.unit,
						})
					}),
				)
				.handle("listWorkloads", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.listWorkloads, tenant, payload)
						return new ListWorkloadsResponse({
							data: Arr.map(rows, (row) => ({
								workloadName: row.workloadName,
								namespace: row.namespace,
								clusterName: row.clusterName,
								environment: row.environment,
								podCount: row.podCount,
								lastSeen: DateTime.formatIso(row.lastSeen),
								desiredReplicas: row.replicaSamples > 0 ? row.desiredReplicas : null,
								readyReplicas: row.replicaSamples > 0 ? row.readyReplicas : null,
								failedPods: row.failedPods,
								restarts: row.restarts,
								lastTerminatedReason: row.lastTerminatedReason,
								peakCpuLimitPct: row.peakCpuLimitPct,
								peakMemoryLimitPct: row.peakMemoryLimitPct,
								cpuUsage: row.cpuUsage,
							})),
						})
					}),
				)
				.handle("workloadDetailSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.workloadDetailSummary, tenant, payload)
						return new WorkloadDetailSummaryResponse({
							data: row
								? {
										workloadName: row.workloadName,
										kind: payload.kind,
										namespace: row.namespace,
										podCount: row.podCount,
										sourceId: row.sourceId,
										firstSeen: DateTime.formatIso(row.firstSeen),
										lastSeen: DateTime.formatIso(row.lastSeen),
										avgCpuLimitPct: row.avgCpuLimitPct,
										avgMemoryLimitPct: row.avgMemoryLimitPct,
										avgCpuUsage: row.avgCpuUsage,
									}
								: null,
						})
					}),
				)
				.handle("workloadInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const spec = workloadMetricSpec(payload.metric)
						const rows = yield* runQuery(Queries.workloadInfraTimeseries, tenant, payload)
						return new WorkloadInfraTimeseriesResponse({
							data: Arr.map(rows, (row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: row.avgValue ?? 0,
							})),
							unit: spec.unit,
						})
					}),
				)
				.handle("podFacets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.podFacets, tenant, payload)
						const buckets = {
							pods: [] as Array<{ name: string; count: number }>,
							namespaces: [] as Array<{ name: string; count: number }>,
							nodes: [] as Array<{ name: string; count: number }>,
							clusters: [] as Array<{ name: string; count: number }>,
							deployments: [] as Array<{ name: string; count: number }>,
							statefulsets: [] as Array<{ name: string; count: number }>,
							daemonsets: [] as Array<{ name: string; count: number }>,
							jobs: [] as Array<{ name: string; count: number }>,
							environments: [] as Array<{ name: string; count: number }>,
							computeTypes: [] as Array<{ name: string; count: number }>,
						}
						for (const row of rows) {
							const entry = { name: row.name, count: row.count }
							switch (row.facetType) {
								case "pod":
									buckets.pods.push(entry)
									break
								case "namespace":
									buckets.namespaces.push(entry)
									break
								case "node":
									buckets.nodes.push(entry)
									break
								case "cluster":
									buckets.clusters.push(entry)
									break
								case "deployment":
									buckets.deployments.push(entry)
									break
								case "statefulset":
									buckets.statefulsets.push(entry)
									break
								case "daemonset":
									buckets.daemonsets.push(entry)
									break
								case "job":
									buckets.jobs.push(entry)
									break
								case "environment":
									buckets.environments.push(entry)
									break
								case "computeType":
									buckets.computeTypes.push(entry)
									break
							}
						}
						return new PodFacetsResponse({ data: buckets })
					}),
				)
				.handle("nodeFacets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.nodeFacets, tenant, payload)
						const buckets = {
							nodes: [] as Array<{ name: string; count: number }>,
							clusters: [] as Array<{ name: string; count: number }>,
							environments: [] as Array<{ name: string; count: number }>,
						}
						for (const row of rows) {
							const entry = { name: row.name, count: row.count }
							switch (row.facetType) {
								case "node":
									buckets.nodes.push(entry)
									break
								case "cluster":
									buckets.clusters.push(entry)
									break
								case "environment":
									buckets.environments.push(entry)
									break
							}
						}
						return new NodeFacetsResponse({ data: buckets })
					}),
				)
				.handle("workloadFacets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.workloadFacets, tenant, payload)
						const buckets = {
							workloads: [] as Array<{ name: string; count: number }>,
							namespaces: [] as Array<{ name: string; count: number }>,
							clusters: [] as Array<{ name: string; count: number }>,
							environments: [] as Array<{ name: string; count: number }>,
							computeTypes: [] as Array<{ name: string; count: number }>,
						}
						for (const row of rows) {
							const entry = { name: row.name, count: row.count }
							switch (row.facetType) {
								case "workload":
									buckets.workloads.push(entry)
									break
								case "namespace":
									buckets.namespaces.push(entry)
									break
								case "cluster":
									buckets.clusters.push(entry)
									break
								case "environment":
									buckets.environments.push(entry)
									break
								case "computeType":
									buckets.computeTypes.push(entry)
									break
							}
						}
						return new WorkloadFacetsResponse({ data: buckets })
					}),
				)
				.handle("webAnalyticsSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* withProductEventsFallback(
							(t, pl) => runQueryFirst(Queries.webAnalyticsSummary, t, pl),
							(t, pl) => runQueryFirst(Queries.webAnalyticsSummaryRaw, t, pl),
							tenant,
							payload,
						)
						// A window with no sessions returns no rows at all, not a row of
						// zeroes — the page needs the zeroes to render its empty state.
						return new WebAnalyticsSummaryResponse({
							data: {
								visitors: row?.visitors ?? 0,
								sessions: row?.sessions ?? 0,
								newSessions: row?.newSessions ?? 0,
								bouncedSessions: row?.bouncedSessions ?? 0,
								identifiedSessions: row?.identifiedSessions ?? 0,
								avgDurationMs: row?.avgDurationMs ?? 0,
								botSessions: row?.botSessions ?? 0,
							},
						})
					}),
				)
				.handle("webAnalyticsLive", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* withProductEventsFallback(
							(t, pl) => runQueryFirst(Queries.webAnalyticsLive, t, pl),
							(t, pl) => runQueryFirst(Queries.webAnalyticsLiveRaw, t, pl),
							tenant,
							payload,
						)
						// Nobody on the site returns no rows, not a row of zeroes — and
						// "0 online" is the whole point of the badge, so fill them in.
						return new WebAnalyticsLiveResponse({
							data: {
								visitors: row?.visitors ?? 0,
								sessions: row?.sessions ?? 0,
								windowSeconds: SESSION_LIVE_WINDOW_SECONDS,
							},
						})
					}),
				)
				.handle(
					"webAnalyticsTimeseries",
					serve.fallbackRows(
						withProductEventsFallback,
						Queries.webAnalyticsTimeseries,
						Queries.webAnalyticsTimeseriesRaw,
						WebAnalyticsTimeseriesResponse,
					),
				)
				.handle(
					"webAnalyticsPageviews",
					serve.fallbackRows(
						withProductEventsFallback,
						Queries.webAnalyticsPageviews,
						Queries.webAnalyticsPageviewsRaw,
						WebAnalyticsPageviewsResponse,
					),
				)
				.handle(
					"webAnalyticsPages",
					serve.fallbackRows(
						withProductEventsFallback,
						Queries.webAnalyticsPages,
						Queries.webAnalyticsPagesRaw,
						WebAnalyticsPagesResponse,
					),
				)
				.handle(
					"webAnalyticsEvents",
					serve.fallbackRows(
						withProductEventsFallback,
						Queries.webAnalyticsEvents,
						Queries.webAnalyticsEventsRaw,
						WebAnalyticsEventsResponse,
					),
				)
				.handle("webAnalyticsBreakdowns", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* withProductEventsFallback(
							(t, pl) => runQuery(Queries.webAnalyticsBreakdowns, t, pl),
							(t, pl) => runQuery(Queries.webAnalyticsBreakdownsRaw, t, pl),
							tenant,
							payload,
						)
						const buckets = {
							referrerHosts: [] as Array<{ name: string; count: number }>,
							countries: [] as Array<{ name: string; count: number }>,
							deviceTypes: [] as Array<{ name: string; count: number }>,
							browsers: [] as Array<{ name: string; count: number }>,
							operatingSystems: [] as Array<{ name: string; count: number }>,
							languages: [] as Array<{ name: string; count: number }>,
							utmSources: [] as Array<{ name: string; count: number }>,
							utmMediums: [] as Array<{ name: string; count: number }>,
							utmCampaigns: [] as Array<{ name: string; count: number }>,
							entryPaths: [] as Array<{ name: string; count: number }>,
							exitPaths: [] as Array<{ name: string; count: number }>,
							hosts: [] as Array<{ name: string; count: number }>,
						}
						// facetType → response key. A table rather than a twelve-arm switch:
						// the mapping is the whole content of this step, and the keys have to
						// stay in step with WebAnalyticsFacetKey in the query builder.
						const bucketOf: Record<string, keyof typeof buckets> = {
							referrerHost: "referrerHosts",
							country: "countries",
							deviceType: "deviceTypes",
							browserName: "browsers",
							osName: "operatingSystems",
							language: "languages",
							utmSource: "utmSources",
							utmMedium: "utmMediums",
							utmCampaign: "utmCampaigns",
							entryPath: "entryPaths",
							exitPath: "exitPaths",
							host: "hosts",
						} satisfies Record<string, keyof typeof buckets>
						for (const row of rows) {
							const key = bucketOf[row.facetType]
							if (key) buckets[key].push({ name: row.name, count: row.count })
						}
						return new WebAnalyticsBreakdownsResponse({ data: buckets })
					}),
				)
				.handle(
					"webAnalyticsAiReferrals",
					serve.fallbackRows(
						withProductEventsFallback,
						Queries.webAnalyticsAiReferrals,
						Queries.webAnalyticsAiReferralsRaw,
						WebAnalyticsAiReferralsResponse,
					),
				)
				// No raw fallback: `ai_crawler_requests` is the only source, and a cluster
				// without migration 0033 answers 502 while the referral half still renders.
				.handle("webAnalyticsAiCrawlers", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [crawlers, formats, pages] = yield* Effect.all(
							[
								runQuery(Queries.webAnalyticsAiCrawlers, tenant, payload),
								runQuery(Queries.webAnalyticsAiCrawlerFormats, tenant, payload),
								runQuery(Queries.webAnalyticsAiCrawledPages, tenant, payload),
							],
							{ concurrency: 3 },
						)
						return new WebAnalyticsAiCrawlersResponse({
							data: {
								crawlers: Arr.map(crawlers, (row) => ({
									crawler: row.crawler,
									requests: row.requests,
									failedRequests: row.failedRequests,
									pages: row.pages,
									lastSeen: DateTime.formatIso(row.lastSeen),
								})),
								formats: Arr.flatMap(formats, (row) =>
									isAiContentFormat(row.format)
										? [
												{
													format: row.format,
													requests: row.requests,
													failedRequests: row.failedRequests,
													pages: row.pages,
													crawlers: row.crawlers,
												},
											]
										: [],
								),
								pages: Arr.map(pages, (row) => ({
									host: row.host,
									path: row.path,
									requests: row.requests,
									crawlers: row.crawlers,
									lastSeen: DateTime.formatIso(row.lastSeen),
								})),
							},
						})
					}),
				)
				// Search Console reads the ingest-pinned table; landing pages also join web analytics.
				.handle(
					"searchConsoleOverview",
					serveData(searchConsole.overview, SearchConsoleOverviewResponse),
				)
				.handle(
					"searchConsoleTimeseries",
					serveData(searchConsole.timeseries, SearchConsoleTimeseriesResponse),
				)
				.handle(
					"searchConsoleTopQueries",
					serveData(searchConsole.topQueries, SearchConsoleTopQueriesResponse),
				)
				.handle(
					"searchConsoleTopPages",
					serveData(searchConsole.topPages, SearchConsoleTopPagesResponse),
				)
				.handle(
					"searchConsoleLandingPages",
					serveData(searchConsole.landingPages, SearchConsoleLandingPagesResponse),
				)
				// No raw fallback, like the crawler tab: a cluster without migration 0050 answers 502.
				.handle("securityExposure", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const [signatures, exposed, sources, timeline] = yield* Effect.all(
							[
								runQuery(Queries.scannerSignatures, tenant, payload),
								runQuery(Queries.scannerExposed, tenant, payload),
								runQuery(Queries.scannerSources, tenant, payload),
								runQuery(Queries.scannerTimeline, tenant, payload),
							],
							{ concurrency: 4 },
						)
						return new SecurityExposureResponse({
							data: {
								signatures: Arr.map(signatures, (row) => ({
									signature: row.signature,
									service: row.service,
									requests: row.requests,
									answered: row.answered,
									sources: row.sources,
									lastSeen: DateTime.formatIso(row.lastSeen),
								})),
								exposed: Arr.map(exposed, (row) => ({
									service: row.service,
									host: row.host,
									path: row.path,
									signature: row.signature,
									httpStatus: row.httpStatus,
									requests: row.requests,
									lastSeen: DateTime.formatIso(row.lastSeen),
									sampleTraceId: row.sampleTraceId,
								})),
								sources: Arr.map(sources, (row) => ({
									clientAddress: row.clientAddress,
									requests: row.requests,
									signatures: row.signatures,
									scanner: row.scanner,
									userAgent: row.userAgent,
									lastSeen: DateTime.formatIso(row.lastSeen),
									stages: attackStagesOf(row),
									agent: row.agent,
								})),
								timeline: Arr.map(timeline, (row) => ({
									bucket: DateTime.formatIso(row.bucket),
									requests: row.requests,
									answered: row.answered,
								})),
							},
						})
					}),
				)
				.handle("securityRuntimes", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* warehouse.warmRoute(tenant)
						const rows = yield* runQuery(Queries.runtimeVersions, tenant, payload)
						const products = Arr.flatMap(rows, (row): ReadonlyArray<RuntimeProduct> => {
							const product = runtimeProductOf(row.runtimeName, row.sdkLanguage)
							return product === undefined || row.runtimeVersion === "" ? [] : [product]
						})
						// Busiest services first, so the read cap drops the quietest versions.
						const busiestFirst = Arr.sort(
							rows,
							Order.flip(
								Order.mapInput(Order.Number, (row: (typeof rows)[number]) => row.spans),
							),
						)
						const targets = Arr.flatMap(busiestFirst, (row) => {
							const target = advisoryTargetOf(row)
							return target === undefined ? [] : [target]
						})
						const [releases, advisories] = yield* Effect.all(
							[runtimeReleases.releases(products), runtimeAdvisories.advisories(targets)],
							{ concurrency: 2 },
						)
						return new SecurityRuntimesResponse({
							data: {
								runtimes: Arr.map(rows, (row) => ({
									service: row.service,
									environment: row.environment,
									runtimeName: row.runtimeName,
									runtimeVersion: row.runtimeVersion,
									executableName: row.executableName,
									sdkLanguage: row.sdkLanguage,
									sdkName: row.sdkName,
									sdkVersion: row.sdkVersion,
									spans: row.spans,
									lastSeen: DateTime.formatIso(row.lastSeen),
								})),
								releases,
								advisories: advisories.advisories,
								advisoriesSkipped: advisories.skipped,
							},
						})
					}),
				)
				// Funnels have no raw-`session_events` fallback: server and mobile
				// events exist only in `product_events`, so a cluster without the table
				// surfaces the missing-table error instead of a silently smaller funnel.
				.handle(
					"productEventsFunnel",
					serve.checkedRows(
						(payload) => validateFunnelDefinition(productEventsFunnelOpts(payload)),
						Queries.productEventsFunnel,
						ProductEventsFunnelResponse,
					),
				)
				.handle(
					"productEventsFunnelBreakdown",
					serve.checkedRows(
						// The breakdown builder, not the plain one: `limit` is validated
						// only there, and an unvalidated one throws inside `compile`.
						(payload) =>
							validateFunnelDefinition({
								...productEventsFunnelOpts(payload),
								breakdownBy: payload.breakdownBy,
								limit: payload.limit,
							}),
						Queries.productEventsFunnelBreakdown,
						ProductEventsFunnelBreakdownResponse,
					),
				)
				.handle(
					"productEventsFunnelTiming",
					serve.checkedRows(
						(payload) => validateFunnelDefinition(productEventsFunnelOpts(payload), "details"),
						Queries.productEventsFunnelTiming,
						ProductEventsFunnelTimingResponse,
					),
				)
				.handle(
					"productEventsFunnelLeavers",
					serve.checkedRows(
						(payload) => validateFunnelDefinition(productEventsFunnelOpts(payload), "details"),
						Queries.productEventsFunnelLeavers,
						ProductEventsFunnelLeaversResponse,
					),
				)
				.handle(
					"productEventsPaths",
					serve.checkedRows(
						(payload) => validatePathsDefinition(productEventsPathsOpts(payload)),
						Queries.productEventsPaths,
						ProductEventsPathsResponse,
					),
				)
				.handle("productEventNames", serve.rows(Queries.productEventNames, ProductEventNamesResponse))
				// Both directions of the trace ↔ product-event link.
				.handle(
					"productEventsForTrace",
					serve.rows(Queries.productEventsForTrace, ProductEventsForTraceResponse),
				)
				.handle(
					"productEventTraceSamples",
					serve.rows(Queries.productEventTraceSamples, ProductEventTraceSamplesResponse),
				)
				.handle("executeRawSql", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const result = yield* mapExecError(
							runAuditedRawSql({
								tenant,
								sql: payload.sql,
								startTime: payload.startTime,
								endTime: payload.endTime,
								granularitySeconds: payload.granularitySeconds,
								context: "rawSql",
							}),
							"rawSql query failed",
						)

						return new RawSqlExecuteResponse({
							data: result.rows,
							meta: {
								rowCount: result.rowCount,
								columns: result.columns,
								granularitySeconds: result.granularitySeconds,
							},
						})
					}),
				)
		)
	}),
)
