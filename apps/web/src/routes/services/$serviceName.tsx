import { Link, useNavigate, createFileRoute } from "@tanstack/react-router"
import { useCallback, useMemo } from "react"
import { Result } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import type {
	ChartLegendMode,
	ChartReferenceLine,
	ChartTooltipMode,
} from "@maple/ui/components/charts/_shared/chart-types"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import {
	getCustomChartServiceDetailResultAtom,
	getServiceReleasesTimelineResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { detectReleaseMarkers } from "@/lib/services/release-markers"
import { CommitShaHoverCard } from "@/components/vcs/commit-sha-hover-card"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { zoomRangeToWarehouse } from "@/lib/time-utils"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { Button } from "@maple/ui/components/ui/button"
import { BellIcon } from "@/components/icons"
import { ServiceDependenciesTab } from "@/components/services/service-dependencies-tab"
import { ServiceEnvironmentSwitcher } from "@/components/services/service-environment-switcher"
import { OptionalStringArrayParam } from "@/lib/search-params"

const ServiceDetailTab = Schema.Literals(["overview", "dependencies"])
type ServiceDetailTabValue = Schema.Schema.Type<typeof ServiceDetailTab>

const serviceDetailSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	tab: Schema.optional(ServiceDetailTab),
	// Scopes the Overview charts to a single deployment environment (carried from
	// the clicked service-list row, or chosen via the env switcher). Single-element
	// by convention; `undefined` = all environments. Uses the JSON-string-tolerant
	// param so a serialized array URL survives TanStack Router's parseSearch.
	environments: OptionalStringArrayParam,
})

export const Route = effectRoute(createFileRoute("/services/$serviceName"))({
	component: ServiceDetailPage,
	validateSearch: Schema.toStandardSchemaV1(serviceDetailSearchSchema),
})

interface ServiceChartConfig {
	id: string
	chartId: string
	title: string
	layout: { x: number; y: number; w: number; h: number }
	legend?: ChartLegendMode
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
}

const SERVICE_CHARTS: ServiceChartConfig[] = [
	{
		id: "latency",
		chartId: "latency-line",
		title: "Latency",
		layout: { x: 0, y: 0, w: 6, h: 4 },
		legend: "visible",
		tooltip: "visible",
	},
	{
		id: "throughput",
		chartId: "throughput-area",
		title: "Throughput",
		layout: { x: 6, y: 0, w: 6, h: 4 },
		tooltip: "visible",
		rateMode: "per_second",
	},
	{
		id: "apdex",
		chartId: "apdex-area",
		title: "Apdex",
		layout: { x: 0, y: 4, w: 6, h: 4 },
		tooltip: "visible",
	},
	{
		id: "error-rate",
		chartId: "error-rate-area",
		title: "Error Rate",
		layout: { x: 6, y: 4, w: 6, h: 4 },
		tooltip: "visible",
	},
]

function ServiceDetailPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<ServiceDetailContent />
		</PageRefreshProvider>
	)
}

function ServiceDetailContent() {
	const { serviceName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const handleTimeChange = (
		range: {
			startTime?: string
			endTime?: string
			presetValue?: string
		},
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev: Record<string, unknown>) => applyTimeRangeSearch(prev, range),
		})
	}

	// Drag-to-zoom: charts hand back the bucket timestamps (ISO) at each end of the
	// dragged window; narrow the page time range to that absolute window. Convert to
	// the warehouse format the custom-range picker uses so the round-trip is identical.
	const handleChartZoom = useCallback(
		(range: { startBucket: string; endBucket: string }) => {
			const resolved = zoomRangeToWarehouse(range)
			if (resolved) {
				navigate({
					search: (prev: Record<string, unknown>) => applyTimeRangeSearch(prev, resolved),
				})
			}
		},
		[navigate],
	)

	const activeTab: ServiceDetailTabValue = search.tab ?? "overview"
	const handleTabChange = (value: unknown) => {
		const next = value === "dependencies" ? "dependencies" : "overview"
		navigate({
			replace: true,
			search: (prev: Record<string, unknown>) => ({
				...prev,
				tab: next === "overview" ? undefined : next,
			}),
		})
	}

	const handleEnvironmentChange = (environment: string | undefined) => {
		navigate({
			search: (prev: Record<string, unknown>) => ({
				...prev,
				environments: environment ? [environment] : undefined,
			}),
		})
	}

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Services", href: "/services" }, { label: serviceName }]}
			title={serviceName}
			headerActions={
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					{/* View switch lives inline with other page controls so it reads as a
					    perspective toggle, not a navigation bar. Sized to match the time
					    picker buttons (h-7) and tucked left of them so the visual order is:
					    "what view → what window → what action". */}
					<Tabs value={activeTab} onValueChange={handleTabChange} className="w-full sm:w-auto">
						<TabsList variant="default" className="h-7 w-full gap-0 p-0.5 sm:w-auto">
							<TabsTrigger
								value="overview"
								className="h-6 flex-1 px-2.5 text-xs font-medium sm:h-6 sm:flex-initial sm:text-xs"
							>
								Overview
							</TabsTrigger>
							<TabsTrigger
								value="dependencies"
								className="h-6 flex-1 px-2.5 text-xs font-medium sm:h-6 sm:flex-initial sm:text-xs"
							>
								Dependencies
							</TabsTrigger>
						</TabsList>
					</Tabs>
					{/* Env scope only applies to the Overview charts; hide it on the
					    Dependencies tab so it can't imply a filter it doesn't drive. */}
					{activeTab === "overview" && (
						<ServiceEnvironmentSwitcher
							serviceName={serviceName}
							startTime={effectiveStartTime}
							endTime={effectiveEndTime}
							value={search.environments?.[0]}
							onChange={handleEnvironmentChange}
						/>
					)}
					<div className="flex items-center gap-2">
						<TimeRangeHeaderControls
							startTime={search.startTime}
							endTime={search.endTime}
							presetValue={search.timePreset}
							onTimeChange={handleTimeChange}
						/>
						<Button
							variant="outline"
							aria-label="Create Alert"
							render={<Link to="/alerts/create" search={{ serviceName }} />}
						>
							<BellIcon size={14} />
							<span className="hidden sm:inline">Create Alert</span>
						</Button>
					</div>
				</div>
			}
		>
			{activeTab === "overview" ? (
				<OverviewTab
					serviceName={serviceName}
					effectiveStartTime={effectiveStartTime}
					effectiveEndTime={effectiveEndTime}
					environments={search.environments}
					onZoomSelect={handleChartZoom}
				/>
			) : (
				<ServiceDependenciesTab
					serviceName={serviceName}
					startTime={search.startTime}
					endTime={search.endTime}
					timePreset={search.timePreset}
					effectiveStartTime={effectiveStartTime}
					effectiveEndTime={effectiveEndTime}
				/>
			)}
		</DashboardLayout>
	)
}

