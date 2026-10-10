import { useMemo } from "react"
import { Link, Navigate, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { GCP_INFRA_SERVICE_IDS, GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { ChartLoading } from "@maple/ui/components/charts"
import { Button } from "@maple/ui/components/ui/button"
import { errorRateLevel } from "@maple/ui/lib/error-rate"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { utilizationLevel } from "@maple/ui/lib/utilization"
import { cn } from "@maple/ui/lib/utils"

import { CHART_HEIGHT } from "@/components/common/chart-card"
import { ErrorState } from "@/components/common/error-state"
import { HeroChip, PageHero } from "@/components/common/page-hero"
import { SectionHeading } from "@/components/common/section-heading"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/common/stat-rail"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	GCP_GKE_NODE_CHARTS,
	GCP_INFRA_CHARTS,
	gcpWindowPoints,
	type GcpBucketPoint,
	type GcpChartWindow,
} from "@/components/infra/gcp/charts"
import { GcpResourceCard } from "@/components/infra/gcp/gcp-resource-card"
import { GcpWorkloadCharts } from "@/components/infra/gcp/gcp-workload-charts"
import {
	gcpExplorerWhere,
	gcpMatchResource,
	gcpResourceQuery,
	gcpWorkloadTelemetry,
} from "@/components/infra/gcp/inventory"
import {
	GCP_INFRA_COLUMNS,
	formatGcpValue,
	gcpWorkload,
	gcpWorkloadKeys,
	gcpWorkloadName,
	gcpWorkloadNoun,
	type GcpColumn,
} from "@/components/infra/gcp/tabs"
import { NoMetricsMessage } from "@/components/infra/primitives/no-metrics-message"
import type { Tone } from "@/components/infra/severity-tokens"
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

/** What a page says it charts, per service. */
const DESCRIPTIONS: Record<GcpInfraServiceId, string> = {
	cloudRun:
		"Requests, latency and container instances of this Cloud Run service, summed over its revisions.",
	cloudFunctions: "Executions, duration and instances of this Cloud Function.",
	gke: "CPU, memory and restarts of this container, over every pod that runs it, and the nodes of its cluster.",
	computeEngine: "CPU, memory, network and disk of this Compute Engine instance.",
	cloudSql: "Utilization, connections and disk operations of this Cloud SQL instance.",
	pubsub: "Backlog and delivery of this Pub/Sub subscription.",
	loadBalancing: "Requests, latency and traffic of this URL map on one backend.",
} satisfies Record<GcpInfraServiceId, string>

function GcpWorkloadRoute() {
	const { service, name } = Route.useParams()
	const id = GCP_INFRA_SERVICE_IDS.find((candidate) => candidate === service)
	// A mistyped service has no page: the list falls back to its first tab.
	return id === undefined ? (
		<Navigate to="/infra/gcp" replace />
	) : (
		<GcpWorkloadPage service={id} name={name} />
	)
}

function GcpWorkloadPage({ service, name }: { service: GcpInfraServiceId; name: string }) {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const range = { startTime, endTime, bucketSeconds: chartBucketSeconds(startTime, endTime) }
	const timeSearch = pickTimeRangeSearch(search)
	const { title, identity } = GCP_INFRA_SERVICES[service]
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
	const workload = gcpWorkload(service, keys, windowPoints)

	// The one inventory resource this workload is, by its identity; none leaves the rail out.
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
	const columns = GCP_INFRA_COLUMNS[service].slice(0, 4)

	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Infrastructure", href: "/infra" },
				// Back to the tab the workload is listed on.
				{ label: "Google Cloud", href: `/infra/gcp?tab=${service}` },
				{ label: gcpWorkloadName(service, keys) },
			]}
			time={{ search, startTime, endTime, defaultPreset: DEFAULT_PRESET, onChange: handleTimeChange }}
			rightPanel={resource === undefined ? undefined : <GcpResourceCard resource={resource} />}
			gap="lg"
		>
			<PageHero
				title={<span className="font-mono">{gcpWorkloadName(service, keys)}</span>}
				trailing={<HeroChip>{title}</HeroChip>}
				description={DESCRIPTIONS[service]}
				meta={identity.slice(1).map(([label], index) =>
					keys[index + 1] ? (
						<HeroChip key={label}>
							{label.toLowerCase()} {keys[index + 1]}
						</HeroChip>
					) : null,
				)}
				actions={
					<>
						<Button
							size="sm"
							variant="outline"
							render={
								<Link
									to="/logs"
									search={{
										...timeSearch,
										services: [telemetry.logsService],
										attrs:
											telemetry.logAttrs.length > 0
												? [...telemetry.logAttrs]
												: undefined,
									}}
								/>
							}
						>
							Logs
						</Button>
						{telemetry.traced ? (
							<TracesLink
								serviceName={telemetry.serviceName}
								startTime={startTime}
								endTime={endTime}
								timeSearch={timeSearch}
							/>
						) : null}
					</>
				}
			/>
			{Result.isInitial(result) ? (
				<>
					<StatRailLoading />
					<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
						{GCP_INFRA_CHARTS[service].map((chart) => (
							<ChartLoading key={chart.title} variant="line" height={CHART_HEIGHT} />
						))}
					</div>
				</>
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
					<StatRail>
						{columns.map((spec, index) => (
							<StatRailItem
								key={spec.label}
								compact
								eyebrow={spec.label}
								value={formatGcpValue(spec.format, workload.values[index])}
								tone={columnTone(spec, workload.values[index])}
								subline={
									spec.total
										? "total in range"
										: spec.format === "errorRate"
											? "share in range"
											: "average in range"
								}
							/>
						))}
					</StatRail>
					<GcpWorkloadCharts
						charts={GCP_INFRA_CHARTS[service]}
						points={points}
						range={range}
						where={gcpExplorerWhere(service, keys)}
						timeSearch={timeSearch}
					/>
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

/** A percent of a limit and an error rate carry a tone; every other number is plain. */
function columnTone(spec: GcpColumn, value: number | undefined): Tone {
	if (value === undefined) return "neutral"
	if (spec.format === "errorRate") return errorRateLevel(value)
	if (spec.format === "percent") return utilizationLevel(value)
	return "neutral"
}

/** Shown when a traced service of the workload's name sent spans in the window. */
function TracesLink({
	serviceName,
	startTime,
	endTime,
	timeSearch,
}: {
	serviceName: string
	startTime: string
	endTime: string
	timeSearch: TimeRangeSearch
}) {
	const result = useAtomValue(getServiceOverviewResultAtom({ data: { startTime, endTime } }))
	const traced = Result.builder(result)
		.onSuccess((response) => response.data.some((row) => row.serviceName === serviceName))
		.orElse(() => false)
	if (!traced) return null
	return (
		<Button
			size="sm"
			variant="outline"
			render={<Link to="/traces" search={{ ...timeSearch, services: [serviceName] }} />}
		>
			Traces
		</Button>
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
