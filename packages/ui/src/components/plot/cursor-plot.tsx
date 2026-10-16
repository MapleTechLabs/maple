import type { ChartValue, DomChartDefinition } from "@tanstack/charts"
import * as React from "react"

import { cn } from "../../lib/utils"
import { PlotFrame, type PlotFrameProps } from "./plot-frame"
import {
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	type PlotTooltipSeries,
	type TooltipFocusStore,
} from "./plot-tooltip"
import { usePlotChromeColors, useResolvedSeriesColors, type PlotChromeColors } from "./theme"

/** One series of a cursor-tooltip chart: what it is called, its colour, and how to read it. */
export interface CursorPlotSeries<TDatum> {
	key: string
	label: string
	/** A token (`--chart-2`), a wrapped `var(--chart-2)`, or a literal. */
	color: string
	dashed?: boolean
	value: (datum: TDatum) => number | null | undefined
	format: (value: number) => string
	/** Where the series is PLOTTED when that is not its raw value (a stacked band). */
	position?: (datum: TDatum) => number | null | undefined
	/** `false` keeps a series (a threshold, a band) out of the tooltip card. */
	tooltip?: boolean
}

/** What a chart needs to build its definition: resolved colours, chrome, and the tooltip spec. */
export interface CursorPlotState {
	/** Each series' colour resolved to a literal, keyed by `key`. */
	colors: ReadonlyMap<string, string>
	/** `colors.get(key)`, falling back to the border colour. */
	color: (key: string) => string
	chrome: PlotChromeColors
	focusStore: TooltipFocusStore
	/** The cursor-anchored tooltip spec, for `defineChart({ tooltip })`. */
	tooltip: ReturnType<typeof cursorTooltip>
}

/**
 * The state every cursor-tooltip chart builds before its definition.
 *
 * Colour resolution lives here once: the canvas 2D context cannot read
 * `var(--chart-N)`, so every token is resolved to a literal (re-resolved on a
 * theme flip). Pass a memoised `series`: its identity keys the resolution.
 */
export function useCursorPlot(series: ReadonlyArray<{ key: string; color: string }>): CursorPlotState {
	const chrome = usePlotChromeColors()
	const focusStore = React.useMemo(() => createTooltipFocusStore(), [])
	const tokens = React.useMemo(() => new Map(series.map((entry) => [entry.key, entry.color])), [series])
	const colors = useResolvedSeriesColors(tokens)

	return React.useMemo(
		() => ({
			colors,
			color: (key: string) => colors.get(key) ?? chrome.border,
			chrome,
			focusStore,
			tooltip: cursorTooltip(focusStore.anchor),
		}),
		[colors, chrome, focusStore],
	)
}

export interface CursorPlotProps<TDatum, TXValue extends ChartValue> extends Pick<
	PlotFrameProps<TDatum, TXValue, number>,
	"legend" | "legendPlacement" | "onFocusChange" | "footer" | "overlay" | "renderer"
> {
	plot: CursorPlotState
	definition: DomChartDefinition<TDatum, TXValue, number>
	series: ReadonlyArray<CursorPlotSeries<TDatum>>
	/** The tooltip card's heading for the hovered datum. */
	heading: (datum: TDatum) => string
	/** Which tooltip row to emphasise, when the chart knows without measuring. */
	highlight?: (datum: TDatum) => string | undefined
	ariaLabel: string
	/** Wraps the plot in a box of this height; omit when `className` sizes it. */
	height?: number
	className?: string
}

/**
 * A `PlotFrame` with the cursor tooltip wired: the series list builds the card's
 * rows (in resolved colours) and `heading` titles it.
 */
export function CursorPlot<TDatum, TXValue extends ChartValue>({
	plot,
	definition,
	series,
	heading,
	highlight,
	ariaLabel,
	height,
	className,
	...frame
}: CursorPlotProps<TDatum, TXValue>) {
	const tooltipSeries = React.useMemo<PlotTooltipSeries<TDatum>[]>(
		() =>
			series
				.filter((entry) => entry.tooltip !== false)
				.map((entry) => ({
					label: entry.label,
					color: plot.color(entry.key),
					dashed: entry.dashed,
					value: entry.value,
					format: entry.format,
					position: entry.position,
				})),
		[series, plot],
	)

	const chart = (
		<PlotFrame
			{...frame}
			definition={definition}
			ariaLabel={ariaLabel}
			className={height === undefined ? className : "h-full w-full"}
			renderTooltipBody={({ points }) => (
				<PlotTooltipBody
					points={points}
					series={tooltipSeries}
					focusStore={plot.focusStore}
					heading={heading}
					highlight={highlight}
				/>
			)}
		/>
	)
	if (height === undefined) return chart
	return (
		<div className={cn("w-full", className)} style={{ height }}>
			{chart}
		</div>
	)
}
