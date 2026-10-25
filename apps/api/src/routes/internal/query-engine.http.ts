// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import { HttpApiBuilder } from "effect/http-api"
import { mergeSupabaseSeries } from "./supabase-infra-series"
import { apiTrafficResponse, mergeSupabaseCallers, mergeSupabaseProjects } from "./supabase-insights-merge"
import {
	CurrentTenant,
	MapleInternalApi,
	RawSqlExecuteResponse,
	type RawSqlValidationError,
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
	ReleaseDetailResponse,
	type ReleaseRow,
	ServiceDependenciesBundleResponse,
	ServiceMapBundleResponse,
	ServiceWorkloadsResponse,
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
	ProductEventsFunnelResponse,
	ProductEventsFunnelBreakdownResponse,
	ProductEventsFunnelTimingResponse,
	ProductEventsFunnelLeaversResponse,
	ProductEventsPathsResponse,
	ProductEventNamesResponse,
	ProductEventsForTraceResponse,
	ProductEventTraceSamplesResponse,
	CommitSha,
	FingerprintHash,
	ServiceName,
	SpanName,
	StatusCode,
	TraceId,
	SpanId,
} from "@maple/domain/http"
import { AWS_INFRA_KIND_IDS, AWS_INFRA_KINDS } from "@maple/domain/aws-infra"
import { GCP_INFRA_SERVICE_IDS, gcpInfraMetrics } from "@maple/domain/gcp-infra"
import { SESSION_LIVE_WINDOW_SECONDS } from "@maple/domain/query-engine"
import { isAiContentFormat } from "@maple/domain/ai-traffic"
import { DateTime, Duration, Effect, Option, Schema } from "effect"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import {
	isMissingProductEvents,
	isMissingServiceEndpointDetails,
	isMissingServiceMapDbEdgesMinutely,
} from "@maple/backend/services/warehouse/missing-table"
import { makeExecuteRawSql, type QueryEngineDirectError } from "@maple/query-engine/runtime"
import { describeFailure, recordRawSqlAudit } from "@maple/backend/services/audit/audit-access"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	alignServiceApiBucketSeconds,
	CH,
	computeBucketSecondsForRange,
	formatWarehouseDateTime,
	QueryEngineExecuteBatchResponse,
	parseSpanEvents,
} from "@maple/query-engine"

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
import { Queries } from "@/routes/queries"
import { productEventsFunnelOpts, productEventsPathsOpts } from "@maple/query-engine/registry"
import {
	makeDashboardReads,
	makeRollupFallback,
	mapExecError,
	withinBudget,
	withServiceApiFallback,
} from "@maple/backend/queries/dashboard-reads"
import { runQueryEngineBatch } from "@/routes/query-engine-batch"
import type { ExecutionTenant, WarehouseExecutionError } from "@maple/query-engine/execution"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import * as Integrations from "@maple/query-engine-integrations"

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

