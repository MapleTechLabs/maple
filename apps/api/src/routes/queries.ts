import * as CH from "@maple/query-engine/ch"
import * as Integrations from "@maple/query-engine-integrations"
import { defineQuery } from "@maple/query-engine/registry"
import { Queries as Core } from "@maple/query-engine/registry"
import type {
	AwsInfraMetricsRequest,
	AwsInfraPresenceRequest,
	AwsInfraSparklinesRequest,
	AwsInfraTimeseriesRequest,
	CloudflareInfraZoneBreakdownRequest,
	HostInfraTimeseriesRequest,
	CloudflareInfraZoneFacetsRequest,
	CloudflareInfraZoneDetailRequest,
	CloudflareInfraWorkerDetailRequest,
	ServicePlanetScaleStatsRequest,
	CloudflareInfraPlatformResourcesRequest,
	CloudflareInfraWorkersRequest,
	CloudflareInfraZoneDnsRequest,
	CloudflareInfraZoneSecurityRequest,
	CloudflareInfraZoneTimeseriesRequest,
	CloudflareInfraZonesRequest,
	ContainerInfraTimeseriesRequest,
	GcpInfraMetricsRequest,
	GcpInfraPresenceRequest,
	GcpCloudSqlInstanceRequest,
	GcpCloudSqlStatementSpansRequest,
	GcpInfraSparklinesRequest,
	GcpInfraTimeseriesRequest,
	GetLogRequest,
	NodeInfraTimeseriesRequest,
	PlanetScaleInfraTimeseriesRequest,
	PodInfraTimeseriesRequest,
	RailwayInfraServicesRequest,
	RailwayInfraServiceTimeseriesRequest,
	ServiceCloudflareStatsRequest,
	SpanDetailRequest,
	SupabaseInfraProjectsRequest,
	SupabaseInfraProjectTimeseriesRequest,
	SupabaseLogIssuesRequest,
	SupabaseProjectWindowRequest,
	TraceSpanEventsRequest,
	WorkloadInfraTimeseriesRequest,
} from "@maple/domain/http"
import {
	containerMetricSpec,
	hostMetricSpec,
	nodeMetricSpec,
	partitionWindowAround,
	podMetricSpec,
	toCloudflareFilters,
	workloadMetricSpec,
} from "@maple/backend/queries/query-helpers"
import { traceCacheTtlSeconds } from "@maple/backend/services/warehouse/trace-detail-cache"
import type { OrgId } from "@maple/domain"

// App-side queries depend on integrations or API-only helpers, so moving them
// into the core registry would invert dependencies. Entries own query inputs;
// handlers retain only response metadata such as `ignoredFilters`.

const cloudflareInfraZoneCounters = defineQuery({
	id: "cloudflareInfraZoneCounters",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZonesRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		// Counters (metrics_sum) + percentiles (metrics_gauge) run
		// concurrently, then merge by ServiceName — same shape as
		// serviceCloudflareStats above.
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneCountersSQL(filters), params)
	},
})

const cloudflareInfraZoneLatency = defineQuery({
	id: "cloudflareInfraZoneLatency",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZonesRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		// Counters (metrics_sum) + percentiles (metrics_gauge) run
		// concurrently, then merge by ServiceName — same shape as
		// serviceCloudflareStats above.
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneLatencySQL(), params)
	},
})

const cloudflareInfraZoneFirewallTimeseries = defineQuery({
	id: "cloudflareInfraZoneFirewallTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneSecurityRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneFirewallTimeseriesSQL(filters), {
			...params,
			bucketSeconds: payload.bucketSeconds,
		})
	},
})

const cloudflareInfraZoneFirewallTop = defineQuery({
	id: "cloudflareInfraZoneFirewallTop",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneSecurityRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneFirewallTopSQL(filters), params)
	},
})

const cloudflareInfraZoneDnsTimeseries = defineQuery({
	id: "cloudflareInfraZoneDnsTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneDnsRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneDnsTimeseriesSQL(filters), {
			...params,
			bucketSeconds: payload.bucketSeconds,
		})
	},
})

const cloudflareInfraZoneDnsBreakdown = defineQuery({
	id: "cloudflareInfraZoneDnsBreakdown",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneDnsRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneDnsBreakdownSQL(filters), params)
	},
})

