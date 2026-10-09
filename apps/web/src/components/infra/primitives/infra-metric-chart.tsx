import { areaY, d3Curve, defineChart, lineY, stack } from "@tanstack/charts"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import { useMemo, type ReactNode } from "react"

import {
	CursorPlot,
	DASHED_Y_GRID,
	focusCrosshair,
	focusDot,
	linearYDomain,
	makeBucketAxis,
	niceLinearDomain,
	thresholdRules,
	useChartId,
	useCursorPlot,
	verticalGradient,
	type CursorPlotSeries,
} from "@maple/ui/components/plot"
import { ChartEmpty, useChartPlotHeight } from "@maple/ui/components/charts"
import { formatBytes } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

import { CHART_EMPTY_MESSAGE } from "@/components/common/chart-card"
import {
	formatValueWithUnit,
	transformRows,
	UNNAMED_SERIES_KEY,
	type ChartUnit,
	type TransformedPoint,
} from "../chart-utils"
import { LinkedCursorOverlay, linkedCursorChartProps } from "@/hooks/use-linked-cursor"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"

/**
 * The utilization chart behind `/infra`'s host and Kubernetes detail pages.
 *
 * These were two files that had drifted into near-duplicates: same
 * `transformRows` pivot, same last-value header strip, same stacked-area-or-line
 * switch, same 80% threshold, same tooltip. What differed between them was
 * accidental — a 1.4px stroke against 1.6, a gradient ending at 0.04 against
 * 0.05, one y-axis 52px wide and the other unset. Sharing the component settles
 * those on one answer rather than preserving a difference nobody chose.
 */
export interface InfraMetricChartProps {
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	unit: ChartUnit
	/** Replaces the unnamed-series placeholder so a single line reads "CPU", not "value". */
	seriesLabel?: string
	/** Stacked bands (a resource split by container) rather than independent lines. */
	stacked?: boolean
	/** Draws the 80% warning rule. Percent units only — 80% of "cores" means nothing. */
	showThreshold?: boolean
	/** Joins the linked hover cursor. Omit to opt out. */
	linkedChartId?: string
	/**
	 * An explicit x domain, as bucket ISO strings; the axis spans their extent.
	 *
	 * Without it each chart domains over its OWN rows, so two charts stacked to
	 * be read down a vertical line silently disagree about where a given minute
	 * sits whenever one series is shorter or coarser than the other. Pass the
	 * union of every sibling's buckets to make the shared axis real rather than
	 * apparent.
	 */
	xDomain?: ReadonlyArray<string>
	/**
	 * The last-value summary above the plot.
	 *
	 * A render prop, which is the one shape the composition rules bless: the
	 * header needs the pivoted series, their resolved colours and their latest
	 * values, and all three are computed in here from the long-form rows. The
	 * host page draws a plain right-aligned strip and the Kubernetes page draws
	 * bordered chips — a real difference, not drift, so neither is baked in.
	 */
	header?: (info: InfraSeriesInfo) => ReactNode
	waiting?: boolean
	height?: number
	className?: string
}

/**
 * One stacked band's datum: a bucket, the series it belongs to, and its value.
 *
 * Stacking groups on `z`, so a stacked chart plots CELLS while an unstacked one
 * plots the pivoted rows directly. Both reach the tooltip, which is why it reads
 * through `rowOf` rather than assuming one shape.
 */
interface InfraCell {
	point: TransformedPoint
	name: string
	value: number | null
}

type InfraDatum = TransformedPoint | InfraCell

/** What a header needs to describe the series it sits above. */
export interface InfraSeriesInfo {
	series: readonly string[]
	/** Resolved colour literals, keyed by series name. */
	colors: ReadonlyMap<string, string>
	/** The most recent value per series, absent when the series ended on a gap. */
	lastValues: Readonly<Record<string, number>>
	/** The display name — swaps the unnamed-series placeholder for the metric label. */
	labelFor: (name: string) => string
	unit: ChartUnit
}

/**
 * The pivoted row behind a datum — every series at that bucket.
 *
 * A structural `"point" in datum` check does NOT narrow here: `TransformedPoint`
 * carries an index signature, so every key is "in" it and `datum.point` comes
 * back as `string | number`. Probing the value's type is what actually
 * discriminates, since a row's values are never objects.
 */
function isCell(datum: InfraDatum): datum is InfraCell {
	return typeof (datum as InfraCell).point === "object"
}

function rowOf(datum: InfraDatum): TransformedPoint {
	return isCell(datum) ? datum.point : datum
}

