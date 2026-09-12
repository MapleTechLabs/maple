import { useMemo } from "react"
import { barY, defineChart, group } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"

import { formatWarehouseDateTime } from "@maple/query-engine"
import {
	PlotFrame,
	PlotTooltipBody,
	UNBOUNDED_FOCUS_DISTANCE,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	linearYDomain,
	minBarLength,
	niceLinearDomain,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { ChartEmpty } from "@maple/ui/components/charts"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { QueryErrorState } from "@/components/common/query-error-state"
import { CHART_EMPTY_MESSAGE, bucketDate, makeBucketAxis } from "@/components/infra/chart-utils"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import {
	formatToolMetric,
	metricValue,
	toolChartTitle,
	toolMetricLabel,
	type ToolMetric,
	type ToolPercentile,
	type ToolSeriesPoint,
} from "@/lib/agent-sessions/tool-analytics"

const PLOT_HEIGHT = 220
const BAR_RADIUS = 2
const MAX_BAR_THICKNESS = 48
const DIMMED_FILL_OPACITY = 0.3

/** One bar series of the chart. `key` is the column it reads off a row. */
interface ChartSeries {
	readonly key: string
	readonly label: string
	readonly color: string
}

/** Duration draws all three readings at once; the driving one is in the primary. */
const DURATION_SERIES = {
	p50: durationSeries("p50"),
	p90: durationSeries("p90"),
	p95: durationSeries("p95"),
} satisfies Record<ToolPercentile, ReadonlyArray<ChartSeries>>

function durationSeries(driving: ToolPercentile): ReadonlyArray<ChartSeries> {
	return (["p50", "p90", "p95"] as const).map((key) => ({
		key,
		label: key.toUpperCase(),
		color:
			key === driving
				? "var(--primary)"
				: key === "p95"
					? "var(--severity-error)"
					: "var(--muted-foreground)",
	}))
}

/** One bucket of the whole scope. */
interface ToolChartRow extends Record<string, string | number | Date | null> {
	bucket: string
	date: Date
}

/** One bar: a series at a bucket. `row` carries the whole bucket for the tooltip. */
interface ToolBarCell {
	readonly row: ToolChartRow
	readonly key: string
	readonly color: string
}

function valueAt(row: ToolChartRow, key: string): number | null {
	const value = row[key]
	return typeof value === "number" ? value : null
}

interface ToolSeriesChartProps {
	/** One point per bucket — the selection merged inside the query. */
	series: ReadonlyArray<ToolSeriesPoint>
	/** The series read has not answered — distinct from a window with no calls. */
	loading?: boolean
	/** The series read failed. */
	failure?: unknown
	metric: ToolMetric
	percentile: ToolPercentile
	tool: string | undefined
	model: string | undefined
	/** A model id as a reader should see it. */
	modelLabel: (model: string) => string
	waiting?: boolean
}

/**
 * The selected metric over the window, as bars for the whole scope.
 *
 * Bars, not a smoothed line: agent sessions are low volume, and a curve through
 * a handful of buckets reads as a trend the samples do not support. A bar per
 * bucket shows exactly where readings exist.
 *
 * The series arrives already merged by the warehouse (`split: "none"`), never
 * folded here: a bucket's sessions do not add across tools and its percentiles
 * do not average. Duration draws P50, P90 and P95 side by side — grouped, never
 * stacked, since percentiles do not add — because "is the tail moving while the
 * median holds?" is the question the metric is picked for.
 */
export function ToolSeriesChart({
	series,
	loading,
	failure,
	metric,
	percentile,
	tool,
	model,
	modelLabel,
	waiting,
}: ToolSeriesChartProps) {
	const focusStore = useMemo(() => createTooltipFocusStore(), [])
	const { effectiveTimezone } = useTimezonePreference()

	const bars = useMemo<ReadonlyArray<ChartSeries>>(
		() =>
			metric === "duration"
				? DURATION_SERIES[percentile]
				: [{ key: metric, label: toolMetricLabel(metric, percentile), color: "var(--primary)" }],
		[metric, percentile],
	)

	const rows = useMemo<ReadonlyArray<ToolChartRow>>(
		() =>
			series
				.toSorted((a, b) => a.bucket - b.bucket)
				.map((point) => {
					const iso = formatWarehouseDateTime(point.bucket)
					return {
						bucket: iso,
						date: bucketDate(iso),
						[metric]: metricValue(point, metric, percentile),
						p50: point.p50,
						p90: point.p90,
						p95: point.p95,
					}
				}),
		[series, metric, percentile],
	)

	const axis = useMemo(
		() =>
			makeBucketAxis(
				rows.map((row) => row.bucket),
				effectiveTimezone,
			),
		[rows, effectiveTimezone],
	)

	const tooltipSeries = useMemo<PlotTooltipSeries<ToolBarCell>[]>(
		() =>
			bars.map((bar) => ({
				label: bar.label,
				color: bar.color,
				value: (cell: ToolBarCell) => valueAt(cell.row, bar.key),
				format: (value: number) => formatToolMetric(value, metric),
			})),
		[bars, metric],
	)

	const definition = useMemo(() => {
		const yDomain = niceLinearDomain(linearYDomain({ rows, keys: bars.map((bar) => bar.key) }))
		// One call against a peak of hundreds paints sub-pixel — see `minBarLength`.
		const lift = minBarLength(yDomain)
		// Long-form: `barY` groups side by side off `z` within ONE mark.
		const cells = rows.flatMap((row) => bars.map((bar) => ({ row, key: bar.key, color: bar.color })))

		return defineChart({
			marks: [
				dashedGridY(),
				barY(cells, {
					x: (cell: ToolBarCell) => cell.row.date,
					y: (cell: ToolBarCell) => lift(valueAt(cell.row, cell.key)),
					z: (cell: ToolBarCell) => cell.key,
					fill: (cell: ToolBarCell) => cell.color,
					layout: group(),
					radius: BAR_RADIUS,
					maxThickness: MAX_BAR_THICKNESS,
					// The hovered bucket keeps its fill and every other one dims.
					states: [
						{
							when: (context: { matches: (match: "x") => boolean }) => !context.matches("x"),
							style: { fillOpacity: DIMMED_FILL_OPACITY },
						},
					],
				}),
			],
			scales: {
				x: axis.xBand,
				y: {
					scale: scaleLinear().domain(yDomain),
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 8,
							// The duration formatter renders zero as an em dash — right for
							// a headline ("never measured"), wrong for an axis baseline.
							format: (value: number) => (value === 0 ? "0" : formatToolMetric(value, metric)),
						},
					},
				},
			},
			// `left` unset: the frame measures the tick labels, and a fixed width
			// clipped duration ticks ("5.7min" drew as ".7min").
			margin: { right: 8, top: 4 },
			focus: "group-x",
			// Sparse buckets sit far apart; keep the whole column live between them.
			maxFocusDistance: UNBOUNDED_FOCUS_DISTANCE,
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [rows, bars, axis, metric, focusStore])

	const title = toolChartTitle({
		metric,
		percentile,
		tool,
		model: model === undefined ? undefined : modelLabel(model),
	})

	// The head is the title's parts, each drawn as what it is: the metric as a
	// heading and the scope in the primary (it is the same selection the chips
	// and the lit tile show).
	const scopeParts = [tool, model === undefined ? undefined : modelLabel(model)].filter(
		(part): part is string => part !== undefined,
	)
	const bucketMs = axis.stepMs ?? null

	return (
		<section
			className={cn(
				"flex flex-col gap-4 border-b border-border px-6 pt-[22px] pb-5",
				waiting && "opacity-60",
			)}
		>
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-[12.5px]">
				<h2 className="font-sans text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
					{toolMetricLabel(metric, percentile)}
				</h2>
				{scopeParts.map((part) => (
					<span key={part} className="contents">
						<Dot />
						<span className="text-primary">{part}</span>
					</span>
				))}
				<span className="grow" />
				<span className="text-[11px] text-muted-foreground/60">
					{bucketMs === null ? null : `${bucketLabel(bucketMs)} buckets`}
				</span>
			</div>

			{/* Only where there is more than one series to tell apart — a single
			    series is already named by the head. */}
			{bars.length > 1 ? (
				<div className="-mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] leading-3.5">
					{bars.map((bar) => (
						<span key={bar.key} className="flex items-center gap-1.5">
							<span
								aria-hidden
								className="size-2 shrink-0 rounded-[2px]"
								style={{ backgroundColor: bar.color }}
							/>
							<span className="text-foreground/75">{bar.label}</span>
						</span>
					))}
				</div>
			) : null}

			{failure !== undefined ? (
				<QueryErrorState error={failure} titleOverride={`Failed to load ${title}`} />
			) : loading && rows.length === 0 ? (
				<Skeleton className="w-full" style={{ height: PLOT_HEIGHT }} />
			) : rows.length === 0 ? (
				<ChartEmpty height={PLOT_HEIGHT}>{CHART_EMPTY_MESSAGE}</ChartEmpty>
			) : (
				<div className="w-full" style={{ height: PLOT_HEIGHT }}>
					<PlotFrame
						definition={definition}
						ariaLabel={title}
						className="h-full w-full"
						renderTooltipBody={({ points }) => (
							<PlotTooltipBody
								points={points}
								series={tooltipSeries}
								focusStore={focusStore}
								heading={(cell: ToolBarCell) => axis.heading(cell.row.bucket)}
							/>
						)}
					/>
				</div>
			)}
		</section>
	)
}

/** "1h" / "5m" — the bucket width, as a chart note rather than a measurement. */
function bucketLabel(ms: number): string {
	return ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 60_000)}m`
}

function Dot() {
	return (
		<span aria-hidden className="text-xs text-muted-foreground/60">
			·
		</span>
	)
}
