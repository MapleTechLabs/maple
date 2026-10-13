import { useDeferredValue, useMemo, useState, type ReactNode } from "react"
import { SectionHeading } from "@/components/common/section-heading"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result } from "@/lib/effect-atom"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { DocsLink } from "@/components/common/docs-link"
import { ResultView } from "@/components/common/result-view"
import { CloudflareIcon } from "@/components/icons"
import { CompactFilterInput } from "@/components/infra/cloudflare/compact-filter-input"
import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import {
	CloudflareKpiCards,
	CloudflareKpiCardsLoading,
} from "@/components/infra/cloudflare/cloudflare-kpi-cards"
import {
	CloudflareIngestBanner,
	CloudflareIngestEmpty,
	CloudflareStalledAction,
} from "@/components/infra/cloudflare/cloudflare-ingest-status"
import { CloudflareNotConnected } from "@/components/infra/cloudflare/cloudflare-not-connected"
import { CloudflarePlatformSection } from "@/components/infra/cloudflare/cloudflare-platform-table"
import {
	CloudflareWorkerTable,
	CloudflareWorkerTableLoading,
} from "@/components/infra/cloudflare/cloudflare-worker-table"
import { CloudflareZoneChart } from "@/components/infra/cloudflare/cloudflare-zone-chart"
import {
	CloudflareZoneTable,
	CloudflareZoneTableLoading,
} from "@/components/infra/cloudflare/cloudflare-zone-table"
import { MAX_ZONE_SERIES, OTHER_ZONES_SERIES } from "@/components/infra/cloudflare/constants"
import { SeriesLegend } from "@/components/common/series-legend"
import { ChartLoading, OTHER_COLOR } from "@maple/ui/components/charts"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	cloudflareWorkersResultAtom,
	cloudflareZonesResultAtom,
	cloudflareZoneTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useCloudflareIngestPhase } from "@/components/infra/cloudflare/use-cloudflare-ingest-phase"
import type { CloudflareIngestPhase } from "@/components/infra/cloudflare/ingest-phase"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"