/** Endpoint detail has no raw fallback: without migration 0048 the panel is empty. */
const orEmptyWithoutEndpointDetails = <A, E, R>(effect: Effect.Effect<A, E, R>, empty: A) =>
	effect.pipe(
		Effect.catch((error) =>
			isMissingServiceEndpointDetails(error)
				? Effect.as(Effect.annotateCurrentSpan("query.rollup.missing", true), empty)
				: Effect.fail(error),
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

const decodeTraceId = Schema.decodeSync(TraceId)
const decodeSpanId = Schema.decodeSync(SpanId)
const decodeServiceName = Schema.decodeUnknownSync(ServiceName)
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
	const platform: "kubernetes" | "cloudflare" | "gcp" | "lambda" | "web" | "unknown" =
		cloudPlatform === "cloudflare.workers" || cloudProvider === "cloudflare"
			? "cloudflare"
			: cloudProvider === "gcp"
				? "gcp"
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

const nodeCapacity = (row: CH.NodeCapacityOutput) => ({
	cpuUsage: row.cpuUsage || 0,
	cpuAllocatable: row.cpuAllocatable || 0,
	cpuUtilization: row.cpuUtilization || 0,
	memoryUsage: row.memoryUsage || 0,
	memoryAllocatable: row.memoryAllocatable || 0,
	memoryUtilization: row.memoryUtilization || 0,
	uptime: row.uptime || 0,
})

const toServiceWorkloadRow = (row: CH.ServiceWorkloadsOutput) => ({
	serviceName: decodeServiceName(row.serviceName),
	workloadKind: row.workloadKind,
	workloadName: row.workloadName,
	namespace: row.namespace,
	clusterName: row.clusterName,
	podCount: row.podCount || 0,
	avgCpuLimitUtilization: row.avgCpuLimitUtilization == null ? null : row.avgCpuLimitUtilization,
	avgMemoryLimitUtilization: row.avgMemoryLimitUtilization == null ? null : row.avgMemoryLimitUtilization,
})

export const HttpQueryEngineLive = HttpApiBuilder.group(MapleInternalApi, "queryEngine", (handlers) =>
	Effect.gen(function* () {
		const queryEngine = yield* QueryEngineService
		const warehouse = yield* WarehouseQueryService
		const reads = makeDashboardReads({ warehouse, queryEngine })
		const { runQuery, runQueryFirst } = reads

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

		const executeRawSql = makeExecuteRawSql<
			ExecutionTenant,
			WarehouseExecutionError | RawSqlValidationError
		>(warehouse)

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
						const typedRows = rows.map((row) => ({
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
							data: rows.flatMap((row) => {
								const events = parseSpanEvents(row).map(({ name, offsetMs }) => ({
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
				.handle("errorsByType", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.errorsByType, tenant, payload)
						return new ErrorsByTypeResponse({
							data: rows.map((row) => ({
								fingerprintHash: decodeFingerprintHash(row.fingerprintHash),
								errorLabel: row.errorLabel,
								sampleMessage: row.sampleMessage,
								count: row.count,
								affectedServicesCount: row.affectedServicesCount,
								firstSeen: DateTime.formatIso(row.firstSeen),
								lastSeen: DateTime.formatIso(row.lastSeen),
							})),
						})
					}),
				)
				.handle("errorsSpark", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.errorsSpark, tenant, payload)
						return new ErrorsSparkResponse({
							data: rows.map((row) => ({
								fingerprintHash: decodeFingerprintHash(row.fingerprintHash),
								bucket: DateTime.formatIso(row.bucket),
								count: row.count,
							})),
						})
					}),
				)
				.handle("errorsSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.errorsSummary, tenant, payload)
						return new ErrorsSummaryResponse({
							data: row
								? {
										totalErrors: row.totalErrors,
										totalSpans: row.totalSpans,
										errorRate: row.errorRate,
										affectedServicesCount: row.affectedServicesCount,
										affectedTracesCount: row.affectedTracesCount,
									}
								: null,
						})
					}),
				)
				.handle("errorDetailTraces", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.errorDetailTraces, tenant, payload)
						return new ErrorDetailTracesResponse({
							data: rows.map((row) => ({
								traceId: decodeTraceId(row.traceId),
								startTime: DateTime.formatIso(row.startTime),
								durationMicros: row.durationMicros,
								spanCount: row.spanCount,
								services: row.services.map((service) => decodeServiceName(service)),
								rootSpanName: row.rootSpanName,
								errorMessage: row.errorMessage,
							})),
						})
					}),
				)
				.handle("errorRateByService", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.errorRateByService, tenant, payload)
						return new ErrorRateByServiceResponse({
							data: rows.map((row) => ({
								serviceName: decodeServiceName(row.serviceName),
								totalLogs: row.totalLogs,
								errorLogs: row.errorLogs,
								errorRate: row.errorRate,
							})),
						})
					}),
				)
				.handle("serviceOverview", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.serviceOverview, tenant, payload)
						return new ServiceOverviewResponse({ data: rows })
					}),
				)
				.handle("serviceHealthSnapshot", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* reads.serviceHealthSnapshot(tenant, payload)
						return new ServiceHealthSnapshotResponse({
							data: rows.map((row) => ({
								serviceName: decodeServiceName(row.serviceName),
								environment: row.environment || "unknown",
								requestCount: row.requestCount,
								errorCount: row.errorCount,
								p95LatencyMs: row.p95LatencyMs,
							})),
						})
					}),
				)
				.handle("serviceHealthBaseline", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* reads.serviceHealthBaseline(tenant, payload)
						return new ServiceHealthBaselineResponse({
							data: rows.map((row) => ({
								serviceName: decodeServiceName(row.serviceName),
								serviceNamespace: row.serviceNamespace,
								environment: row.environment,
								baselineP95LatencyMs: row.baselineP95LatencyMs,
								baselineSpanCount: row.baselineSpanCount,
							})),
						})
					}),
				)
				.handle("serviceApdex", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.serviceApdex, tenant, payload)
						return new ServiceApdexResponse({
							data: rows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								totalCount: row.totalCount,
								satisfiedCount: row.satisfiedCount,
								toleratingCount: row.toleratingCount,
								apdexScore: row.apdexScore,
							})),
						})
					}),
				)
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
						const latencyByService = new Map(latencyRows.map((row) => [row.serviceName, row]))
						const data = counterRows.map((row) => {
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
						const connectionsByKey = new Map(connectionRows.map((row) => [keyOf(row), row]))
						const storageByKey = new Map(storageRows.map((row) => [keyOf(row), row]))
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
						const data: Array<MergedStatsRow> = gaugeRows.map((row) => {
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
				.handle("planetscaleInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.planetscaleInfraTimeseries, tenant, payload)
						return new PlanetScaleInfraTimeseriesResponse({
							data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
						})
					}),
				)
				.handle("railwayInfraServices", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.railwayInfraServices, tenant, payload)
						return new RailwayInfraRowsResponse({
							data: rows.map((row) => ({ ...row, lastSeen: DateTime.formatIso(row.lastSeen) })),
						})
					}),
				)
				.handle("railwayInfraServiceTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.railwayInfraServiceTimeseries, tenant, payload)
						return new RailwayInfraRowsResponse({
							data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
						})
					}),
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
							paths: rows.map((row) => new SupabaseApiPath(row)),
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
							issues: rows.map(
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
						const reported = new Set(rows.map((row) => row.metric))
						return new AwsInfraPresenceResponse({
							kinds: AWS_INFRA_KIND_IDS.filter((kind) =>
								AWS_INFRA_KINDS[kind].metrics.some((metric) => reported.has(metric.name)),
							),
						})
					}),
				)
				.handle("awsInfraMetrics", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.awsInfraMetrics, tenant, payload)
						return new AwsInfraMetricsResponse({
							data: rows.map((row) => ({ ...row, lastSeen: DateTime.formatIso(row.lastSeen) })),
						})
					}),
				)
				.handle("awsInfraSparklines", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.awsInfraSparklines, tenant, payload)
						return new AwsInfraSparklinesResponse({
							data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
						})
					}),
				)
				.handle("awsInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.awsInfraTimeseries, tenant, payload)
						return new AwsInfraTimeseriesResponse({
							data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
						})
					}),
				)
				.handle("gcpInfraPresence", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.gcpInfraPresence, tenant, payload)
						const reported = new Set(rows.map((row) => row.metric))
						return new GcpInfraPresenceResponse({
							services: GCP_INFRA_SERVICE_IDS.filter((service) =>
								gcpInfraMetrics(service).some((metric) => reported.has(metric.name)),
							),
						})
					}),
				)
				.handle("gcpInfraMetrics", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.gcpInfraMetrics, tenant, payload)
						return new GcpInfraMetricsResponse({ data: rows })
					}),
				)
				.handle("gcpInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.gcpInfraTimeseries, tenant, payload)
						return new GcpInfraTimeseriesResponse({
							data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
						})
					}),
				)
				.handle("gcpInfraSparklines", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.gcpInfraSparklines, tenant, payload)
						return new GcpInfraSparklinesResponse({
							data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
						})
					}),
				)
				.handle("gcpCloudSqlTopQueries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.gcpCloudSqlTopQueries, tenant, payload)
						return new GcpCloudSqlTopQueriesResponse({ data: rows })
					}),
				)
				.handle("gcpCloudSqlDatabases", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.gcpCloudSqlDatabases, tenant, payload)
						return new GcpCloudSqlDatabasesResponse({
							databases: rows.map((row) => row.database),
						})
					}),
				)
				.handle("gcpCloudSqlStatementSpans", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.gcpCloudSqlStatementSpans, tenant, payload)
						return new GcpCloudSqlStatementSpansResponse({
							data: rows.map((row) => ({
								...row,
								timestamp: DateTime.formatIso(row.timestamp),
							})),
						})
					}),
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
						const latencyByService = new Map(latencyRows.map((row) => [row.serviceName, row]))
						const data = counterRows.map((row) => {
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
							data: rows.map((row) => ({ ...row })),
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
							statusBuckets: statusRows.map((row) => ({ ...row })),
							cacheBuckets: cacheRows.map((row) => ({ ...row })),
							latencyBuckets: latencyRows.map((row) => ({ ...row })),
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
							outcomeBuckets: outcomeRows.map((row) => ({ ...row })),
							latencyBuckets: latencyRows.map((row) => ({ ...row })),
							durableObjectBuckets: durableObjectRows.map((row) => ({ ...row })),
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
							buckets: bucketRows.map((row) => ({ ...row })),
							top: topRows.map((row) => ({ ...row })),
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
							buckets: bucketRows.map((row) => ({ ...row })),
							names: nameRows.map((row) => ({ ...row })),
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
						const topKeys = totalRows
							.filter((row) => row.key !== Integrations.CLOUDFLARE_BREAKDOWN_OTHER_KEY)
							.slice(0, Integrations.CLOUDFLARE_BREAKDOWN_SERIES_LIMIT)
							.map((row) => row.key)
						const bucketRows: ReadonlyArray<Integrations.CloudflareZoneBreakdownTimeseriesOutput> =
							topKeys.length === 0
								? []
								: yield* runQuery(Queries.cloudflareInfraZoneBreakdownTimeseries, tenant, {
										...payload,
										topKeys,
									})
						const coverage = coverageRows[0]
						const zoneRequests = zoneRows.find((row) => row.serviceName === payload.serviceName)
						// Breakdown metrics are a per-window top-N fold of what Cloudflare returned, so
						// they can only ever undercount the zone. Clamp rather than surface a negative.
						const unattributed = Math.max(
							0,
							(zoneRequests?.requests ?? 0) - (coverage?.attributedRequests ?? 0),
						)
						return new CloudflareInfraZoneBreakdownResponse({
							totals: totalRows.map((row) => ({ ...row })),
							buckets: bucketRows.map((row) => ({ ...row })),
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
							const entry = { name: row.name, count: row.count || 0 }
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
							queues: queueRows.map((row) => ({ ...row })),
							durableObjects: doRows.map((row) => ({ ...row })),
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
						const latencyByWorker = new Map(latencyRows.map((row) => [workerKey(row), row]))
						const data = counterRows.map((row) => {
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
							releases: releaseRows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								commitSha: decodeCommitSha(row.commitSha),
								count: row.count,
								errorCount: row.errorCount,
							})),
							environments: environmentRows
								.map((row) => row.environment)
								.filter((env) => env !== ""),
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
							releases: rows.map(toReleaseRow),
							timeline: timelineRows.map(toReleaseTimelinePoint),
							truncated: rows.length >= CH.RELEASES_LIST_CAP,
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
							versions: versionRows.map(toReleaseRow),
							timeline: timelineRows.map(toReleaseTimelinePoint),
							timeseries,
							baselineTimeseries,
							errorFingerprints: fingerprintRows.map((row) => ({
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
							dependencies: dependencyRows.map((row) => ({ ...row })),
							dbEdges: dbEdgeRows.map((row) => ({ ...row })),
							externalEdges: externalEdgeRows.map((row) => ({ ...row })),
						})
					}),
				)
				.handle("serviceMapBundle", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Resolve warehouse routing once before the fan-out.
						yield* warehouse.warmRoute(tenant)
						const [dependencyRows, overviewRows, dbEdges, platformRows] = yield* Effect.all(
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

						const services = new Set<string>()
						for (const row of dependencyRows) {
							services.add(row.sourceService)
							services.add(row.targetService)
						}
						for (const row of overviewRows) services.add(row.serviceName)
						services.delete("")

						const workloadRows =
							services.size === 0
								? []
								: yield* runQuery(Queries.serviceWorkloads, tenant, {
										startTime: payload.startTime,
										endTime: payload.endTime,
										services: Array.from(services)
											.sort()
											.map((name) => decodeServiceName(name)),
									})

						return new ServiceMapBundleResponse({
							dependencies: dependencyRows.map((row) => ({ ...row })),
							dbEdges: dbEdges.value.map((row) => ({ ...row })),
							dbEdgesTimedOut: dbEdges.timedOut,
							overview: overviewRows.map((row) => ({ ...row })),
							platforms: platformRows.map(toServicePlatformRow),
							workloads: workloadRows.map(toServiceWorkloadRow),
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
							timeseries: timeseriesRows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								queryCount: toNumber(row.queryCount),
								estimatedQueryCount: toNumber(row.estimatedQueryCount),
								errorCount: toNumber(row.errorCount),
								errorRate: toNumber(row.errorRate),
								avgDurationMs: toNumber(row.avgDurationMs),
								p50DurationMs: toNumber(row.p50DurationMs),
								p95DurationMs: toNumber(row.p95DurationMs),
							})),
							topQueries: topQueryRows.map((row) => ({
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
						return new ServiceWorkloadsResponse({ data: rows.map(toServiceWorkloadRow) })
					}),
				)
				.handle("serviceUsage", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.serviceUsage, tenant, payload)
						return new ServiceUsageResponse({ data: rows })
					}),
				)
				.handle("serviceOperations", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const data = yield* reads.serviceOperations(tenant, payload)
						return new ServiceOperationsResponse({ data })
					}),
				)
				.handle("serviceEndpoints", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* reads.serviceEndpoints(tenant, payload)
						// The split is display-only, so it happens after the cache read
						// rather than being baked into the cached payload.
						const data = rows.map((row) => ({
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
								).pipe(Effect.map((rows) => rows.map(toServiceApiBucket))),
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
							).pipe(Effect.map((rows) => rows.map(toServiceApiBucket))),
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
								).pipe(Effect.map((result) => result.map((row) => ({ ...row })))),
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
								userAgents: (row?.userAgents ?? []).map((value, index) => ({
									value,
									count: row?.userAgentCounts[index] ?? null,
								})),
								slowest: slowest.map((request) => ({
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
				.handle("listLogs", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.listLogs, tenant, payload)
						return new ListLogsResponse({ data: rows })
					}),
				)
				.handle("getLog", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.getLog, tenant, payload)
						return new GetLogResponse({ data: rows })
					}),
				)
				.handle("listMetrics", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.listMetrics, tenant, payload)
						return new ListMetricsResponse({ data: rows })
					}),
				)
				.handle("metricsSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.metricsSummary, tenant, payload)
						return new MetricsSummaryResponse({
							data: rows.map((row) => ({
								metricType: row.metricType,
								metricCount: row.metricCount,
								dataPointCount: row.dataPointCount,
							})),
						})
					}),
				)
				.handle("infraPresence", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.infraPresence, tenant, payload)
						// The union emits at most one row per surface, and only for
						// surfaces that reported — the row set IS the answer.
						return new InfraPresenceResponse({
							surfaces: rows.flatMap((row) =>
								Schema.is(InfraSurfaceLiteral)(row.surface) ? [row.surface] : [],
							),
						})
					}),
				)
				.handle("listHosts", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.listHosts, tenant, payload)
						return new ListHostsResponse({
							data: rows.map((row) => ({
								hostName: row.hostName,
								osType: row.osType,
								hostArch: row.hostArch,
								cloudProvider: row.cloudProvider,
								lastSeen: DateTime.formatIso(row.lastSeen),
								cpuPct: row.cpuPct || 0,
								memoryPct: row.memoryPct || 0,
								diskPct: row.diskPct || 0,
								load15: row.load15 || 0,
							})),
						})
					}),
				)
				.handle("hostDetailSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.hostDetailSummary, tenant, payload)
						return new HostDetailSummaryResponse({
							data: row
								? {
										hostName: row.hostName,
										osType: row.osType,
										hostArch: row.hostArch,
										cloudProvider: row.cloudProvider,
										cloudRegion: row.cloudRegion,
										firstSeen: DateTime.formatIso(row.firstSeen),
										lastSeen: DateTime.formatIso(row.lastSeen),
										cpuPct: row.cpuPct || 0,
										memoryPct: row.memoryPct || 0,
										diskPct: row.diskPct || 0,
										load15: row.load15 || 0,
									}
								: null,
						})
					}),
				)
				.handle("hostInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const bucketSeconds = payload.bucketSeconds ?? 60

						const spec = hostMetricSpec(payload.metric)

						if (spec.isNetwork) {
							const rows = yield* runQuery(Queries.hostInfraNetworkTimeseries, tenant, payload)
							return new HostInfraTimeseriesResponse({
								data: rows.map((row) => ({
									bucket: DateTime.formatIso(row.bucket),
									attributeValue: row.attributeValue,
									value: row.sumValue || 0,
								})),
								groupByAttributeKey: spec.groupByAttributeKey,
								unit: spec.unit,
							})
						}

						const rows = yield* runQuery(Queries.hostInfraGaugeTimeseries, tenant, payload)
						return new HostInfraTimeseriesResponse({
							data: rows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: Number(row.avgValue) || 0,
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
							data: rows.map((row) => ({
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
								cpuUsage: row.cpuUsage || 0,
								cpuLimitPct: row.cpuLimitPct || 0,
								memoryLimitPct: row.memoryLimitPct || 0,
								cpuRequestPct: row.cpuRequestPct || 0,
								memoryRequestPct: row.memoryRequestPct || 0,
								cpuUsagePeak: row.cpuUsagePeak || 0,
								cpuLimitPctPeak: row.cpuLimitPctPeak || 0,
								memoryLimitPctPeak: row.memoryLimitPctPeak || 0,
								saturation: row.saturation || 0,
							})),
							// The denominator has to match the predicate the list ran, or a scoped
							// view reads "Top 17 of 541". The scope counts are already computed
							// within the requested lifecycle, so only the unscoped case has to
							// pick which lifecycle total it wants.
							totalCount:
								Number(
									payload.scope === "saturated"
										? countRow?.saturatedPods
										: payload.scope === "elevated"
											? countRow?.elevatedPods
											: payload.scope === "unbounded"
												? countRow?.unboundedPods
												: payload.lifecycle === "ended"
													? countRow?.endedPods
													: payload.lifecycle === "all"
														? (countRow?.livePods ?? 0) +
															(countRow?.endedPods ?? 0)
														: countRow?.livePods,
								) ||
								// A failed count must not render as "0 of 0" under a list with rows.
								rows.length,
						})
					}),
				)
				.handle("podsSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.podsSummary, tenant, payload)
						return new PodsSummaryResponse({
							livePods: Number(row?.livePods) || 0,
							endedPods: Number(row?.endedPods) || 0,
							saturatedPods: Number(row?.saturatedPods) || 0,
							elevatedPods: Number(row?.elevatedPods) || 0,
							unboundedPods: Number(row?.unboundedPods) || 0,
						})
					}),
				)
				.handle("podDetailSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.podDetailSummary, tenant, payload)
						return new PodDetailSummaryResponse({
							data: row
								? {
										podName: row.podName,
										namespace: row.namespace,
										nodeName: row.nodeName,
										deploymentName: row.deploymentName,
										statefulsetName: row.statefulsetName,
										daemonsetName: row.daemonsetName,
										qosClass: row.qosClass,
										podUid: row.podUid,
										computeType: row.computeType,
										podStartTime: row.podStartTime,
										firstSeen: DateTime.formatIso(row.firstSeen),
										lastSeen: DateTime.formatIso(row.lastSeen),
										cpuUsage: row.cpuUsage || 0,
										cpuLimitPct: row.cpuLimitPct || 0,
										memoryLimitPct: row.memoryLimitPct || 0,
										cpuRequestPct: row.cpuRequestPct || 0,
										memoryRequestPct: row.memoryRequestPct || 0,
									}
								: null,
						})
					}),
				)
				.handle("podRestarts", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.podRestarts, tenant, payload)
						return new PodRestartsResponse({
							data: rows.map((row) => ({
								podName: row.podName,
								namespace: row.namespace,
								containerName: row.containerName,
								restarts: Number(row.restarts) || 0,
								totalRestarts: Number(row.totalRestarts) || 0,
								lastTerminatedReason: row.lastTerminatedReason,
							})),
						})
					}),
				)
				.handle("podInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const spec = podMetricSpec(payload.metric)
						const rows = yield* runQuery(Queries.podInfraTimeseries, tenant, payload)
						return new PodInfraTimeseriesResponse({
							data: rows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: Number(row.avgValue) || 0,
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
							data: rows.map((row) => ({
								containerName: row.containerName,
								hostName: row.hostName,
								containerId: row.containerId,
								imageName: row.imageName,
								composeProject: row.composeProject,
								composeService: row.composeService,
								runtime: row.runtime,
								environment: row.environment,
								lastSeen: DateTime.formatIso(row.lastSeen),
								cpuPct: row.cpuPct || 0,
								memoryPct: row.memoryPct || 0,
								cpuPctPeak: row.cpuPctPeak || 0,
								memoryPctPeak: row.memoryPctPeak || 0,
								cpuLimitCores: row.cpuLimitCores || 0,
								uptimeSeconds: row.uptimeSeconds || 0,
								saturation: row.saturation || 0,
							})),
							// The denominator has to match the predicate the list ran (see listPods).
							totalCount:
								Number(
									payload.scope === "saturated"
										? countRow?.saturatedContainers
										: payload.scope === "elevated"
											? countRow?.elevatedContainers
											: payload.scope === "stale"
												? countRow?.staleContainers
												: countRow?.totalContainers,
								) ||
								// A failed count must not render as "0 of 0" under a list with rows.
								rows.length,
						})
					}),
				)
				.handle("containersSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.containersSummary, tenant, payload)
						return new ContainersSummaryResponse({
							totalContainers: Number(row?.totalContainers) || 0,
							saturatedContainers: Number(row?.saturatedContainers) || 0,
							elevatedContainers: Number(row?.elevatedContainers) || 0,
							staleContainers: Number(row?.staleContainers) || 0,
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
										firstSeen: DateTime.formatIso(row.firstSeen),
										lastSeen: DateTime.formatIso(row.lastSeen),
										cpuPct: row.cpuPct || 0,
										memoryPct: row.memoryPct || 0,
										cpuLimitCores: row.cpuLimitCores || 0,
										uptimeSeconds: row.uptimeSeconds || 0,
										memoryBytesAvg: Number(counters?.memoryBytesAvg) || 0,
										memoryLimitBytes: Number(counters?.memoryLimitBytes) || 0,
										restartsDelta: Number(counters?.restartsDelta) || 0,
										pidsAvg: Number(counters?.pidsAvg) || 0,
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
								data: rows.map((row) => ({
									bucket: DateTime.formatIso(row.bucket),
									attributeValue: row.attributeValue,
									value: Number(row.sumValue) || 0,
								})),
								unit: spec.unit,
							})
						}

						const rows = yield* runQuery(Queries.containerInfraGaugeTimeseries, tenant, payload)
						return new ContainerInfraTimeseriesResponse({
							data: rows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: Number(row.avgValue) || 0,
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
							const entry = { name: row.name, count: row.count || 0 }
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
				.handle("listNodes", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.listNodes, tenant, payload)
						return new ListNodesResponse({
							data: rows.map((row) => ({
								nodeName: row.nodeName,
								nodeUid: row.nodeUid,
								clusterName: row.clusterName,
								environment: row.environment,
								kubeletVersion: row.kubeletVersion,
								lastSeen: DateTime.formatIso(row.lastSeen),
								...nodeCapacity(row),
							})),
						})
					}),
				)
				.handle("nodeDetailSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runQueryFirst(Queries.nodeDetailSummary, tenant, payload)
						return new NodeDetailSummaryResponse({
							data: row
								? {
										nodeName: row.nodeName,
										nodeUid: row.nodeUid,
										kubeletVersion: row.kubeletVersion,
										containerRuntime: row.containerRuntime,
										firstSeen: DateTime.formatIso(row.firstSeen),
										lastSeen: DateTime.formatIso(row.lastSeen),
										...nodeCapacity(row),
									}
								: null,
						})
					}),
				)
				.handle("nodeInfraTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const spec = nodeMetricSpec(payload.metric)
						const rows = yield* runQuery(Queries.nodeInfraTimeseries, tenant, payload)
						return new NodeInfraTimeseriesResponse({
							data: rows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: Number(row.avgValue) || 0,
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
							data: rows.map((row) => ({
								workloadName: row.workloadName,
								namespace: row.namespace,
								clusterName: row.clusterName,
								environment: row.environment,
								podCount: row.podCount || 0,
								lastSeen: DateTime.formatIso(row.lastSeen),
								desiredReplicas: row.replicaSamples > 0 ? row.desiredReplicas : null,
								readyReplicas: row.replicaSamples > 0 ? row.readyReplicas : null,
								failedPods: row.failedPods || 0,
								restarts: row.restarts || 0,
								lastTerminatedReason: row.lastTerminatedReason,
								peakCpuLimitPct: row.peakCpuLimitPct || 0,
								peakMemoryLimitPct: row.peakMemoryLimitPct || 0,
								cpuUsage: row.cpuUsage || 0,
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
										podCount: row.podCount || 0,
										firstSeen: DateTime.formatIso(row.firstSeen),
										lastSeen: DateTime.formatIso(row.lastSeen),
										avgCpuLimitPct: row.avgCpuLimitPct || 0,
										avgMemoryLimitPct: row.avgMemoryLimitPct || 0,
										avgCpuUsage: row.avgCpuUsage || 0,
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
							data: rows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								attributeValue: row.attributeValue,
								value: Number(row.avgValue) || 0,
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
							const entry = { name: row.name, count: row.count || 0 }
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
							const entry = { name: row.name, count: row.count || 0 }
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
							const entry = { name: row.name, count: row.count || 0 }
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
								visitors: Number(row?.visitors) || 0,
								sessions: Number(row?.sessions) || 0,
								newSessions: Number(row?.newSessions) || 0,
								bouncedSessions: Number(row?.bouncedSessions) || 0,
								identifiedSessions: Number(row?.identifiedSessions) || 0,
								avgDurationMs: Number(row?.avgDurationMs) || 0,
								botSessions: Number(row?.botSessions) || 0,
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
								visitors: Number(row?.visitors) || 0,
								sessions: Number(row?.sessions) || 0,
								windowSeconds: SESSION_LIVE_WINDOW_SECONDS,
							},
						})
					}),
				)
				.handle("webAnalyticsTimeseries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* withProductEventsFallback(
							(t, pl) => runQuery(Queries.webAnalyticsTimeseries, t, pl),
							(t, pl) => runQuery(Queries.webAnalyticsTimeseriesRaw, t, pl),
							tenant,
							payload,
						)
						return new WebAnalyticsTimeseriesResponse({
							data: rows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								visitors: row.visitors || 0,
								sessions: row.sessions || 0,
								newSessions: row.newSessions || 0,
								bouncedSessions: row.bouncedSessions || 0,
								identifiedSessions: row.identifiedSessions || 0,
								avgDurationMs: row.avgDurationMs || 0,
							})),
						})
					}),
				)
				.handle("webAnalyticsPageviews", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* withProductEventsFallback(
							(t, pl) => runQuery(Queries.webAnalyticsPageviews, t, pl),
							(t, pl) => runQuery(Queries.webAnalyticsPageviewsRaw, t, pl),
							tenant,
							payload,
						)
						return new WebAnalyticsPageviewsResponse({
							data: rows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								pageViews: row.pageViews || 0,
								sessions: row.sessions || 0,
							})),
						})
					}),
				)
				.handle("webAnalyticsPages", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* withProductEventsFallback(
							(t, pl) => runQuery(Queries.webAnalyticsPages, t, pl),
							(t, pl) => runQuery(Queries.webAnalyticsPagesRaw, t, pl),
							tenant,
							payload,
						)
						return new WebAnalyticsPagesResponse({
							data: rows.map((row) => ({
								host: row.host,
								pagePath: row.pagePath,
								pageViews: row.pageViews || 0,
								sessions: row.sessions || 0,
							})),
						})
					}),
				)
				.handle("webAnalyticsEvents", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* withProductEventsFallback(
							(t, pl) => runQuery(Queries.webAnalyticsEvents, t, pl),
							(t, pl) => runQuery(Queries.webAnalyticsEventsRaw, t, pl),
							tenant,
							payload,
						)
						return new WebAnalyticsEventsResponse({
							data: rows.map((row) => ({
								name: row.name,
								events: row.events || 0,
								sessions: row.sessions || 0,
							})),
						})
					}),
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
							if (key) buckets[key].push({ name: row.name, count: row.count || 0 })
						}
						return new WebAnalyticsBreakdownsResponse({ data: buckets })
					}),
				)
				.handle("webAnalyticsAiReferrals", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* withProductEventsFallback(
							(t, pl) => runQuery(Queries.webAnalyticsAiReferrals, t, pl),
							(t, pl) => runQuery(Queries.webAnalyticsAiReferralsRaw, t, pl),
							tenant,
							payload,
						)
						return new WebAnalyticsAiReferralsResponse({
							data: rows.map((row) => ({
								bucket: DateTime.formatIso(row.bucket),
								product: row.product,
								sessions: row.sessions || 0,
							})),
						})
					}),
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
								crawlers: crawlers.map((row) => ({
									crawler: row.crawler,
									requests: row.requests || 0,
									failedRequests: row.failedRequests || 0,
									pages: row.pages || 0,
									lastSeen: DateTime.formatIso(row.lastSeen),
								})),
								formats: formats.flatMap((row) =>
									isAiContentFormat(row.format)
										? [
												{
													format: row.format,
													requests: row.requests || 0,
													failedRequests: row.failedRequests || 0,
													pages: row.pages || 0,
													crawlers: row.crawlers,
												},
											]
										: [],
								),
								pages: pages.map((row) => ({
									host: row.host,
									path: row.path,
									requests: row.requests || 0,
									crawlers: row.crawlers,
									lastSeen: DateTime.formatIso(row.lastSeen),
								})),
							},
						})
					}),
				)
				// Funnels have no raw-`session_events` fallback: server and mobile
				// events exist only in `product_events`, so a cluster without the table
				// surfaces the missing-table error instead of a silently smaller funnel.
				.handle("productEventsFunnel", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* validateFunnelDefinition(productEventsFunnelOpts(payload))
						const rows = yield* runQuery(Queries.productEventsFunnel, tenant, payload)
						return new ProductEventsFunnelResponse({
							data: rows.map((row) => ({
								step: row.step || 0,
								count: row.count || 0,
							})),
						})
					}),
				)
				.handle("productEventsFunnelBreakdown", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// The breakdown builder, not the plain one: `limit` is validated
						// only there, and an unvalidated one throws inside `compile`.
						yield* validateFunnelDefinition({
							...productEventsFunnelOpts(payload),
							breakdownBy: payload.breakdownBy,
							limit: payload.limit,
						})
						const rows = yield* runQuery(Queries.productEventsFunnelBreakdown, tenant, payload)
						return new ProductEventsFunnelBreakdownResponse({
							data: rows.map((row) => ({
								group: row.group,
								step: row.step || 0,
								count: row.count || 0,
							})),
						})
					}),
				)
				.handle("productEventsFunnelTiming", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* validateFunnelDefinition(productEventsFunnelOpts(payload), "details")
						const rows = yield* runQuery(Queries.productEventsFunnelTiming, tenant, payload)
						return new ProductEventsFunnelTimingResponse({
							data: rows.map((row) => ({
								step: row.step || 0,
								p50Ms: row.p50Ms || 0,
								p90Ms: row.p90Ms || 0,
							})),
						})
					}),
				)
				.handle("productEventsFunnelLeavers", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* validateFunnelDefinition(productEventsFunnelOpts(payload), "details")
						const rows = yield* runQuery(Queries.productEventsFunnelLeavers, tenant, payload)
						return new ProductEventsFunnelLeaversResponse({
							data: rows.map((row) => ({
								step: row.step || 0,
								next: row.next,
								count: row.count || 0,
							})),
						})
					}),
				)
				.handle("productEventsPaths", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* validatePathsDefinition(productEventsPathsOpts(payload))
						const rows = yield* runQuery(Queries.productEventsPaths, tenant, payload)
						return new ProductEventsPathsResponse({
							data: rows.map((row) => ({
								hop: row.hop || 0,
								fromNode: row.fromNode,
								toNode: row.toNode,
								count: row.count || 0,
							})),
						})
					}),
				)
				.handle("productEventNames", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.productEventNames, tenant, payload)
						return new ProductEventNamesResponse({
							data: rows.map((row) => ({
								eventName: row.eventName,
								kind: row.kind,
								count: row.count || 0,
								sessions: row.sessions || 0,
								persons: row.persons || 0,
							})),
						})
					}),
				)
				// Both directions of the trace ↔ product-event link.
				.handle("productEventsForTrace", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.productEventsForTrace, tenant, payload)
						return new ProductEventsForTraceResponse({
							data: rows.map((row) => ({
								timestamp: DateTime.formatIso(row.timestamp),
								eventName: row.eventName,
								spanId: row.spanId,
								serviceName: row.serviceName,
								userId: row.userId,
								groupId: row.groupId,
								visitorId: row.visitorId,
								sessionId: row.sessionId,
								// Already decoded as Record<string, string> by the derived row schema.
								attributes: row.attributes,
							})),
						})
					}),
				)
				.handle("productEventTraceSamples", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* runQuery(Queries.productEventTraceSamples, tenant, payload)
						return new ProductEventTraceSamplesResponse({
							data: rows.map((row) => ({
								traceId: row.traceId,
								spanId: row.spanId,
								timestamp: DateTime.formatIso(row.timestamp),
								serviceName: row.serviceName,
								userId: row.userId,
								visitorId: row.visitorId,
							})),
						})
					}),
				)
				.handle("executeRawSql", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context

						const autoBucketSeconds = computeAutoBucketSeconds(payload.startTime, payload.endTime)
						const granularitySeconds = payload.granularitySeconds ?? autoBucketSeconds

						const audit = (result: Parameters<typeof recordRawSqlAudit>[0]["result"]) =>
							recordRawSqlAudit({
								tenant,
								sql: payload.sql,
								context: "rawSql",
								startTime: payload.startTime,
								endTime: payload.endTime,
								result,
							})
						const result = yield* mapExecError(
							executeRawSql(tenant, {
								sql: payload.sql,
								orgId: tenant.orgId,
								startTime: payload.startTime,
								endTime: payload.endTime,
								granularitySeconds,
								workload: "interactive",
								context: "rawSql",
							}).pipe(
								// Every statement is audited, however it ended: a refused one as `denied`.
								Effect.tap((executed) =>
									audit({ _tag: "rows", rowCount: executed.rowCount }),
								),
								Effect.tapError((error) =>
									audit(
										error._tag === "@maple/http/errors/RawSqlValidationError"
											? { _tag: "rejected", reason: error.message }
											: { _tag: "failed", error: describeFailure(error) },
									),
								),
							),
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

/**
 * Auto-bucket for raw-SQL `$__interval_s` when the caller didn't supply
 * `granularitySeconds`.
 *
 * Was a private ladder duplicating `computeBucketSeconds`, then a private copy of
 * the string-parse-and-fall-back rule. Both now live in `BUCKET_POLICIES.rawSql`,
 * whose 300s floor is load-bearing: a sub-5-minute `$__interval_s` produces
 * exactly the scan the granularity was chosen to avoid.
 */
function computeAutoBucketSeconds(startTime: string, endTime: string): number {
	return computeBucketSecondsForRange(startTime, endTime, "rawSql")
}