/**
 * The plot height for every chart built on this primitive.
 *
 * Exported so a call site's loading/empty/error branches reserve the SAME box
 * (`<ChartPlotArea height={INFRA_METRIC_CHART_HEIGHT}>`) instead of repeating
 * the number as an `h-[220px]` literal that silently drifts from it.
 */
export const INFRA_METRIC_CHART_HEIGHT = 220
const STROKE_WIDTH = 1.5
const THRESHOLD_FRACTION = 0.8

export function InfraMetricChart({
	rows,
	unit,
	seriesLabel,
	stacked = false,
	showThreshold = false,
	linkedChartId,
	xDomain,
	header,
	waiting = false,
	height,
	className,
}: InfraMetricChartProps) {
	// A surrounding `ChartPlotArea` has already reserved a box; matching it here
	// keeps the plot and the loading/empty/error branches it alternates with
	// exactly the same size. An explicit prop still wins. The hook is called
	// unconditionally — `height ?? useChartPlotHeight()` would skip it whenever a
	// prop was passed, which is a conditional hook.
	const inheritedHeight = useChartPlotHeight()
	const plotHeight = height ?? inheritedHeight ?? INFRA_METRIC_CHART_HEIGHT

	const gradientPrefix = useChartId("infra")

	const { data, series } = useMemo(() => transformRows(rows), [rows])

	// A time axis over the buckets' instants — see `makeBucketAxis` for why the
	// label point scale this replaced folded a 24h window onto itself.
	const { effectiveTimezone } = useTimezonePreference()
	const axis = useMemo(
		() => makeBucketAxis(xDomain ?? data.map((point) => point.bucket), effectiveTimezone),
		[xDomain, data, effectiveTimezone],
	)

	const labelFor = useMemo(
		() => (name: string) => (name === UNNAMED_SERIES_KEY ? (seriesLabel ?? name) : name),
		[seriesLabel],
	)

	const lastValues = useMemo(() => {
		const out: Record<string, number> = {}
		const latest = data[data.length - 1]
		if (!latest) return out
		for (const name of series) {
			const value = latest[name]
			if (typeof value === "number") out[name] = value
		}
		return out
	}, [data, series])

	/**
	 * Axis ticks only. "0.5 cores" does not fit the pinned 56px gutter and was
	 * clipping to "5 cores" — a wrong number, not a short one. The header chip
	 * and the tooltip still print the unit, so the axis can carry the bare value.
	 */
	const tickFormatter = useMemo(
		() => (value: number) =>
			unit === "cores"
				? // Two decimals, or two digits where a tick is smaller than that.
					value.toLocaleString(
						undefined,
						Math.abs(value) < 0.1
							? { maximumSignificantDigits: 2 }
							: { maximumFractionDigits: 2 },
					)
				: unit === "bytes_per_second"
					? // "391 KB/s" clips the same way: the tooltip keeps the "/s".
						formatBytes(value)
					: formatValueWithUnit(value, unit),
		[unit],
	)

	/**
	 * One domain for the axis and the threshold alike.
	 *
	 * `thresholdRules` has no equivalent of Recharts' `ifOverflow="extendDomain"`,
	 * so the rule is fed to `linearYDomain` here — otherwise an 80% line over a
	 * chart peaking at 40% paints outside the plot, on top of the axis labels.
	 */
	const yDomain = useMemo<[number, number]>(() => {
		const thresholds = showThreshold && unit === "percent" ? [{ value: THRESHOLD_FRACTION }] : []
		return niceLinearDomain(linearYDomain({ rows: data, keys: series, stacked, thresholds }))
	}, [data, series, stacked, showThreshold, unit])

	// Series names carry dots and slashes (container names, mount points), which
	// is why they were never routed through `var(--color-…)` variables.
	const cursorSeries = useMemo<CursorPlotSeries<InfraDatum>[]>(() => {
		const tokens = resolveSeriesColors(series)
		return series.map((name) => ({
			key: name,
			label: labelFor(name),
			color: tokens.get(name) ?? "--border",
			// Read off the pivoted ROW, so a stacked chart still prints every
			// series at the hovered bucket rather than only the band under the
			// cursor, the same reason the bar chart reads through `cell.row`.
			value: (datum: InfraDatum) => {
				const value = rowOf(datum)[name]
				return typeof value === "number" ? value : null
			},
			format: (value: number) => formatValueWithUnit(value, unit),
		}))
	}, [series, labelFor, unit])
	const plot = useCursorPlot(cursorSeries)
	const colors = plot.colors

	const definition = useMemo(() => {
		const at = (point: TransformedPoint) => point.date
		const valueOf = (name: string) => (point: TransformedPoint) => {
			const value = point[name]
			return typeof value === "number" ? value : null
		}
		const colorOf = plot.color
		const gradientFor = (name: string) => `${gradientPrefix}-${name.replace(/\W+/g, "_")}`
		const curve = d3Curve(curveMonotoneX)

		const thresholds =
			showThreshold && unit === "percent"
				? [{ value: THRESHOLD_FRACTION, color: "--severity-warn", label: "80%" }]
				: []

		/**
		 * Stacking is expressed over CELLS — one datum per series per bucket, with
		 * `z` naming the series — because `stack()` groups on `z`. Recharts stacked
		 * by matching `stackId` across sibling `<Area>` elements instead.
		 */
		const cells: InfraCell[] = stacked
			? data.flatMap((point) => series.map((name) => ({ point, name, value: valueOf(name)(point) })))
			: []

		const bands = stacked
			? [
					areaY(cells, {
						x: (cell: InfraCell) => cell.point.date,
						y: (cell: InfraCell) => cell.value,
						z: (cell: InfraCell) => cell.name,
						fill: (cell: InfraCell) => `url(#${gradientFor(cell.name)})`,
						stroke: (cell: InfraCell) => colorOf(cell.name),
						strokeWidth: STROKE_WIDTH,
						curve,
						layout: stack({ order: [...series] }),
					}),
				]
			: series.map((name) =>
					lineY(data, {
						id: name,
						x: at,
						y: valueOf(name),
						stroke: colorOf(name),
						strokeWidth: STROKE_WIDTH,
						curve,
					}),
				)

		return defineChart({
			gradients: stacked
				? series.map((name) => verticalGradient(gradientFor(name), colorOf(name), 0.45, 0.04))
				: [],
			marks: [
				// Labels sit at the domain's right end, whether that is the last row
				// or a shared domain that outruns this chart's rows.
				...thresholdRules(thresholds, {
					labelX: axis.domainMs ? new Date(axis.domainMs[1]) : undefined,
				}),
				...bands,
				...series.map((name) => focusDot(data, at, valueOf(name), colorOf(name), plot.chrome)),
				focusCrosshair(plot.chrome),
			],
			scales: {
				x: axis.x,
				y: {
					grid: DASHED_Y_GRID,
					scale: scaleLinear().domain(yDomain),
					axis: { line: false, ticks: { size: 0, padding: 8, format: tickFormatter } },
				},
			},
			// A pinned left margin so sibling charts on the page share a plot edge.
			// `bottom` is left unset: an authored side is a hard lock, and `bottom: 0`
			// (carried over from Recharts, which sized the axis separately) clipped
			// the x tick labels out and halved the y axis's "0". Unset, the frame
			// measures the labels and reserves their height.
			margin: { top: 12, right: 12, left: 56 },
			focus: "group-x",
			focusRing: false,
			tooltip: plot.tooltip,
		})
	}, [data, series, axis, stacked, plot, gradientPrefix, yDomain, tickFormatter, showThreshold, unit])

	if (data.length === 0) {
		return <ChartEmpty height={height}>{CHART_EMPTY_MESSAGE}</ChartEmpty>
	}

	return (
		<div className={cn(refreshingClass(waiting), className)} aria-busy={waiting || undefined}>
			{header?.({ series, colors, lastValues, labelFor, unit })}
			<div className="relative" {...linkedCursorChartProps(linkedChartId)}>
				{/*
				 * `linkedCursorChartProps` only MARKS this chart as a participant; the
				 * overlay is the element the hook actually positions and paints. The
				 * port kept the marker and dropped the overlay, so the hook found every
				 * sibling and had nothing to draw on — hovering one infra chart stopped
				 * showing the cursor on the others, on `/infra/$hostName` and in the
				 * correlation panel. Caught by `infra.perf.spec.ts`, which asserts four
				 * overlays and was finding zero.
				 */}
				{linkedChartId != null && <LinkedCursorOverlay chartId={linkedChartId} />}
				<CursorPlot
					plot={plot}
					definition={definition}
					series={cursorSeries}
					heading={(datum: InfraDatum) => axis.heading(rowOf(datum).bucket)}
					ariaLabel={seriesLabel ?? "Utilization"}
					height={plotHeight}
				/>
			</div>
		</div>
	)
}
