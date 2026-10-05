import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { formatBytes } from "@maple/ui/lib/format"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { ErrorState } from "@/components/common/error-state"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { chartBucketSeconds, type ChartUnit } from "@/components/infra/chart-utils"
import { ChartCard } from "@/components/infra/primitives/chart-card"
import { InfraMetricChart } from "@/components/infra/primitives/infra-metric-chart"
import { HeroChip, PageHero } from "@/components/infra/primitives/page-hero"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import { formatCores, shareOfLimit } from "@/components/infra/railway/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Result } from "@/lib/effect-atom"
import {
	railwayServicesResultAtom,
	railwayServiceTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import type { RailwayServiceTimeseriesRow } from "@/api/warehouse/railway-infra"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const railwayServiceSearchSchema = Schema.Struct({
	...TimeRangeSearchFields,
	environmentId: Schema.String,
})

export const Route = createFileRoute("/infra/railway/$serviceId")({
	component: RailwayServicePage,
	validateSearch: Schema.toStandardSchemaV1(railwayServiceSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const DEFAULT_PRESET = "6h"
const LINKED_CHART_ID = "railway-service"

type SeriesPick = ReadonlyArray<readonly [label: string, pick: (row: RailwayServiceTimeseriesRow) => number]>

const toRows = (buckets: ReadonlyArray<RailwayServiceTimeseriesRow>, series: SeriesPick) =>
	buckets.flatMap((row) =>
		series.map(([label, pick]) => ({ bucket: row.bucket, attributeValue: label, value: pick(row) })),
	)

const CHARTS: ReadonlyArray<{ title: string; unit: ChartUnit; series: SeriesPick }> = [
	{
		title: "CPU",
		unit: "cores",
		series: [
			["Average", (row) => row.cpuAvg],
			["Peak", (row) => row.cpuMax],
		],
	},
	{
		title: "Memory",
		unit: "bytes",
		series: [
			["Average", (row) => row.memoryAvg],
			["Peak", (row) => row.memoryMax],
		],
	},
	{
		title: "Network (as reported by Railway)",
		unit: "bytes",
		series: [
			["Received", (row) => row.networkRx],
			["Sent", (row) => row.networkTx],
		],
	},
	{
		title: "Disk",
		unit: "bytes",
		series: [
			["Volume", (row) => row.diskVolume],
			["Ephemeral", (row) => row.diskEphemeral],
		],
	},
]

function RailwayServicePage() {
	const { serviceId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const bucketSeconds = Math.max(60, chartBucketSeconds(startTime, endTime))

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	const servicesResult = useRefreshableAtomValue(
		railwayServicesResultAtom({ data: { startTime, endTime } }),
	)
	const service = Result.builder(servicesResult)
		.onSuccess(
			(response) =>
				response.services.find(
					(row) => row.serviceId === serviceId && row.environmentId === search.environmentId,
				) ?? null,
		)
		.orElse(() => null)

	const timeseriesResult = useRefreshableAtomValue(
		railwayServiceTimeseriesResultAtom({
			data: { startTime, endTime, bucketSeconds, serviceId, environmentId: search.environmentId },
		}),
	)
	const buckets = Result.builder(timeseriesResult)
		.onSuccess((response) => response.buckets)
		.orElse(() => NO_BUCKETS)
	const xDomain = useMemo(() => buckets.map((row) => row.bucket), [buckets])

	const title = service?.serviceName || serviceId
	const cpuShare = service ? shareOfLimit(service.cpuAvg, service.cpuLimit) : null
	const memoryShare = service ? shareOfLimit(service.memoryAvg, service.memoryLimit) : null

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? DEFAULT_PRESET}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Infrastructure", href: "/infra" },
						{ label: "Railway", href: "/infra/railway" },
						{ label: title },
					]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? startTime}
									endTime={search.endTime ?? endTime}
									presetValue={
										search.timePreset ?? (search.startTime ? undefined : DEFAULT_PRESET)
									}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-6">
								<PageHero
									title={title}
									description="Resource usage for this Railway service, summed across its replicas."
									meta={
										service ? (
											<>
												<HeroChip>{service.projectName}</HeroChip>
												<HeroChip>{service.environmentName}</HeroChip>
											</>
										) : undefined
									}
								/>
								{service ? (
									<StatRail>
										<StatRailItem
											compact
											eyebrow="Avg CPU"
											value={formatCores(service.cpuAvg)}
											subline={
												cpuShare === null
													? undefined
													: `${cpuShare.toFixed(1)}% of ${formatCores(service.cpuLimit)}`
											}
										/>
										<StatRailItem
											compact
											eyebrow="Avg memory"
											value={formatBytes(service.memoryAvg)}
											subline={
												memoryShare === null
													? undefined
													: `${memoryShare.toFixed(1)}% of ${formatBytes(service.memoryLimit)}`
											}
										/>
										<StatRailItem
											compact
											eyebrow="Peak memory"
											value={formatBytes(service.memoryMax)}
										/>
										<StatRailItem
											compact
											eyebrow="Replicas"
											value={String(service.replicas)}
										/>
									</StatRail>
								) : null}
								{Result.isFailure(timeseriesResult) && buckets.length === 0 ? (
									<ErrorState error={timeseriesResult.cause} />
								) : Result.isInitial(timeseriesResult) ? (
									<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
										{CHARTS.map((chart) => (
											<Skeleton key={chart.title} className="h-64 w-full rounded-md" />
										))}
									</div>
								) : (
									<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
										{CHARTS.map((chart) => (
											<ChartCard key={chart.title} title={chart.title}>
												<InfraMetricChart
													rows={toRows(buckets, chart.series)}
													unit={chart.unit}
													xDomain={xDomain}
													linkedChartId={LINKED_CHART_ID}
													waiting={Boolean(timeseriesResult.waiting)}
												/>
											</ChartCard>
										))}
									</div>
								)}
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

const NO_BUCKETS: ReadonlyArray<RailwayServiceTimeseriesRow> = []
