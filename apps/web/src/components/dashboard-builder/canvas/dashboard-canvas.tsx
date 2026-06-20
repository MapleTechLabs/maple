import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { GridLayout, useContainerWidth, verticalCompactor } from "react-grid-layout"
import type { Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"

import type {
	WidgetDataState,
	DashboardWidget,
	WidgetDisplayConfig,
	WidgetMode,
} from "@/components/dashboard-builder/types"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { WidgetActionsProvider } from "@/components/dashboard-builder/widgets/widget-actions-context"
import { useWidgetData } from "@/hooks/use-widget-data"
import { zoomRangeToWarehouse } from "@/lib/time-utils"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { GaugeWidget } from "@/components/dashboard-builder/widgets/gauge-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { ListWidget } from "@/components/dashboard-builder/widgets/list-widget"
import { PieWidget } from "@/components/dashboard-builder/widgets/pie-widget"
import { HistogramWidget } from "@/components/dashboard-builder/widgets/histogram-widget"
import { HeatmapWidget } from "@/components/dashboard-builder/widgets/heatmap-widget"
import { FunnelWidget } from "@/components/dashboard-builder/widgets/funnel-widget"
import { MarkdownWidget } from "@/components/dashboard-builder/widgets/markdown-widget"

interface DashboardCanvasProps {
	widgets: DashboardWidget[]
	/**
	 * When true, the grid is read-only: drag/resize disabled, layout-change
	 * callbacks suppressed. Used while previewing a historical version so
	 * interactions don't accidentally mutate the live dashboard.
	 */
	readOnly?: boolean
}

const visualizationRegistry: Record<
	string,
	React.ComponentType<{
		dataState: WidgetDataState
		display: WidgetDisplayConfig
		mode: WidgetMode
		onZoomSelect?: (range: { startBucket: string; endBucket: string }) => void
	}>
> = {
	chart: ChartWidget,
	stat: StatWidget,
	gauge: GaugeWidget,
	table: TableWidget,
	list: ListWidget,
	pie: PieWidget,
	histogram: HistogramWidget,
	heatmap: HeatmapWidget,
	funnel: FunnelWidget,
	markdown: MarkdownWidget,
}

/**
 * Latches `true` the first time the element scrolls into (near) the viewport,
 * then stays latched. Tiles fetch their data lazily on first reveal and keep it
 * — the widget fetch atoms set no staleTime, so a non-sticky flag would refetch
 * every time a tile scrolled back into view. The 200ms debounce absorbs
 * react-grid-layout's mount-time reflow, where tiles can briefly flash into
 * view before the layout settles.
 */
function useInViewportSticky() {
	const ref = useRef<HTMLDivElement>(null)
	const [visible, setVisible] = useState(false)

	useEffect(() => {
		if (visible) return
		const element = ref.current
		if (!element) return
		if (typeof IntersectionObserver === "undefined") {
			setVisible(true)
			return
		}

		let timer: ReturnType<typeof setTimeout> | undefined
		const observer = new IntersectionObserver(
			(entries) => {
				const isIntersecting = entries.some((entry) => entry.isIntersecting)
				if (isIntersecting && timer == null) {
					timer = setTimeout(() => setVisible(true), 200)
				} else if (!isIntersecting && timer != null) {
					clearTimeout(timer)
					timer = undefined
				}
			},
			{ rootMargin: "200px" },
		)
		observer.observe(element)
		return () => {
			if (timer != null) clearTimeout(timer)
			observer.disconnect()
		}
	}, [visible])

	return { ref, visible }
}

const WidgetRenderer = memo(function WidgetRenderer({
	widget,
	readOnly,
}: {
	widget: DashboardWidget
	readOnly: boolean
}) {
	const { mode } = useDashboardActions()
	const {
		actions: { setTimeRange },
	} = useDashboardTimeRange()
	const { ref, visible } = useInViewportSticky()
	const { dataState } = useWidgetData(widget, visible)
	const Visualization = visualizationRegistry[widget.visualization] ?? visualizationRegistry.chart

	// Drag-to-zoom: a chart hands back the bucket timestamps at each end of the
	// dragged window; narrow the dashboard time range to that absolute window.
	// Disabled in read-only mode (e.g. previewing a historical version) so a
	// drag can't mutate the live dashboard time range.
	const handleZoomSelect = useCallback(
		(range: { startBucket: string; endBucket: string }) => {
			const resolved = zoomRangeToWarehouse(range)
			if (resolved) setTimeRange({ type: "absolute", ...resolved })
		},
		[setTimeRange],
	)

	return (
		<div ref={ref} className="h-full w-full">
			<WidgetActionsProvider widget={widget} dataState={dataState}>
				<Visualization
					dataState={dataState}
					display={widget.display}
					mode={mode}
					onZoomSelect={readOnly ? undefined : handleZoomSelect}
				/>
			</WidgetActionsProvider>
		</div>
	)
})

export function DashboardCanvas({ widgets, readOnly = false }: DashboardCanvasProps) {
	const { mode, updateWidgetLayouts } = useDashboardActions()
	const { width, containerRef, mounted } = useContainerWidth()
	const editable = mode === "edit" && !readOnly

	const layouts: Layout = useMemo(
		() =>
			widgets.map((w) => ({
				i: w.id,
				x: w.layout.x,
				y: w.layout.y,
				w: w.layout.w,
				h: w.layout.h,
				minW: w.layout.minW ?? 2,
				minH: w.layout.minH ?? 2,
				...(w.layout.maxW != null ? { maxW: w.layout.maxW } : {}),
				...(w.layout.maxH != null ? { maxH: w.layout.maxH } : {}),
			})),
		[widgets],
	)

	// react-grid-layout fires onLayoutChange once on mount with the
	// post-compaction layout. That first call is not a real user edit, so
	// we drop it to avoid a spurious upsert that invalidates the dashboards
	// list and cascades a re-render of every widget.
	const initialLayoutSeenRef = useRef(false)

	const handleLayoutChange = useCallback(
		(layout: Layout) => {
			if (!editable) return
			if (!initialLayoutSeenRef.current) {
				initialLayoutSeenRef.current = true
				return
			}
			updateWidgetLayouts(
				layout.map((l) => ({
					i: l.i,
					x: l.x,
					y: l.y,
					w: l.w,
					h: l.h,
				})),
			)
		},
		[editable, updateWidgetLayouts],
	)

	return (
		<div ref={containerRef}>
			{mounted && (
				<GridLayout
					width={width}
					layout={layouts}
					gridConfig={{
						cols: 12,
						rowHeight: 60,
						margin: [12, 12] as [number, number],
					}}
					dragConfig={{
						enabled: editable,
						handle: ".widget-drag-handle",
						bounded: false,
						threshold: 3,
					}}
					resizeConfig={{
						enabled: editable,
						handles: ["se"],
					}}
					compactor={verticalCompactor}
					onLayoutChange={handleLayoutChange}
				>
					{widgets.map((widget) => (
						<div key={widget.id}>
							<WidgetRenderer widget={widget} readOnly={readOnly} />
						</div>
					))}
				</GridLayout>
			)}
		</div>
	)
}
