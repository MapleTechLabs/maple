import { memo, Suspense } from "react"

import { getChartById } from "@maple/ui/components/charts/registry"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface ChartWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	onRemove?: () => void
	onClone?: () => void
	onConfigure?: () => void
	onCreateAlert?: () => void
	onFix?: () => void
	/** Drag-to-zoom on time-series charts. See `BaseChartProps.onZoomSelect`. */
	onZoomSelect?: (range: { startBucket: string; endBucket: string }) => void
}

export const ChartWidget = memo(function ChartWidget({
	dataState,
	display,
	mode,
	onRemove,
	onClone,
	onConfigure,
	onCreateAlert,
	onFix,
	onZoomSelect,
}: ChartWidgetProps) {
	const { effectiveTimezone } = useTimezonePreference()
	const chartId = display.chartId ?? "gradient-area"
	const entry = getChartById(chartId)
	if (!entry) return null

	const ChartComponent = entry.component
	const chartData =
		dataState.status === "ready" && Array.isArray(dataState.data) ? dataState.data : undefined
	const legend = display.chartPresentation?.legend ?? "hidden"
	const seriesStats = display.chartPresentation?.seriesStats ?? legend !== "hidden"
	const tooltip = display.chartPresentation?.tooltip

	const renderChart = (expanded: boolean) => (
		<ChartComponent
			data={chartData}
			className="h-full w-full aspect-auto"
			// In the expanded modal the legend renders inline (there is no widget
			// header to hoist it into), so promote a hidden legend to visible there.
			legend={expanded && legend === "hidden" ? "visible" : legend}
			seriesStats={seriesStats}
			tooltip={tooltip}
			stacked={display.stacked}
			curveType={display.curveType}
			unit={display.unit}
			logScale={display.yAxis?.logScale}
			softMin={display.yAxis?.softMin}
			softMax={display.yAxis?.softMax}
			fitYAxisToData={display.yAxis?.fitYAxisToData}
			showPoints={display.chartPresentation?.showPoints}
			thresholds={display.thresholds}
			timeZone={effectiveTimezone}
			onZoomSelect={onZoomSelect}
		/>
	)

	return (
		<WidgetFrame
			title={display.title || "Untitled"}
			dataState={dataState}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			onCreateAlert={onCreateAlert}
			onFix={onFix}
			loadingSkeleton={<ChartSkeleton variant={entry.category} />}
			renderExpanded={() => (
				<Suspense fallback={<ChartSkeleton variant={entry.category} />}>{renderChart(true)}</Suspense>
			)}
		>
			<Suspense fallback={<ChartSkeleton variant={entry.category} />}>{renderChart(false)}</Suspense>
		</WidgetFrame>
	)
})
