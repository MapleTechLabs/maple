import { useMemo } from "react"
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { GCP_INFRA_SERVICE_IDS, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { GcpCloudSqlTopQueriesResponse } from "@maple/domain/http"
import { windowDurationSeconds } from "@maple/query-engine"
import { ChartLoading } from "@maple/ui/components/charts"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"

import { CHART_HEIGHT } from "@/components/common/chart-card"
import { ErrorState } from "@/components/common/error-state"
import { SectionHeading } from "@/components/common/section-heading"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	GCP_GKE_NODE_CHARTS,
	GCP_INFRA_CHARTS,
	gcpWindowPoints,
	type GcpBucketPoint,
	type GcpChartWindow,
} from "@/components/infra/gcp/charts"
import { GcpWorkloadCharts } from "@/components/infra/gcp/gcp-workload-charts"
import {
	gcpCloudSqlView,
	gcpQueryInsightsUnavailable,
	gcpStatements,
	type GcpStatement,
	type GcpTracedQuery,
} from "@/components/infra/gcp/cloud-sql-signals"
import { GcpCloudSqlTopQueries } from "@/components/infra/gcp/gcp-cloudsql-top-queries"
import {
	GcpAppWaitCallout,
	GcpCloudSqlChips,
	GcpTraceGapCallout,
	GcpWorkloadHeader,
	GcpWorkloadSignals,
} from "@/components/infra/gcp/gcp-workload-page"
import {
	NO_GCP_SPARKS,
	gcpDatabaseRows,
	gcpSqlEngineOf,
	type GcpReplica,
} from "@/components/infra/gcp/list-model"
import { GcpWorkloadRail } from "@/components/infra/gcp/gcp-workload-rail"
import {
	GCP_CLOUD_SQL_INVENTORY_QUERY,
	gcpCloudSqlInstances,
	gcpConsoleLinks,
	gcpExplorerWhere,
	gcpMatchResource,
	gcpResourceQuery,
	gcpWorkloadTelemetry,
	type GcpCloudSqlInstance,
} from "@/components/infra/gcp/inventory"
import {
	gcpWorkload,
	gcpWorkloadKeys,
	gcpWorkloadLocation,
	gcpWorkloadName,
	gcpWorkloadNoun,
	gcpWorkloadProject,
	gcpWorkloadTone,
} from "@/components/infra/gcp/tabs"
import { gcpRailFacts, gcpTraceGap, gcpTracedErrors } from "@/components/infra/gcp/workload-signals"
import { NoMetricsMessage } from "@/components/infra/primitives/no-metrics-message"
import { DashboardPage } from "@/components/layout/dashboard-page"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
	type TimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import type { TimeRange } from "@/components/time-range-picker/types"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import {
	gcpCloudSqlTopQueriesResultAtom,
	gcpCloudSqlTraceSideResultAtom,
	gcpInfraFleetResultAtom,
	gcpInfraTimeseriesResultAtom,
	getServiceOverviewResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

const gcpWorkloadSearchSchema = Schema.Struct({
	// The workload's identity after its name: see `gcpWorkloadSearch`.
	project: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
	namespace: Schema.optional(Schema.String),
	cluster: Schema.optional(Schema.String),
	location: Schema.optional(Schema.String),
	zone: Schema.optional(Schema.String),
	backend: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/gcp/$service/$name")({
	component: GcpWorkloadRoute,
	validateSearch: Schema.toStandardSchemaV1(gcpWorkloadSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const DEFAULT_PRESET = "1h"

/** Stable empty fallback so memos don't recompute on every render. */
const NO_POINTS: ReadonlyArray<GcpBucketPoint> = []

function GcpWorkloadRoute() {
	const { service, name } = Route.useParams()
	const id = GCP_INFRA_SERVICE_IDS.find((candidate) => candidate === service)
	// A mistyped service has no page: the list falls back to its first tab.
	return id === undefined ? (
		<Navigate to="/infra/gcp" replace />
	) : id === "cloudSql" ? (
		<GcpCloudSqlPage name={name} />
	) : (
		<GcpWorkloadPage service={id} name={name} />
	)
}

/** What a Cloud SQL instance's page reads besides its metrics. */
interface CloudSqlReads {
	/** Undefined until the inventory answers, or for an instance it does not list. */
	readonly instance: GcpCloudSqlInstance | undefined
	readonly topQueries: Result.Result<
		{ readonly statements: GcpCloudSqlTopQueriesResponse["data"] },
		unknown
	>
	/** Undefined while it loads, or when the databases could not be listed. */
	readonly traceSide:
		| {
				readonly databases: ReadonlyArray<string>
				readonly tracedQueries: ReadonlyArray<GcpTracedQuery>
				readonly services: number
		  }
		| undefined
	readonly replicas: ReadonlyArray<GcpReplica>
}

/** A Cloud SQL instance's page: its settings, statements, the traces' view of them, its replicas. */
function GcpCloudSqlPage({ name }: { name: string }) {
	const search = Route.useSearch()
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const window = { startTime, endTime, keys: gcpWorkloadKeys("cloudSql", name, search) }
	const inventoryResult = useAtomValue(
		retainedInternalQuery("integrations", "gcpResources", {
			query: GCP_CLOUD_SQL_INVENTORY_QUERY,
			reactivityKeys: ["gcpIntegration"],
		}),
	)
	const topQueries = useRefreshableAtomValue(gcpCloudSqlTopQueriesResultAtom({ data: window }))
	const traceSideResult = useRefreshableAtomValue(gcpCloudSqlTraceSideResultAtom({ data: window }))
	// The fleet holds the replicas' lag; the list reads the same window.
	const fleetResult = useAtomValue(gcpInfraFleetResultAtom({ data: { startTime, endTime } }))
	const instances = useMemo(
		() =>
			Result.builder(inventoryResult)
				.onSuccess((inventory) => gcpCloudSqlInstances(inventory.resources))
				.orElse(() => undefined),
		[inventoryResult],
	)
	const replicas = useMemo(
		() =>
			Result.builder(fleetResult)
				.onSuccess(
					(response) =>
						gcpDatabaseRows(response.services, NO_GCP_SPARKS, instances).find(
							(row) => row.keys[0] === name,
						)?.replicas ?? NO_REPLICAS,
				)
				.orElse(() => NO_REPLICAS),
		[fleetResult, instances, name],
	)
	const cloudSql: CloudSqlReads = {
		instance: instances?.find((instance) => instance.id === name),
		topQueries,
		traceSide: Result.builder(traceSideResult)
			.onSuccess((response) => response)
			.orElse(() => undefined),
		replicas,
	}
	return <GcpWorkloadPage service="cloudSql" name={name} cloudSql={cloudSql} />
}

const NO_REPLICAS: ReadonlyArray<GcpReplica> = []
const NO_STATEMENTS: ReadonlyArray<GcpStatement> = []
const NO_TRACED_QUERIES: ReadonlyArray<GcpTracedQuery> = []

function GcpWorkloadPage({
	service,
	name,
	cloudSql,
}: {
	service: GcpInfraServiceId
	name: string
	cloudSql?: CloudSqlReads
}) {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	const range = { startTime, endTime, bucketSeconds }
	const timeSearch = pickTimeRangeSearch(search)
	const keys = gcpWorkloadKeys(service, name, search)

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	const timeseriesAtom = gcpInfraTimeseriesResultAtom({ data: { ...range, source: service, keys } })
	const result = useRefreshableAtomValue(timeseriesAtom)
	const refreshTimeseries = useAtomRefresh(timeseriesAtom)
	const points = Result.builder(result)
		.onSuccess((response) => response.points)
		.orElse(() => NO_POINTS)
	const windowPoints = useMemo(() => gcpWindowPoints(points), [points])

	// The one inventory resource this workload is, by its identity; none leaves its facts out.
	const inventoryResult = useAtomValue(
		retainedInternalQuery("integrations", "gcpResources", {
			query: gcpResourceQuery(service, keys),
			reactivityKeys: ["gcpIntegration"],
		}),
	)
	const resource = Result.builder(inventoryResult)
		.onSuccess((inventory) => gcpMatchResource(service, keys, inventory.resources))
		.orElse(() => undefined)

	const telemetry = gcpWorkloadTelemetry(service, keys)
	const logs = { service: telemetry.logsService, attrs: telemetry.logAttrs }

	// The traced service of the workload's name, and the errors its entry spans recorded.
	const overviewResult = useAtomValue(getServiceOverviewResultAtom({ data: { startTime, endTime } }))
	const tracedErrors = telemetry.traced
		? Result.builder(overviewResult)
				.onSuccess((response) =>
					gcpTracedErrors(
						response.data,
						telemetry.serviceName,
						windowDurationSeconds(startTime, endTime),
					),
				)
				.orElse(() => null)
		: null
	const tracedService = tracedErrors === null ? null : telemetry.serviceName
	const gap = gcpTraceGap(service, points, bucketSeconds, tracedErrors)
	const isCloudSql = cloudSql !== undefined
	const instance = cloudSql?.instance
	const traceSide = cloudSql?.traceSide
	const replicas = cloudSql?.replicas ?? NO_REPLICAS
	const topQueries =
		cloudSql === undefined
			? undefined
			: Result.map(cloudSql.topQueries, (response) => ({
					rows: gcpStatements(response.statements, points),
					unavailableReason: gcpQueryInsightsUnavailable(instance),
				}))
	const statements =
		topQueries !== undefined && Result.isSuccess(topQueries) ? topQueries.value.rows : NO_STATEMENTS
	const sql = isCloudSql
		? gcpCloudSqlView({
				instance,
				statements,
				tracedQueries: traceSide?.tracedQueries ?? NO_TRACED_QUERIES,
				databases: traceSide?.databases,
				replicas,
				points,
				bucketSeconds,
			})
		: undefined
	const facts = sql?.facts ?? gcpRailFacts(service, points, bucketSeconds)
	const databaseVersion = isCloudSql ? (instance?.databaseVersion ?? gcpSqlEngineOf(points)) : undefined

	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Infrastructure", href: "/infra" },
				// Back to the tab the workload is listed on.
				{ label: "Google Cloud", href: `/infra/gcp?tab=${service}` },
				{ label: gcpWorkloadName(service, keys) },
			]}
			time={{ search, startTime, endTime, defaultPreset: DEFAULT_PRESET, onChange: handleTimeChange }}
			rightPanel={
				<GcpWorkloadRail
					service={service}
					project={gcpWorkloadProject(service, keys) || undefined}
					location={gcpWorkloadLocation(service, keys) || undefined}
					resource={resource}
					facts={facts}
					health={sql?.health}
					// Only once the overview answered: loading or failed is not "no spans".
					traced={
						telemetry.traced && Result.isSuccess(overviewResult)
							? { name: telemetry.serviceName, service: tracedService }
							: undefined
					}
					logs={logs}
					serviceMap={sql === undefined ? undefined : { focusService: sql.focusService }}
					consoleLinks={gcpConsoleLinks(service, keys)}
					timeSearch={timeSearch}
				/>
			}
			titleContent={
				<GcpWorkloadHeader
					service={service}
					keys={keys}
					health={
						points.length === 0 ? null : gcpWorkloadTone(gcpWorkload(service, keys, windowPoints))
					}
					databaseVersion={databaseVersion}
					meta={
						cloudSql === undefined ? undefined : (
							<GcpCloudSqlChips
								keys={keys}
								instance={cloudSql.instance}
								databaseVersion={databaseVersion}
								services={cloudSql.traceSide?.services}
							/>
						)
					}
				/>
			}
			gap="lg"
		>
			{Result.isInitial(result) ? (
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
					{GCP_INFRA_CHARTS[service].map((chart) => (
						<ChartLoading key={chart.title} variant="line" height={CHART_HEIGHT} />
					))}
				</div>
			) : Result.isFailure(result) && points.length === 0 ? (
				<ErrorState
					error={result.cause}
					title="Failed to load workload metrics"
					onRetry={refreshTimeseries}
				/>
			) : points.length === 0 ? (
				<NoMetricsMessage noun={gcpWorkloadNoun(service)} />
			) : (
				<div
					className={cn("space-y-6", refreshingClass(Boolean(result.waiting)))}
					aria-busy={result.waiting || undefined}
				>
					{gap === null ||
					tracedService === null ||
					(service !== "cloudRun" && service !== "cloudFunctions") ? null : (
						<GcpTraceGapCallout
							service={service}
							gap={gap}
							tracedService={tracedService}
							logsService={telemetry.logsService}
						/>
					)}
					{sql === undefined || sql.wait === null ? null : (
						<GcpAppWaitCallout
							wait={sql.wait}
							peak={sql.peak}
							instanceName={gcpWorkloadName(service, keys)}
							timeSearch={timeSearch}
						/>
					)}
					<GcpWorkloadSignals
						service={service}
						points={points}
						range={range}
						where={gcpExplorerWhere(service, keys)}
						timeSearch={timeSearch}
						maxConnections={cloudSql?.instance?.maxConnections ?? null}
					>
						{topQueries === undefined || sql === undefined ? null : (
							<GcpCloudSqlTopQueries insights={topQueries} traced={sql.traced} />
						)}
					</GcpWorkloadSignals>
				</div>
			)}
			{service === "gke" ? (
				<GkeClusterNodes
					// Cluster, project and location: the identity of the `gkeNodes` source.
					keys={keys.slice(2)}
					range={range}
					timeSearch={timeSearch}
				/>
			) : null}
		</DashboardPage>
	)
}

/** The cluster's nodes, averaged over them: Cloud Monitoring keeps no node names in these series. */
function GkeClusterNodes({
	keys,
	range,
	timeSearch,
}: {
	keys: ReadonlyArray<string>
	range: GcpChartWindow
	timeSearch: TimeRangeSearch
}) {
	const result = useRefreshableAtomValue(
		gcpInfraTimeseriesResultAtom({ data: { ...range, source: "gkeNodes", keys } }),
	)
	const points = Result.builder(result)
		.onSuccess((response) => response.points)
		.orElse(() => NO_POINTS)
	if (points.length === 0) return null
	return (
		<section
			className={cn("space-y-3", refreshingClass(Boolean(result.waiting)))}
			aria-busy={result.waiting || undefined}
		>
			<SectionHeading
				title={`Nodes of ${keys[0]}`}
				hint="share of allocatable, averaged over the cluster's nodes"
			/>
			<GcpWorkloadCharts
				charts={GCP_GKE_NODE_CHARTS}
				points={points}
				range={range}
				where={gcpExplorerWhere("gkeNodes", keys)}
				timeSearch={timeSearch}
			/>
		</section>
	)
}