interface OverviewTabProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	onZoomSelect?: (range: { startBucket: string; endBucket: string }) => void
}

function OverviewTab({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	onZoomSelect,
}: OverviewTabProps) {
	const detailResult = useRetainedRefreshableResultValue(
		getCustomChartServiceDetailResultAtom({
			data: {
				serviceName,
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				environments,
			},
		}),
	)

	const releasesResult = useRetainedRefreshableResultValue(
		getServiceReleasesTimelineResultAtom({
			data: {
				serviceName,
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
			},
		}),
	)

	const releaseMarkers: ChartReferenceLine[] = useMemo(() => {
		const timeline = Result.builder(releasesResult)
			.onSuccess((r) => r.data)
			.orElse(() => [])
		return detectReleaseMarkers(timeline).map((m) => ({
			x: m.bucket,
			label: m.label,
			// Full SHA so the marker's hover card can resolve the commit; `label`
			// stays the short form rendered on the flag.
			sha: m.commitSha,
			color: "var(--muted-foreground)",
			strokeDasharray: "6 4",
		}))
	}, [releasesResult])

	// A deploy marker's flag is a commit hover card: hovering it resolves the
	// release's commit (when the repo is connected/synced) and otherwise falls back
	// to the short SHA as plain text. Shared across all four synced charts.
	const renderReferenceMarker = useCallback(
		(line: ChartReferenceLine) => (
			<CommitShaHoverCard
				sha={line.sha ?? ""}
				className="rounded-full border border-border/60 bg-card/95 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
			>
				{line.label}
			</CommitShaHoverCard>
		),
		[],
	)

	const isWaiting = Result.isSuccess(detailResult) && detailResult.waiting

	// Cold load (no retained data yet) → drive each chart's loading skeleton so
	// the grid shows `ChartSkeleton` until the warehouse query resolves, rather
	// than rendering an empty chart with `[]` while the data is still in flight.
	// On a refresh the retained hook returns `Success(waiting: true)` (not
	// `Initial`), so this stays false and the stale-data dim (`opacity-60`) wins.
	const isDetailLoading = Result.isInitial(detailResult)

	// ServiceDetail points are typed structs; the chart grid consumes a
	// generic `Record<string, unknown>[]`. Each point's fields are all primitive,
	// so this is a safe widening (no `as unknown` round-trip needed).
	const detailPoints: Record<string, unknown>[] = Result.builder(detailResult)
		.onSuccess((response) => response.data.map((point) => ({ ...point })))
		.orElse(() => [])

	const widgetData: Record<string, Record<string, unknown>[]> = {
		latency: detailPoints,
		throughput: detailPoints,
		"error-rate": detailPoints,
		apdex: detailPoints,
	}

	const metrics = SERVICE_CHARTS.map((chart) => ({
		id: chart.id,
		chartId: chart.chartId,
		title: chart.title,
		layout: chart.layout,
		data: widgetData[chart.id] ?? [],
		legend: chart.legend,
		tooltip: chart.tooltip,
		rateMode: chart.rateMode,
		referenceLines: releaseMarkers,
		renderReferenceMarker,
		onZoomSelect,
		isLoading: isDetailLoading,
	}))

	return <MetricsGrid items={metrics} waiting={!!isWaiting} syncId={`service-${serviceName}`} />
}
