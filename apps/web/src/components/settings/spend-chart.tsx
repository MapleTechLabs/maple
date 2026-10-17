import { useMemo } from "react"
import { areaY, d3Curve, defineChart, dot, lineY, ruleX, stack } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"

import {
	CursorPlot,
	DASHED_Y_GRID,
	focusCrosshair,
	makeBucketAxis,
	useCursorPlot,
	type CursorPlotSeries,
} from "@maple/ui/components/plot"

/** One stacked band segment: a day, the band it belongs to, and its dollars. */
interface SpendCell {
	point: CumulativePoint
	band: (typeof BANDS)[number]
	value: number | null
}

/**
 * What reaches the tooltip: a band segment when the stack is hovered, or a bare
 * day from the projection line.
 */
type SpendDatum = CumulativePoint | SpendCell

/** The day behind a datum — every band's cumulative total at that point. */
function dayOf(datum: SpendDatum): CumulativePoint {
	return "point" in datum ? datum.point : datum
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null)
import { ChartEmpty, ChartLoading } from "@maple/ui/components/charts"

import { ErrorState } from "@/components/common/error-state"
import { SeriesLegend } from "@/components/common/series-legend"

import { formatCurrency } from "@maple/domain/format"
import {
	buildCumulativeSeries,
	type CumulativePoint,
	FEATURE_COLORS,
	FEATURE_LABELS,
	SPEND_FEATURES,
	type SpendModel,
} from "@/lib/billing/spend"
import type { DailySpendResponse } from "@maple/domain/http"
import { formatDateInTimezone } from "@/lib/timezone-format"

/**
 * Cumulative spend for the cycle, stacked by what's driving it.
 *
 * Cumulative rather than daily on purpose: the question this chart answers is
 * "where will the bill land", and a daily bar chart makes the reader integrate in
 * their head. Per-feature volume lives in the usage table.
 *
 * The base fee is a flat bottom band from day 1 — it's owed on day 1 — while the
 * dashed projection carries today's actual total to the end of the cycle.
 */

/** The plot itself. The states around it reserve {@link SPEND_CHART_HEIGHT}. */
const CHART_HEIGHT = 150

/**
 * The box the chart occupies including its legend strip, so the skeleton and the
 * empty state don't collapse the card while the cycle's spend loads.
 */
const SPEND_CHART_HEIGHT = 190

const chartConfig = {
	base: { label: "Base plan", color: "#57534a" },
	logs: { label: FEATURE_LABELS.logs, color: FEATURE_COLORS.logs },
	traces: { label: FEATURE_LABELS.traces, color: FEATURE_COLORS.traces },
	metrics: { label: FEATURE_LABELS.metrics, color: FEATURE_COLORS.metrics },
	browser_sessions: {
		label: FEATURE_LABELS.browser_sessions,
		color: FEATURE_COLORS.browser_sessions,
	},
	product_events: {
		label: FEATURE_LABELS.product_events,
		color: FEATURE_COLORS.product_events,
	},
} satisfies Record<string, { label: string; color: string }>

const BANDS = ["base", ...SPEND_FEATURES] as const

export function SpendChartSkeleton() {
	return <ChartLoading variant="area" height={SPEND_CHART_HEIGHT} />
}

/** The daily spend read failed: say so instead of showing an empty cycle. */
export function SpendChartError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
	return (
		<div style={{ height: SPEND_CHART_HEIGHT }}>
			<ErrorState
				error={error}
				title="Couldn't load daily spend"
				onRetry={onRetry}
				className="border-0"
			/>
		</div>
	)
}

/** Spend days are UTC calendar days: label them on that clock whatever the viewer's zone. */
const SPEND_TIME_ZONE = "UTC"

const dateLabel = (value: string) =>
	formatDateInTimezone(new Date(`${value}T00:00:00Z`), { timeZone: SPEND_TIME_ZONE, withYear: false })

/** The dashed projection's series key; not a band, so not in the tooltip. */
const PROJECTED = "projected"

