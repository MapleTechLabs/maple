import { useMemo } from "react"
import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Result } from "@/lib/effect-atom"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { formatErrorRate } from "@maple/ui/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { ServiceUsageCards } from "@/components/dashboard/service-usage-cards"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import { SetupChecklist } from "@/components/dashboard/setup-checklist"
import { FirstActionHint } from "@/components/dashboard/first-action-hint"
import type { ChartLegendMode, ChartTooltipMode } from "@maple/ui/components/charts/_shared/chart-types"
import {
	getCustomChartTimeSeriesResultAtom,
	getOverviewTimeSeriesResultAtom,
	getServicesFacetsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import type { CustomChartTimeSeriesResponse } from "@/api/warehouse/custom-charts"
import type { ServiceDetailTimeSeriesPoint, ServicesFacetsResponse } from "@/api/warehouse/services"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"

const dashboardSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	environment: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/"))({
	component: DashboardPage,
	validateSearch: Schema.toStandardSchemaV1(dashboardSearchSchema),
})

interface OverviewChartConfig {
	id: string
	chartId: string
	title: string
	layout: { x: number; y: number; w: number; h: number }
	legend?: ChartLegendMode
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
}

const EMPTY_ARRAY: Record<string, unknown>[] = []

const OVERVIEW_CHARTS: OverviewChartConfig[] = [
	{
		id: "throughput",
		chartId: "throughput-area",
		title: "Request Volume",
		layout: { x: 0, y: 0, w: 6, h: 4 },
		tooltip: "visible",
		rateMode: "per_second",
	},
	{
		id: "error-rate",
		chartId: "error-rate-area",
		title: "Error Rate",
		layout: { x: 6, y: 0, w: 6, h: 4 },
		tooltip: "visible",
	},
	{
		id: "latency",
		chartId: "latency-line",
		title: "Latency",
		layout: { x: 0, y: 4, w: 6, h: 4 },
		legend: "visible",
		tooltip: "visible",
	},
	{
		id: "log-volume",
		chartId: "throughput-area",
		title: "Log Volume",
		layout: { x: 6, y: 4, w: 6, h: 4 },
		tooltip: "visible",
	},
]

function DashboardPage() {
	const search = Route.useSearch()

	// Stable 24h range, computed once per mount. Drives the single facets call
	// shared by `useDefaultPreset` and `DashboardContent` so we issue one HTTP
	// request instead of two. Environments / commit SHAs / service names move
	// slowly enough that a fixed 24h window is fine for the dropdown — and it
	// matches the old probe's range, so demo-detection behavior is unchanged.
	// `TinybirdDateTime` requires `YYYY-MM-DD HH:mm:ss` (no `T`, no millis), so
	// we strip the ISO suffix instead of passing `.toISOString()` raw.
	const facetsRange = useMemo(() => {
		const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
		const end = new Date()
		const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
		return { startTime: fmt(start), endTime: fmt(end) }
	}, [])

	const facetsResult = useRetainedRefreshableResultValue(
		getServicesFacetsResultAtom({ data: facetsRange }),
	)

	const defaultPreset = useMemo(() => {
		if (!Result.isSuccess(facetsResult)) return "24h"
		const services = facetsResult.value.data.services
		if (services.length === 0) return "24h"
		const allDemo = services.every((s) => s.name.startsWith("demo-"))
		return allDemo ? "6h" : "24h"
	}, [facetsResult])

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? defaultPreset}>
			<DashboardContent defaultPreset={defaultPreset} facetsResult={facetsResult} />
		</PageRefreshProvider>
	)
}

