import { useMemo } from "react"
import { areaY, d3Curve, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"

import { ChartEmpty } from "@maple/ui/components/charts"
import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	focusDot,
	roundCapDasharray,
	usePlotChromeColors,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"

import type { makeBucketAxis } from "@/components/infra/chart-utils"
import { LinkedCursorOverlay, linkedCursorChartProps } from "@/hooks/use-linked-cursor"
import type { OverviewPlotRow, OverviewPlotSpec } from "@/lib/agent-sessions/overview-chart-specs"

/** The plot box, x-axis labels included — the design's 86px svg over its ticks. */
export const OVERVIEW_PLOT_HEIGHT = 104
/** Wide enough for `100%` and `$0.40`, narrow enough to leave the plot room. */
const Y_AXIS_WIDTH = 32
const STROKE_WIDTH = 1.5
const GHOST_STROKE_WIDTH = 1.2
/** A stack layer is read by its area, so it is nearly opaque. */
const BAND_FILL_OPACITY = 0.85
/** The p50–p95 region carries a line of its own colour and must stay behind it. */
const SPREAD_FILL_OPACITY = 0.18

export interface OverviewSmallMultipleProps {
	/** Names the chart to the linked cursor and to assistive tech. */
	chartId: string
	title: string
	spec: OverviewPlotSpec
	/** Built once for the whole grid, so all nine agree on where an instant sits. */
	axis: ReturnType<typeof makeBucketAxis>
}

/**
 * One of the nine plots.
 *
 * Every chart on the board is this component over a different spec: the shapes
 * differ (lines, a stack, a spread) but the chrome must not, because the grid is
 * read across as much as down.
 */
export function OverviewSmallMultiple({ chartId, title, spec, axis }: OverviewSmallMultipleProps) {
	const chromeColors = usePlotChromeColors()
	const focusStore = useMemo(() => createTooltipFocusStore(), [])

	const tooltipSeries = useMemo<PlotTooltipSeries<OverviewPlotRow>[]>(
		() =>
			spec.marks.map((mark) => ({
				label: mark.label,
				color: mark.color,
				dashed: mark.kind === "ghost",
				// A stack layer's own reading is its THICKNESS; where it was drawn is
				// that thickness plus everything under it, which is what the row
				// highlight measures against the cursor.
				value: (plotRow: OverviewPlotRow) =>
					mark.kind === "band"
						? numberAt(plotRow, mark.key) - numberAt(plotRow, mark.base)
						: readNumber(plotRow, mark.key),
				position: (plotRow: OverviewPlotRow) => readNumber(plotRow, mark.key),
				format: spec.format,
			})),
		[spec],
	)

	const definition = useMemo(() => {
		const at = (plotRow: OverviewPlotRow) => plotRow.date
		const valueOf = (key: string) => (plotRow: OverviewPlotRow) => readNumber(plotRow, key)
		const curve = d3Curve(curveMonotoneX)
		const ghostDash = roundCapDasharray(3, 3, GHOST_STROKE_WIDTH)
		const bands = spec.marks.filter((mark) => mark.kind === "band" || mark.kind === "spread")
		const lines = spec.marks.filter((mark) => mark.kind === "line" || mark.kind === "ghost")

		return defineChart({
			marks: [
				dashedGridY(),
				// Fill first, then the lines that are read over it.
				...bands.map((mark) =>
					areaY(spec.rows, {
						id: `${mark.key}-band`,
						x: at,
						y: valueOf(mark.key),
						// An explicit floor: these stacks are built in the spec, where the
						// fallback band and the model tail are decided, not by a layout.
						y1: valueOf(mark.base ?? mark.key),
						fill: mark.color,
						fillOpacity: mark.kind === "spread" ? SPREAD_FILL_OPACITY : BAND_FILL_OPACITY,
						// `areaY` strokes the closed polygon, baseline included — the top
						// edge is a `lineY` where a chart wants one.
						stroke: "none",
						curve,
					}),
				),
				...lines.map((mark) =>
					lineY(spec.rows, {
						id: mark.key,
						x: at,
						y: valueOf(mark.key),
						stroke: mark.color,
						strokeWidth: mark.kind === "ghost" ? GHOST_STROKE_WIDTH : STROKE_WIDTH,
						strokeDasharray: mark.kind === "ghost" ? ghostDash : undefined,
						curve,
					}),
				),
				...lines.map((mark) => focusDot(spec.rows, at, valueOf(mark.key), mark.color, chromeColors)),
				focusCrosshair(chromeColors),
			],
			scales: {
				x: axis.x,
				y: {
					scale: scaleLinear().domain([0, spec.yMax]),
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 6,
							// Two labels, the extremes — nine charts of laddered ticks is a
							// wall of digits, and the question here is shape.
							values: [0, spec.yMax],
							// A duration or a cost renders zero as an em dash, which is right
							// for a headline and wrong for an axis floor.
							format: (value: number) => (value === 0 ? "0" : spec.format(value)),
						},
					},
				},
			},
			// The top tick sits on the highest plotted value, so the margin is what
			// keeps its label — and the peak under it — inside the frame.
			margin: { left: Y_AXIS_WIDTH, right: 6, top: 8 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [spec, axis, chromeColors, focusStore])

	if (spec.rows.length === 0) {
		return <ChartEmpty height={OVERVIEW_PLOT_HEIGHT}>No data in this range.</ChartEmpty>
	}

	return (
		<div
			className="relative w-full"
			style={{ height: OVERVIEW_PLOT_HEIGHT }}
			{...linkedCursorChartProps(chartId)}
		>
			<PlotFrame
				definition={definition}
				ariaLabel={title}
				className="h-full w-full"
				renderTooltipBody={({ points }) => (
					<PlotTooltipBody
						points={points}
						series={tooltipSeries}
						focusStore={focusStore}
						heading={(plotRow: OverviewPlotRow) => axis.heading(plotRow.bucket)}
					/>
				)}
			/>
			<LinkedCursorOverlay chartId={chartId} />
		</div>
	)
}

/** A row field as a plotted value; anything else is a gap, not a zero. */
function readNumber(plotRow: OverviewPlotRow, key: string): number | null {
	const value = plotRow[key]
	return typeof value === "number" ? value : null
}

/** The same read where a missing floor genuinely means the axis. */
function numberAt(plotRow: OverviewPlotRow, key: string | undefined): number {
	if (key === undefined) return 0
	const value = plotRow[key]
	return typeof value === "number" ? value : 0
}