const cloudflareInfraWorkerCounters = defineQuery({
	id: "cloudflareInfraWorkerCounters",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraWorkersRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		return CH.compile(Integrations.cloudflareWorkerCountersSQL(), params)
	},
})

const cloudflareInfraWorkerLatency = defineQuery({
	id: "cloudflareInfraWorkerLatency",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraWorkersRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		return CH.compile(Integrations.cloudflareWorkerLatencySQL(), params)
	},
})

const cloudflareInfraQueueGauges = defineQuery({
	id: "cloudflareInfraQueueGauges",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraPlatformResourcesRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		return CH.compile(Integrations.cloudflareQueueGaugesSQL(), params)
	},
})

const cloudflareInfraDurableObjects = defineQuery({
	id: "cloudflareInfraDurableObjects",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraPlatformResourcesRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		return CH.compile(Integrations.cloudflareDurableObjectCountersSQL(), params)
	},
})

const cloudflareServiceCounters = defineQuery({
	id: "cloudflareServiceCounters",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceCloudflareStatsRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		// Counters (metrics_sum) + percentiles (metrics_gauge) run
		// concurrently, then merge by ServiceName. Routed through the org's
		// configured warehouse exactly like the metric explorer reads these
		// same `cloudflare.*` metrics — no special ingest pin needed.
		return CH.compile(Integrations.cloudflareServiceCountersSQL(), params)
	},
})

const cloudflareServiceLatency = defineQuery({
	id: "cloudflareServiceLatency",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceCloudflareStatsRequest, orgId: OrgId) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		// Counters (metrics_sum) + percentiles (metrics_gauge) run
		// concurrently, then merge by ServiceName. Routed through the org's
		// configured warehouse exactly like the metric explorer reads these
		// same `cloudflare.*` metrics — no special ingest pin needed.
		return CH.compile(Integrations.cloudflareServiceLatencySQL(), params)
	},
})

const planetscaleInfraTimeseries = defineQuery({
	id: "planetscaleInfraTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: PlanetScaleInfraTimeseriesRequest, orgId: OrgId) => {
		const base = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			bucketSeconds: Math.max(60, Math.floor(payload.bucketSeconds)),
			database: payload.database,
		}
		return payload.branch === undefined
			? CH.compile(Integrations.planetscaleInfraTimeseriesSQL(), base)
			: CH.compile(Integrations.planetscaleBranchInfraTimeseriesSQL(), {
					...base,
					branch: payload.branch,
				})
	},
})