function DashboardContent({
	defaultPreset,
	facetsResult,
}: {
	defaultPreset: string
	facetsResult: Result.Result<ServicesFacetsResponse, unknown>
}) {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? defaultPreset,
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

	const handleEnvironmentChange = (value: string | null) => {
		navigate({
			search: (prev: Record<string, unknown>) => ({
				...prev,
				environment: value === "__all__" ? undefined : (value ?? undefined),
			}),
		})
	}

	const environments = Result.builder(facetsResult)
		.onSuccess((response) => response.data.environments)
		.orElse(() => [])

	// Derive effective environment filter — default to "production" if available, without writing to URL
	const environmentFilter = (() => {
		if (search.environment) return [search.environment]
		const hasProduction = environments.some((e) => e.name === "production")
		if (hasProduction) return ["production"]
		return undefined
	})()

	const selectedEnvironment =
		search.environment ?? (environments.some((e) => e.name === "production") ? "production" : "__all__")

	// Wait for facets before fetching data to avoid a cascading double-fetch
	// when environmentFilter changes from undefined → ["production"]
	//
	// The hook is handed a different atom on the `facetsReady` flip (disabled →
	// real), but both branches yield stable atom identities: the real atom comes
	// from an `Atom.family` keyed by encoded params, and `disabledResultAtom()`
	// returns a single module-scoped `keepAlive` atom (same reference every call).
	// So this is a one-time mount transition, not a per-render churn — no
	// in-render `Atom.make` and no lost state.
	const facetsReady = !Result.isInitial(facetsResult)

	const overviewResult = useRetainedRefreshableResultValue(
		facetsReady
			? getOverviewTimeSeriesResultAtom({
					data: {
						startTime: effectiveStartTime,
						endTime: effectiveEndTime,
						environments: environmentFilter,
					},
				})
			: // eslint-disable-next-line @typescript-eslint/no-explicit-any
				disabledResultAtom<{ data: ServiceDetailTimeSeriesPoint[] }, any>(),
	)

	const logVolumeResult = useRetainedRefreshableResultValue(
		facetsReady
			? getCustomChartTimeSeriesResultAtom({
					data: {
						source: "logs",
						metric: "count",
						groupBy: "none",
						startTime: effectiveStartTime,
						endTime: effectiveEndTime,
						filters: {
							serviceName: undefined,
							environments: environmentFilter,
						},
					},
				})
			: // eslint-disable-next-line @typescript-eslint/no-explicit-any
				disabledResultAtom<CustomChartTimeSeriesResponse, any>(),
	)

	const isWaiting =
		(Result.isSuccess(overviewResult) && overviewResult.waiting) ||
		(Result.isSuccess(logVolumeResult) && logVolumeResult.waiting)

	// Overview points are typed structs; the chart grid consumes a generic
	// `Record<string, unknown>[]`. Each point's fields are all primitive, so
	// spreading widens to the record shape without an `as unknown` round-trip.
	const overviewPoints: Record<string, unknown>[] = Result.builder(overviewResult)
		.onSuccess((response) => response.data.map((point) => ({ ...point })))
		.orElse(() => EMPTY_ARRAY)

	const logPoints = Result.builder(logVolumeResult)
		.onSuccess(
			(response) =>
				response.data.map((point) => {
					const total = Object.values(point.series).reduce<number>(
						(sum, val) => sum + (typeof val === "number" ? val : 0),
						0,
					)
					return { bucket: point.bucket, throughput: total }
				}) as unknown as Record<string, unknown>[],
		)
		.orElse(() => EMPTY_ARRAY)

	const isOverviewLoading = Result.isInitial(overviewResult)
	const isLogVolumeLoading = Result.isInitial(logVolumeResult)

	const metrics = useMemo(() => {
		const loadingMap: Record<string, boolean> = {
			throughput: isOverviewLoading,
			"error-rate": isOverviewLoading,
			latency: isOverviewLoading,
			"log-volume": isLogVolumeLoading,
		}

		const dataMap: Record<string, Record<string, unknown>[]> = {
			throughput: overviewPoints,
			"error-rate": overviewPoints,
			latency: overviewPoints,
			"log-volume": logPoints,
		}

		const totalVolume = overviewPoints.reduce(
			(sum, point) => sum + (typeof point.throughput === "number" ? point.throughput : 0),
			0,
		)
		// `errorRate` is a fraction (errors / requests); volume-weight it across buckets.
		const weightedErrors = overviewPoints.reduce((sum, point) => {
			const requests = typeof point.throughput === "number" ? point.throughput : 0
			const rate = typeof point.errorRate === "number" ? point.errorRate : 0
			return sum + requests * rate
		}, 0)
		const avgErrorRate = totalVolume > 0 ? weightedErrors / totalVolume : 0

		return OVERVIEW_CHARTS.map((chart) => ({
			id: chart.id,
			chartId: chart.chartId,
			title: chart.title,
			layout: chart.layout,
			data: dataMap[chart.id] ?? EMPTY_ARRAY,
			legend: chart.legend,
			tooltip: chart.tooltip,
			rateMode: chart.rateMode,
			isLoading: loadingMap[chart.id] ?? false,
			headerValue:
				chart.id === "error-rate" && !isOverviewLoading ? (
					<span className="text-chart-error">{formatErrorRate(avgErrorRate)}</span>
				) : undefined,
			footer:
				chart.id === "throughput" && !isOverviewLoading ? (
					<>
						Total{" "}
						<span className="font-medium text-foreground tabular-nums">
							{totalVolume.toLocaleString()}
						</span>
					</>
				) : undefined,
		}))
	}, [overviewPoints, logPoints, isOverviewLoading, isLogVolumeLoading])

	const environmentItems = useMemo(
		() => [
			{ value: "__all__", label: "All Environments" },
			...environments.map((e) => ({ value: e.name, label: e.name })),
		],
		[environments],
	)

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Overview" }]}
			title="Dashboard"
			description="Observability overview for your services."
			headerActions={
				<div className="flex items-center gap-2">
					<Select
						items={environmentItems}
						value={selectedEnvironment}
						onValueChange={handleEnvironmentChange}
					>
						<SelectTrigger size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{environmentItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<TimeRangeHeaderControls
						startTime={search.startTime ?? effectiveStartTime}
						endTime={search.endTime ?? effectiveEndTime}
						presetValue={search.timePreset ?? defaultPreset}
						onTimeChange={handleTimeChange}
					/>
				</div>
			}
		>
			<FirstActionHint />
			<SetupChecklist />
			<ServiceUsageCards startTime={effectiveStartTime} endTime={effectiveEndTime} />
			<MetricsGrid items={metrics} className="mt-4" waiting={!!isWaiting} syncId="home-overview" />
		</DashboardLayout>
	)
}