const cloudflareSearchSchema = Schema.Struct({
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/cloudflare/")({
	component: CloudflarePage,
	validateSearch: Schema.toStandardSchemaV1(cloudflareSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

function CloudflarePage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	// Integration-gated (not infra-agent-gated): the page is useful exactly when
	// the org has the Cloudflare integration connected with analytics scopes. The hook also
	// carries the ingest phase, and polls while a fresh connection is still filling up.
	const { statusResult, phase } = useCloudflareIngestPhase()

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Infrastructure", href: "/infra" }, { label: "Cloudflare" }]}
			time={{ search, startTime, endTime, defaultPreset: "12h", onChange: handleTimeChange }}
			gap="lg"
		>
			<ResultView
				result={statusResult}
				loading={
					<div className="space-y-4">
						<Skeleton className="h-28 w-full" />
						<ChartLoading variant="line" height={256} />
					</div>
				}
			>
				{(status) => {
					if (!status.connected) return <CloudflareNotConnected variant="not-connected" />
					if (!status.analyticsCapable) {
						return <CloudflareNotConnected variant="needs-permissions" />
					}
					return <CloudflareData startTime={startTime} endTime={endTime} phase={phase} />
				}}
			</ResultView>
		</DashboardPage>
	)
}

function CloudflareData({
	startTime,
	endTime,
	phase,
}: {
	startTime: string
	endTime: string
	phase: CloudflareIngestPhase | null
}) {
	const bucketSeconds = chartBucketSeconds(startTime, endTime)

	// Retained so a manual refresh or a time-range nudge fades the current numbers instead of
	// replacing the whole page with skeletons; it also wires these atoms to PageRefreshProvider.
	const zonesResult = useRefreshableAtomValue(cloudflareZonesResultAtom({ data: { startTime, endTime } }))
	const timeseriesResult = useRefreshableAtomValue(
		cloudflareZoneTimeseriesResultAtom({ data: { startTime, endTime, bucketSeconds } }),
	)
	const workersResult = useRefreshableAtomValue(
		cloudflareWorkersResultAtom({ data: { startTime, endTime } }),
	)
	const [zoneFilter, setZoneFilter] = useState("")
	const zoneQuery = useDeferredValue(zoneFilter).trim().toLowerCase()

	const timeseries = Result.builder(timeseriesResult)
		.onSuccess((r) => r)
		.orElse(() => null)
	const timeseriesWaiting = Result.builder(timeseriesResult)
		.onSuccess((_, holder) => holder.waiting)
		.orElse(() => false)

	// Stable zone→color assignment shared by all four charts and the legend:
	// zones ordered by window request volume, capped at the palette size, the
	// remainder pooled into one muted "Other zones" series.
	const zoneSeries = useMemo(() => {
		if (!timeseries) return null
		const totals = new Map<string, number>()
		for (const row of timeseries.buckets) {
			totals.set(row.zoneName, (totals.get(row.zoneName) ?? 0) + row.requests)
		}
		const ordered = [...totals.entries()].toSorted((a, b) => b[1] - a[1]).map(([name]) => name)
		const top = ordered.slice(0, MAX_ZONE_SERIES)
		return { top, otherCount: ordered.length - top.length, colors: resolveSeriesColors(top) }
	}, [timeseries])

	// Zones (HTTP edge analytics) and Workers (invocation analytics) are
	// independent datasets — an org can have either without the other. The
	// page-level "no traffic" empty state only applies when BOTH are settled
	// and empty; otherwise each section shows its own lightweight empty.
	const zonesEmpty = Result.builder(zonesResult)
		.onSuccess((r, holder) => r.zones.length === 0 && !holder.waiting)
		.orElse(() => false)
	const workersEmpty = Result.builder(workersResult)
		.onSuccess((r, holder) => r.workers.length === 0 && !holder.waiting)
		.orElse(() => false)

	if (zonesEmpty && workersEmpty) {
		// Two different empties wear the same face otherwise: a connection that has never
		// produced anything (say why, and when to expect it) versus a live one whose selected
		// window happens to be quiet (say that, and offer the fix — a wider window).
		if (phase != null && phase.kind !== "live" && phase.kind !== "backfilling") {
			return (
				<CloudflareIngestEmpty phase={phase}>
					{phase.kind === "stalled" ? <CloudflareStalledAction /> : null}
				</CloudflareIngestEmpty>
			)
		}
		return (
			<Empty className="py-16">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<CloudflareIcon size={16} />
					</EmptyMedia>
					<EmptyTitle>No Cloudflare traffic in this window</EmptyTitle>
					<EmptyDescription>
						This zone set reported no requests over the selected range. Widen the time range, or
						check back once more traffic has been collected.
					</EmptyDescription>
				</EmptyHeader>
				<DocsLink page="cloudflare" />
			</Empty>
		)
	}

	return (
		<div className="space-y-6">
			{phase == null ? null : <CloudflareIngestBanner phase={phase} />}
			<ResultView
				result={zonesResult}
				loading={
					<div className="space-y-4">
						<CloudflareKpiCardsLoading />
						<CloudflareZoneTableLoading />
					</div>
				}
				dimWhileWaiting
				className="space-y-6"
			>
				{(response, { waiting }) => (
					<>
						{response.zones.length > 0 && (
							<CloudflareKpiCards zones={response.zones} buckets={timeseries?.buckets} />
						)}
						{response.zones.length > 0 &&
							timeseries &&
							timeseries.buckets.length > 0 &&
							zoneSeries && (
								<div className="space-y-2">
									{(zoneSeries.top.length > 1 || zoneSeries.otherCount > 0) && (
										<SeriesLegend
											className="justify-start gap-x-4 px-1"
											items={[
												...zoneSeries.top.map((name) => ({
													key: name,
													color: zoneSeries.colors.get(name),
													label: (
														<Link
															to="/infra/cloudflare/$zoneName"
															params={{ zoneName: name }}
															className="transition-colors hover:text-foreground"
														>
															{name}
														</Link>
													),
												})),
												...(zoneSeries.otherCount > 0
													? [
															{
																key: OTHER_ZONES_SERIES,
																color: OTHER_COLOR,
																label: `Other zones (${zoneSeries.otherCount})`,
															},
														]
													: []),
											]}
										/>
									)}
									<div className="grid gap-4 lg:grid-cols-2">
										<CloudflareZoneChart
											buckets={timeseries.buckets}
											metric="requests"
											topZones={zoneSeries.top}
											waiting={timeseriesWaiting}
											syncId="cf-zones"
										/>
										<CloudflareZoneChart
											buckets={timeseries.buckets}
											metric="errorRate"
											topZones={zoneSeries.top}
											waiting={timeseriesWaiting}
											syncId="cf-zones"
										/>
										<CloudflareZoneChart
											buckets={timeseries.buckets}
											metric="cacheHitRate"
											topZones={zoneSeries.top}
											waiting={timeseriesWaiting}
											syncId="cf-zones"
										/>
										<CloudflareZoneChart
											buckets={timeseries.buckets}
											metric="bytes"
											topZones={zoneSeries.top}
											waiting={timeseriesWaiting}
											syncId="cf-zones"
										/>
									</div>
								</div>
							)}
						<ZonesSection zones={response.zones} query={zoneQuery} waiting={waiting}>
							<CompactFilterInput
								className="w-56"
								value={zoneFilter}
								onChange={setZoneFilter}
								placeholder={`Filter ${response.zones.length} zones`}
								label="Filter zones by name"
							/>
						</ZonesSection>
					</>
				)}
			</ResultView>
			<section className="space-y-3">
				<SectionHeading
					title="Workers"
					count={Result.builder(workersResult)
						.onSuccess((r) => r.workers.length)
						.orElse(() => null)}
				/>
				<ResultView result={workersResult} loading={<CloudflareWorkerTableLoading />}>
					{(response, { waiting }) => (
						<CloudflareWorkerTable workers={response.workers} waiting={waiting} />
					)}
				</ResultView>
			</section>
			<CloudflarePlatformSection startTime={startTime} endTime={endTime} />
		</div>
	)
}

/**
 * The zone list is capped by the server at 500, not by anything human. Filtering by name beats
 * scrolling for it, and the count reads `shown of total` so a filtered view never looks like the
 * whole picture.
 */
function ZonesSection({
	zones,
	query,
	waiting,
	children,
}: {
	zones: ReadonlyArray<CloudflareZoneRow>
	query: string
	waiting?: boolean
	children: ReactNode
}) {
	const matches = useMemo(
		() => (query === "" ? zones : zones.filter((zone) => zone.zoneName.toLowerCase().includes(query))),
		[zones, query],
	)

	return (
		<section className="space-y-3">
			<SectionHeading
				title="Zones"
				count={
					matches.length === zones.length ? zones.length : `${matches.length} of ${zones.length}`
				}
				actions={zones.length > 1 ? children : null}
			/>
			<CloudflareZoneTable
				zones={matches}
				waiting={waiting}
				emptyMessage={query === "" ? undefined : `No zones match "${query}" in the selected window.`}
			/>
		</section>
	)
}