const railwayInfraServices = defineQuery({
	id: "railwayInfraServices",
	profile: "aggregation",
	cache: 15,
	compile: (payload: RailwayInfraServicesRequest, orgId: OrgId) =>
		CH.compile(Integrations.railwayServicesSQL(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const railwayInfraServiceTimeseries = defineQuery({
	id: "railwayInfraServiceTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: RailwayInfraServiceTimeseriesRequest, orgId: OrgId) =>
		CH.compile(Integrations.railwayServiceTimeseriesSQL(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			bucketSeconds: Math.max(60, Math.floor(payload.bucketSeconds)),
			environmentId: payload.environmentId,
			serviceId: payload.serviceId,
		}),
})

// /infra/supabase: gauges and counter rates are separate reads (metrics_gauge, metrics_sum),
// merged per project or bucket by the handler.
const supabaseInfraProjectGauges = defineQuery({
	id: "supabaseInfraProjectGauges",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseInfraProjectsRequest, orgId: OrgId) =>
		CH.compile(Integrations.supabaseProjectGaugesSQL(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const supabaseInfraProjectCpu = defineQuery({
	id: "supabaseInfraProjectCpu",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseInfraProjectsRequest, orgId: OrgId) =>
		CH.compile(Integrations.supabaseProjectCpuSQL(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const supabaseProjectSeriesParams = (payload: SupabaseInfraProjectTimeseriesRequest, orgId: OrgId) => ({
	orgId,
	startTime: payload.startTime,
	endTime: payload.endTime,
	bucketSeconds: Math.max(60, Math.floor(payload.bucketSeconds)),
	projectRef: payload.projectRef,
})

const supabaseInfraProjectGaugeSeries = defineQuery({
	id: "supabaseInfraProjectGaugeSeries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseInfraProjectTimeseriesRequest, orgId: OrgId) =>
		CH.compile(Integrations.supabaseProjectGaugeSeriesSQL(), supabaseProjectSeriesParams(payload, orgId)),
})

const supabaseInfraProjectRateSeries = defineQuery({
	id: "supabaseInfraProjectRateSeries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseInfraProjectTimeseriesRequest, orgId: OrgId) =>
		CH.compile(Integrations.supabaseProjectRateSeriesSQL(), supabaseProjectSeriesParams(payload, orgId)),
})

// /infra/supabase insights: the polled Supabase logs and the org's client spans to a project.
const supabaseProjectParams = (payload: SupabaseProjectWindowRequest, orgId: OrgId) => ({
	orgId,
	startTime: payload.startTime,
	endTime: payload.endTime,
	projectRef: payload.projectRef,
})

const supabaseLogsProjectsSummary = defineQuery({
	id: "supabaseLogsProjectsSummary",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseInfraProjectsRequest, orgId: OrgId) =>
		CH.compile(Integrations.supabaseLogsProjectsSummarySQL(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const supabaseApiTrafficSeries = defineQuery({
	id: "supabaseApiTrafficSeries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseInfraProjectTimeseriesRequest, orgId: OrgId) =>
		CH.compile(Integrations.supabaseApiTrafficSeriesSQL(), supabaseProjectSeriesParams(payload, orgId)),
})

const supabaseApiTrafficTotals = defineQuery({
	id: "supabaseApiTrafficTotals",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseProjectWindowRequest, orgId: OrgId) =>
		CH.compile(Integrations.supabaseApiTrafficTotalsSQL(), supabaseProjectParams(payload, orgId)),
})

const supabaseApiTopPaths = defineQuery({
	id: "supabaseApiTopPaths",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseProjectWindowRequest, orgId: OrgId) =>
		CH.compile(Integrations.supabaseApiTopPathsSQL(), supabaseProjectParams(payload, orgId)),
})

const supabaseProjectCallers = defineQuery({
	id: "supabaseProjectCallers",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseInfraProjectTimeseriesRequest, orgId: OrgId) =>
		CH.compile(Integrations.supabaseProjectCallersSQL(), supabaseProjectParams(payload, orgId)),
})

const supabaseProjectCallerSeries = defineQuery({
	id: "supabaseProjectCallerSeries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseInfraProjectTimeseriesRequest, orgId: OrgId) =>
		CH.compile(
			Integrations.supabaseProjectCallerSeriesSQL(),
			supabaseProjectSeriesParams(payload, orgId),
		),
})

// One project, or (no `projectRef`) every project of the org.
const supabaseLogIssues = defineQuery({
	id: "supabaseLogIssues",
	profile: "aggregation",
	cache: 15,
	compile: (payload: SupabaseLogIssuesRequest, orgId: OrgId) =>
		payload.projectRef === undefined
			? CH.compile(Integrations.supabaseLogIssuesSQL({ byProject: false }), {
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
				})
			: CH.compile(Integrations.supabaseLogIssuesSQL({ byProject: true }), {
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					projectRef: payload.projectRef,
				}),
})

// A small read of the hourly catalog that decides which tabs /infra/aws shows.
const awsInfraPresence = defineQuery({
	id: "awsInfraPresence",
	profile: "discovery",
	cache: 60,
	compile: (payload: AwsInfraPresenceRequest, orgId: OrgId) =>
		CH.compile(Integrations.awsInfraPresenceSQL(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const awsInfraMetrics = defineQuery({
	id: "awsInfraMetrics",
	profile: "aggregation",
	cache: 15,
	compile: (payload: AwsInfraMetricsRequest, orgId: OrgId) =>
		CH.compile(Integrations.awsInfraMetricsSQL(payload.kind), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const awsInfraSparklines = defineQuery({
	id: "awsInfraSparklines",
	profile: "aggregation",
	cache: 15,
	compile: (payload: AwsInfraSparklinesRequest, orgId: OrgId) => {
		// The stream sends one point per minute.
		const bucketSeconds = Math.max(60, payload.bucketSeconds)
		const buckets = Integrations.awsInfraBucketCount(payload.startTime, payload.endTime, bucketSeconds)
		return CH.compile(Integrations.awsInfraSparklinesSQL(payload.kind, buckets), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			bucketSeconds,
		})
	},
})

const awsInfraTimeseries = defineQuery({
	id: "awsInfraTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: AwsInfraTimeseriesRequest, orgId: OrgId) =>
		CH.compile(Integrations.awsInfraTimeseriesSQL(payload.kind, payload.keys), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			bucketSeconds: Math.max(60, payload.bucketSeconds),
		}),
})

// A small read of the hourly catalog that decides which tabs /infra/gcp shows.
const gcpInfraPresence = defineQuery({
	id: "gcpInfraPresence",
	profile: "discovery",
	cache: 60,
	compile: (payload: GcpInfraPresenceRequest, orgId: OrgId) =>
		CH.compile(Integrations.gcpInfraPresenceSQL(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const gcpInfraMetrics = defineQuery({
	id: "gcpInfraMetrics",
	profile: "aggregation",
	cache: 15,
	compile: (payload: GcpInfraMetricsRequest, orgId: OrgId) =>
		CH.compile(Integrations.gcpInfraMetricsSQL(payload.service), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const gcpInfraTimeseries = defineQuery({
	id: "gcpInfraTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: GcpInfraTimeseriesRequest, orgId: OrgId) =>
		CH.compile(Integrations.gcpInfraTimeseriesSQL(payload.source, payload.keys), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			// The poller stores one point per minute.
			bucketSeconds: Math.max(60, payload.bucketSeconds),
		}),
})

const gcpInfraSparklines = defineQuery({
	id: "gcpInfraSparklines",
	profile: "aggregation",
	cache: 15,
	compile: (payload: GcpInfraSparklinesRequest, orgId: OrgId) =>
		CH.compile(Integrations.gcpInfraSparklinesSQL(payload.service), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			// The poller stores one point per minute.
			bucketSeconds: Math.max(60, payload.bucketSeconds),
		}),
})

const gcpCloudSqlTopQueries = defineQuery({
	id: "gcpCloudSqlTopQueries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: GcpCloudSqlInstanceRequest, orgId: OrgId) =>
		CH.compile(Integrations.gcpCloudSqlTopQueriesSQL(payload.keys), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const gcpCloudSqlDatabases = defineQuery({
	id: "gcpCloudSqlDatabases",
	profile: "list",
	cache: 15,
	compile: (payload: GcpCloudSqlInstanceRequest, orgId: OrgId) =>
		CH.compile(Integrations.gcpCloudSqlDatabasesSQL(payload.keys), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

const gcpCloudSqlStatementSpans = defineQuery({
	id: "gcpCloudSqlStatementSpans",
	profile: "list",
	cache: 15,
	compile: (payload: GcpCloudSqlStatementSpansRequest, orgId: OrgId) =>
		CH.compile(
			CH.serviceDbQuerySpansQuery({
				dbSystem: "postgresql",
				dbNamespaces: payload.databases,
				queryKeys: payload.queryKeys,
				limit: 5,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

const zoneDetailParams = (payload: CloudflareInfraZoneDetailRequest, orgId: OrgId) => ({
	orgId,
	serviceName: payload.serviceName,
	startTime: payload.startTime,
	endTime: payload.endTime,
	bucketSeconds: payload.bucketSeconds,
})

const cloudflareInfraZoneDetailStatus = defineQuery({
	id: "cloudflareInfraZoneDetailStatus",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneDetailRequest, orgId: OrgId) =>
		CH.compile(
			Integrations.cloudflareZoneStatusTimeseriesSQL(toCloudflareFilters(payload)),
			zoneDetailParams(payload, orgId),
		),
})

const cloudflareInfraZoneDetailCache = defineQuery({
	id: "cloudflareInfraZoneDetailCache",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneDetailRequest, orgId: OrgId) =>
		CH.compile(
			Integrations.cloudflareZoneCacheTimeseriesSQL(toCloudflareFilters(payload)),
			zoneDetailParams(payload, orgId),
		),
})

/** Latency comes from a gauge family that honors no request filters — hence the no-arg SQL. */
const cloudflareInfraZoneDetailLatency = defineQuery({
	id: "cloudflareInfraZoneDetailLatency",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneDetailRequest, orgId: OrgId) =>
		CH.compile(Integrations.cloudflareZoneLatencyTimeseriesSQL(), zoneDetailParams(payload, orgId)),
})

const workerDetailParams = (payload: CloudflareInfraWorkerDetailRequest, orgId: OrgId) => ({
	orgId,
	serviceName: payload.serviceName,
	startTime: payload.startTime,
	endTime: payload.endTime,
	bucketSeconds: payload.bucketSeconds,
	// Declared by the query either way; only read when `byAccount` adds the condition.
	accountId: payload.accountId ?? "",
})

const workerDetailOpts = (payload: CloudflareInfraWorkerDetailRequest) => ({
	// Rows without the account attribute carry "", which would match nothing: treat it as absent.
	byAccount: (payload.accountId ?? "") !== "",
})

const cloudflareInfraWorkerDetailOutcomes = defineQuery({
	id: "cloudflareInfraWorkerDetailOutcomes",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraWorkerDetailRequest, orgId: OrgId) =>
		CH.compile(
			Integrations.cloudflareWorkerOutcomeTimeseriesSQL(workerDetailOpts(payload)),
			workerDetailParams(payload, orgId),
		),
})

const cloudflareInfraWorkerDetailLatency = defineQuery({
	id: "cloudflareInfraWorkerDetailLatency",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraWorkerDetailRequest, orgId: OrgId) =>
		CH.compile(
			Integrations.cloudflareWorkerLatencyTimeseriesSQL(workerDetailOpts(payload)),
			workerDetailParams(payload, orgId),
		),
})

const cloudflareInfraWorkerDetailDurableObjects = defineQuery({
	id: "cloudflareInfraWorkerDetailDurableObjects",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraWorkerDetailRequest, orgId: OrgId) =>
		CH.compile(
			Integrations.cloudflareWorkerDurableObjectTimeseriesSQL(workerDetailOpts(payload)),
			workerDetailParams(payload, orgId),
		),
})

// Each reads either the database-level or the branch-level rollup depending on
// whether a database was requested. The branch lives inside `compile` so the id,
// profile and row schema stay one decision per sub-query rather than two.

const planetscaleStatsParams = (payload: ServicePlanetScaleStatsRequest, orgId: OrgId) => ({
	orgId,
	startTime: payload.startTime,
	endTime: payload.endTime,
})

const planetscaleServiceGauges = defineQuery({
	id: "planetscaleServiceGauges",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServicePlanetScaleStatsRequest, orgId: OrgId) => {
		const params = planetscaleStatsParams(payload, orgId)
		return payload.database !== undefined
			? CH.compile(Integrations.planetscaleBranchGaugesSQL(), { ...params, database: payload.database })
			: CH.compile(Integrations.planetscaleGaugesSQL(), params)
	},
})

const planetscaleServiceConnections = defineQuery({
	id: "planetscaleServiceConnections",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServicePlanetScaleStatsRequest, orgId: OrgId) => {
		const params = planetscaleStatsParams(payload, orgId)
		return payload.database !== undefined
			? CH.compile(Integrations.planetscaleBranchConnectionsSQL(), {
					...params,
					database: payload.database,
				})
			: CH.compile(Integrations.planetscaleConnectionsSQL(), params)
	},
})

const planetscaleServiceStorage = defineQuery({
	id: "planetscaleServiceStorage",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServicePlanetScaleStatsRequest, orgId: OrgId) => {
		const params = planetscaleStatsParams(payload, orgId)
		return payload.database !== undefined
			? CH.compile(
					Integrations.planetscaleBranchStorageSQL(),
					{ ...params, database: payload.database },
					{
						rowSchema: Integrations.planetscaleBranchStorageRowSchema,
					},
				)
			: CH.compile(Integrations.planetscaleStorageSQL(), params, {
					rowSchema: Integrations.planetscaleStorageRowSchema,
				})
	},
})

/**
 * Zone facet counts: 8 UNION branches over the wide Attributes Map column.
 * maxThreads caps read-thread concurrency so per-thread decompression buffers
 * stay inside the discovery memory budget — same guard as podFacets.
 */
const cloudflareInfraZoneFacets = defineQuery({
	id: "cloudflareInfraZoneFacets",
	profile: "discovery",
	settings: { maxThreads: 4 },
	cache: 60,
	compile: (payload: CloudflareInfraZoneFacetsRequest, orgId: OrgId) =>
		CH.compileUnion(Integrations.cloudflareZoneFacetsQuery(toCloudflareFilters(payload)), {
			orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

// Network reads a counter family, everything else a gauge family, so they are
// separate defs rather than one def with a branch — the row shapes differ and
// the handler maps them differently. Both keep the id "hostInfraTimeseries",
// which is what their spans already report; renaming would break continuity of
// existing telemetry for no gain.

const hostInfraNetworkTimeseries = defineQuery({
	id: "hostInfraTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: HostInfraTimeseriesRequest, orgId: OrgId) =>
		CH.compile(CH.hostNetworkTimeseriesQuery({ hostName: payload.hostName }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			bucketSeconds: payload.bucketSeconds ?? 60,
		}),
})

const hostInfraGaugeTimeseries = defineQuery({
	id: "hostInfraTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: HostInfraTimeseriesRequest, orgId: OrgId) => {
		const spec = hostMetricSpec(payload.metric)
		return CH.compile(
			CH.hostGaugeTimeseriesQuery({
				hostName: payload.hostName,
				metricName: spec.metricName,
				groupByAttributeKey: spec.groupByAttributeKey,
				attributeIn: spec.attributeIn,
				attributeNotIn: spec.attributeNotIn,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds: payload.bucketSeconds ?? 60,
			},
		)
	},
})

// Same split as the host defs: sum metrics (network, block IO, memory bytes)
// read metrics_sum, everything else the gauge family. Both keep the id
// "containerInfraTimeseries" for span continuity.

const containerInfraSumTimeseries = defineQuery({
	id: "containerInfraTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ContainerInfraTimeseriesRequest, orgId: OrgId) => {
		const spec = containerMetricSpec(payload.metric)
		return CH.compile(
			CH.containerSumTimeseriesQuery({
				containerName: payload.containerName,
				hostName: payload.hostName,
				metricNames: spec.metricNames,
				metricLabels: spec.metricLabels,
				groupByAttributeKey: spec.groupByAttributeKey,
				average: spec.average,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds: payload.bucketSeconds ?? 60,
			},
		)
	},
})

const containerInfraGaugeTimeseries = defineQuery({
	id: "containerInfraTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ContainerInfraTimeseriesRequest, orgId: OrgId) => {
		const spec = containerMetricSpec(payload.metric)
		return CH.compile(
			CH.containerGaugeTimeseriesQuery({
				containerName: payload.containerName,
				hostName: payload.hostName,
				metricName: spec.metricNames[0]!,
				divideBy: spec.divideBy,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds: payload.bucketSeconds ?? 60,
			},
		)
	},
})

const zoneBreakdownParams = (payload: CloudflareInfraZoneBreakdownRequest, orgId: OrgId) => ({
	orgId,
	serviceName: payload.serviceName,
	startTime: payload.startTime,
	endTime: payload.endTime,
})

const cloudflareInfraZoneBreakdownTotals = defineQuery({
	id: "cloudflareInfraZoneBreakdownTotals",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneBreakdownRequest, orgId: OrgId) => {
		return CH.compile(
			Integrations.cloudflareZoneBreakdownTotalsSQL(
				payload.dimension,
				toCloudflareFilters(payload),
				payload.limit ?? 100,
			),
			zoneBreakdownParams(payload, orgId),
		)
	},
})

/**
 * Coverage is deliberately UNFILTERED: it answers "what did the poller collect
 * here", which the UI needs in order to say "not collected yet" rather than "no
 * traffic" for a window that predates the dataset. Do not thread filters in.
 */
const cloudflareInfraZoneBreakdownCoverage = defineQuery({
	id: "cloudflareInfraZoneBreakdownCoverage",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneBreakdownRequest, orgId: OrgId) =>
		CH.compile(
			Integrations.cloudflareZoneBreakdownCoverageSQL(payload.dimension),
			zoneBreakdownParams(payload, orgId),
		),
})

const cloudflareInfraZoneBreakdownZoneTotal = defineQuery({
	id: "cloudflareInfraZoneBreakdownZoneTotal",
	profile: "aggregation",
	cache: 15,
	compile: (payload: CloudflareInfraZoneBreakdownRequest, orgId: OrgId) =>
		CH.compile(
			Integrations.cloudflareZoneCountersSQL(toCloudflareFilters(payload)),
			zoneBreakdownParams(payload, orgId),
		),
})

/**
 * The chart runs AFTER the totals rather than beside them: totals are already
 * ranked by requests, so they name the series worth plotting. Without that the
 * grouping is unbounded — a zone taking scanner traffic returns a distinct path
 * per probe, and the response grows to buckets x thousands of keys. One extra
 * round trip over the same warm scan buys a payload that can't blow up.
 *
 * `topKeys` therefore rides in the PAYLOAD rather than being derived inside
 * `compile`: it is the output of a previous query, which a def has no way to
 * see. The caller must also skip this entirely when `topKeys` is empty.
 */
const cloudflareInfraZoneBreakdownTimeseries = defineQuery({
	id: "cloudflareInfraZoneBreakdownTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (
		payload: CloudflareInfraZoneBreakdownRequest & { readonly topKeys: ReadonlyArray<string> },
		orgId: OrgId,
	) =>
		CH.compile(
			Integrations.cloudflareZoneBreakdownTimeseriesSQL(
				payload.dimension,
				toCloudflareFilters(payload),
				payload.topKeys,
			),
			{ ...zoneBreakdownParams(payload, orgId), bucketSeconds: payload.bucketSeconds },
		),
})

export const Queries = {
	...Core,

	/**
	 * Bounded to a ±1h window around the requested log so ClickHouse can prune
	 * partitions instead of reading every retained daily partition for an
	 * exact-timestamp match. That window used to be computed in the handler.
	 */
	getLog: defineQuery({
		id: "getLog",
		profile: "list",
		cache: 15,
		compile: (payload: GetLogRequest, orgId: OrgId) => {
			const { startTime, endTime } = partitionWindowAround(payload.timestamp)
			return CH.compile(
				CH.getLogByKeyQuery({
					serviceName: payload.serviceName,
					traceId: payload.traceId,
					spanId: payload.spanId,
				}),
				{ orgId, startTime, endTime, timestamp: payload.timestamp },
			)
		},
	}),

	/**
	 * A finished trace is immutable and cacheable; one still receiving spans is
	 * not. `traceCacheTtlSeconds` decides from the requested end time against
	 * now, which is why this def takes the dynamic-cache form.
	 */
	spanDetail: defineQuery({
		id: "spanDetail",
		profile: "discovery",
		cache: (payload: SpanDetailRequest, nowMs: number) => traceCacheTtlSeconds(payload.endTime, nowMs),
		compile: (payload: SpanDetailRequest, orgId: OrgId) => {
			// Without both bounds there is no window to narrow to, and passing a
			// half-open range would widen the scan rather than prune it.
			const narrowByTime = payload.startTime != null && payload.endTime != null
			return CH.compile(
				CH.spanDetailQuery({
					traceId: payload.traceId,
					spanId: payload.spanId,
					narrowByTime,
				}),
				narrowByTime ? { orgId, startTime: payload.startTime, endTime: payload.endTime } : { orgId },
			)
		},
	}),

	/**
	 * Events of a span `spanDetail` already resolved. Keyed by the span's exact
	 * start second, so the row it reads is written and immutable.
	 */
	spanEvents: defineQuery({
		id: "spanEvents",
		profile: "discovery",
		cache: 600,
		compile: (
			payload: {
				readonly traceId: string
				readonly spanId: string
				readonly serviceName: string
				readonly spanName: string
				readonly startTime: string
				readonly endTime: string
			},
			orgId: OrgId,
		) =>
			CH.compile(
				CH.spanEventsQuery({
					traceId: payload.traceId,
					spanId: payload.spanId,
					serviceName: payload.serviceName,
					spanName: payload.spanName,
				}),
				{ orgId, startTime: payload.startTime, endTime: payload.endTime },
			),
	}),

	/** Event times and names for every span of a trace, for the timeline markers. */
	traceSpanEvents: defineQuery({
		id: "traceSpanEvents",
		profile: "list",
		cache: (payload: TraceSpanEventsRequest, nowMs: number) =>
			traceCacheTtlSeconds(payload.endTime, nowMs),
		compile: (payload: TraceSpanEventsRequest, orgId: OrgId) =>
			CH.compile(CH.spanEventsByTraceQuery({ traceId: payload.traceId }), {
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
			}),
	}),

	podInfraTimeseries: defineQuery({
		id: "podInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: PodInfraTimeseriesRequest, orgId: OrgId) =>
			CH.compile(
				CH.podGaugeTimeseriesQuery({
					podName: payload.podName,
					namespace: payload.namespace,
					metricName: podMetricSpec(payload.metric).metricName,
				}),
				{
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					bucketSeconds: payload.bucketSeconds ?? 60,
				},
			),
	}),

	nodeInfraTimeseries: defineQuery({
		id: "nodeInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: NodeInfraTimeseriesRequest, orgId: OrgId) =>
			CH.compile(
				CH.nodeGaugeTimeseriesQuery({
					nodeName: payload.nodeName,
					...nodeMetricSpec(payload.metric),
				}),
				{
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					bucketSeconds: payload.bucketSeconds ?? 60,
				},
			),
	}),

	workloadInfraTimeseries: defineQuery({
		id: "workloadInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: WorkloadInfraTimeseriesRequest, orgId: OrgId) =>
			CH.compile(
				CH.workloadGaugeTimeseriesQuery({
					kind: payload.kind,
					workloadName: payload.workloadName,
					namespace: payload.namespace,
					metricName: workloadMetricSpec(payload.metric).metricName,
					groupByPod: payload.groupByPod,
				}),
				{
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					bucketSeconds: payload.bucketSeconds ?? 60,
				},
			),
	}),

	cloudflareInfraZoneTimeseries: defineQuery({
		id: "cloudflareInfraZoneTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: CloudflareInfraZoneTimeseriesRequest, orgId: OrgId) =>
			CH.compile(Integrations.cloudflareZoneTimeseriesSQL(toCloudflareFilters(payload)), {
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds: payload.bucketSeconds,
			}),
	}),

	// Integration queries, declared above.
	cloudflareInfraZoneCounters,
	cloudflareInfraZoneLatency,
	cloudflareInfraZoneFirewallTimeseries,
	cloudflareInfraZoneFirewallTop,
	cloudflareInfraZoneDnsTimeseries,
	cloudflareInfraZoneDnsBreakdown,
	cloudflareInfraWorkerCounters,
	cloudflareInfraWorkerLatency,
	cloudflareInfraQueueGauges,
	cloudflareInfraDurableObjects,
	cloudflareServiceCounters,
	cloudflareServiceLatency,
	planetscaleInfraTimeseries,
	railwayInfraServices,
	railwayInfraServiceTimeseries,
	supabaseInfraProjectGauges,
	supabaseInfraProjectCpu,
	supabaseInfraProjectGaugeSeries,
	supabaseInfraProjectRateSeries,
	supabaseLogsProjectsSummary,
	supabaseApiTrafficSeries,
	supabaseApiTrafficTotals,
	supabaseApiTopPaths,
	supabaseProjectCallers,
	supabaseProjectCallerSeries,
	supabaseLogIssues,
	awsInfraPresence,
	awsInfraMetrics,
	awsInfraSparklines,
	awsInfraTimeseries,
	gcpInfraPresence,
	gcpInfraMetrics,
	gcpInfraTimeseries,
	gcpInfraSparklines,
	gcpCloudSqlTopQueries,
	gcpCloudSqlDatabases,
	gcpCloudSqlStatementSpans,

	// ZoneDetail / PlanetScaleStats sub-queries, declared above.
	cloudflareInfraZoneDetailStatus,
	cloudflareInfraZoneDetailCache,
	cloudflareInfraZoneDetailLatency,
	cloudflareInfraWorkerDetailOutcomes,
	cloudflareInfraWorkerDetailLatency,
	cloudflareInfraWorkerDetailDurableObjects,
	planetscaleServiceGauges,
	planetscaleServiceConnections,
	planetscaleServiceStorage,
	cloudflareInfraZoneFacets,
	hostInfraNetworkTimeseries,
	hostInfraGaugeTimeseries,
	containerInfraSumTimeseries,
	containerInfraGaugeTimeseries,
	cloudflareInfraZoneBreakdownTotals,
	cloudflareInfraZoneBreakdownCoverage,
	cloudflareInfraZoneBreakdownZoneTotal,
	cloudflareInfraZoneBreakdownTimeseries,
} as const