export function SpendChart({ model, daily }: { model: SpendModel; daily: DailySpendResponse | undefined }) {
	const data = useMemo(() => buildCumulativeSeries({ daily, model }), [daily, model])

	const projected = model.projectedCents / 100

	// The y-domain must contain both actual spend and the projection.
	const yMax = useMemo(() => {
		const peak = Math.max(projected, ...data.map((point) => point.total ?? 0), 1)
		return Math.ceil((peak * 1.1) / 10) * 10
	}, [data, projected])

	// Where "today" sits on an axis that now runs to the end of the cycle, and
	// where the projection lands.
	const todayPoint = useMemo(() => data.findLast((point) => !point.future), [data])

	// Cycle-to-date dollars per band, read off the last actual day: the legend
	// lists only the bands that hold any spend.
	const bandTotals = useMemo(() => {
		const latest = data.findLast((point) => !point.future)
		return {
			base: latest?.base ?? 0,
			logs: latest?.logs ?? 0,
			traces: latest?.traces ?? 0,
			metrics: latest?.metrics ?? 0,
			browser_sessions: latest?.browser_sessions ?? 0,
			product_events: latest?.product_events ?? 0,
		} satisfies Record<(typeof BANDS)[number], number>
	}, [data])
	const lastPoint = data[data.length - 1]
	const hasFuture = lastPoint !== undefined && lastPoint.future

	const series = useMemo<CursorPlotSeries<SpendDatum>[]>(
		() => [
			...BANDS.map((band) => ({
				key: band,
				label: chartConfig[band].label,
				color: chartConfig[band].color,
				// Read off the DAY, so a hovered band still prints every other band's
				// running total at that point rather than only its own.
				value: (datum: SpendDatum) => {
					const value = dayOf(datum)[band]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatCurrency(value, model.currency),
			})),
			{
				key: PROJECTED,
				label: "Projected",
				color: "--primary",
				value: (datum: SpendDatum) => dayOf(datum).projected,
				format: (value: number) => formatCurrency(value, model.currency),
				tooltip: false,
			},
		],
		[model.currency],
	)
	const plot = useCursorPlot(series)
	const primary = plot.color(PROJECTED)

	// A daily time axis: the same ticks every other bucketed chart draws over
	// the same range, printing "Feb 14" for day buckets.
	const axis = useMemo(
		() =>
			makeBucketAxis(
				data.map((point) => point.date),
				SPEND_TIME_ZONE,
			),
		[data],
	)

	const definition = useMemo(() => {
		const at = (point: CumulativePoint) => new Date(point.dayMs)

		/**
		 * Stacking groups on `z`, so the bands are built as CELLS — one datum per
		 * band per day. Recharts stacked by matching `stackId` across five sibling
		 * `<Area>` elements instead.
		 */
		const cells: SpendCell[] = data.flatMap((point) =>
			BANDS.map((band) => ({
				point,
				band,
				value: numberOrNull(point[band]),
			})),
		)

		return defineChart({
			marks: [
				areaY(cells, {
					x: (cell: SpendCell) => at(cell.point),
					y: (cell: SpendCell) => cell.value,
					z: (cell: SpendCell) => cell.band,
					fill: (cell: SpendCell) => plot.color(cell.band),
					fillOpacity: 0.35,
					stroke: (cell: SpendCell) => plot.color(cell.band),
					strokeWidth: 1,
					curve: d3Curve(curveMonotoneX),
					layout: stack({ order: [...BANDS] }),
				}),
				// The projection: today's actual total joined to where the cycle
				// lands, dashed because it has not happened.
				...(hasFuture
					? [
							// Only today and the last day carry a value; the nulls between would
							// break the line into gaps, so draw the two-point segment directly.
							lineY(
								data.filter((point) => typeof point.projected === "number"),
								{
									id: "projected",
									x: at,
									y: (point: CumulativePoint) =>
										typeof point.projected === "number" ? point.projected : null,
									stroke: primary,
									strokeWidth: 1.5,
									strokeDasharray: "4 4",
								},
							),
						]
					: []),
				// The endpoint. `decorative` so it takes no focus from the bands and does
				// not widen the chart's point type. Its amount is the Projected figure above.
				...(hasFuture && lastPoint
					? [
							decorative(
								dot([lastPoint], {
									x: at,
									y: () => projected,
									r: 3,
									fill: primary,
								}),
							),
						]
					: []),
				// "Today" — a vertical rule, which is what `ReferenceLine x=` was.
				...(todayPoint
					? [
							decorative(
								ruleX([todayPoint], {
									x: at,
									stroke: plot.chrome.border,
									strokeOpacity: 1,
									strokeWidth: 1,
								}),
							),
						]
					: []),
				focusCrosshair(plot.chrome),
			],
			scales: {
				x: axis.x,
				y: {
					grid: DASHED_Y_GRID,
					scale: scaleLinear().domain([0, yMax]),
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 8,
							format: (value: number) => `$${Math.round(value)}`,
						},
					},
				},
			},
			// `bottom` is left unset: an authored side is a hard lock, and `bottom: 0`
			// (carried over from Recharts, which sized the axis separately) clipped
			// the x tick labels out and halved the y axis's "0". Unset, the frame
			// measures the labels and reserves their height.
			margin: { top: 8, right: 56, left: 52 },
			focus: "group-x",
			focusRing: false,
			tooltip: plot.tooltip,
		})
	}, [data, hasFuture, lastPoint, todayPoint, projected, yMax, primary, plot, axis])

	if (data.length === 0) {
		return <ChartEmpty height={SPEND_CHART_HEIGHT}>No ingest recorded this cycle yet</ChartEmpty>
	}

	return (
		<div className="flex flex-col">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pt-3">
				<span className="text-2xs font-medium text-muted-foreground">
					Cumulative spend by feature
				</span>
				{/* Colors only: the amounts live in the figures and the cost breakdown. */}
				<SeriesLegend
					className="gap-x-4"
					items={[
						...BANDS.filter((band) => bandTotals[band] > 0).map((band) => ({
							key: band,
							label: chartConfig[band].label,
							color: chartConfig[band].color,
						})),
						...(hasFuture
							? [
									{
										key: PROJECTED,
										label: "Projection",
										color: primary,
										swatch: "dashed" as const,
									},
								]
							: []),
					]}
				/>
			</div>
			<div className="px-2 pt-3 pb-2">
				<CursorPlot
					plot={plot}
					definition={definition}
					series={series}
					heading={(datum: SpendDatum) => dateLabel(dayOf(datum).date)}
					ariaLabel="Cumulative spend this cycle"
					height={CHART_HEIGHT}
				/>
			</div>
		</div>
	)
}
