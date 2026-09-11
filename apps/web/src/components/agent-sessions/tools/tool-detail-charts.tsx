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
import { cn } from "@maple/ui/lib/utils"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"

import { CHART_EMPTY_MESSAGE, bucketDate, makeBucketAxis } from "@/components/infra/chart-utils"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { errorRate, formatDurationNs, type ToolSeriesPoint } from "@/lib/agent-sessions/tool-analytics"

const PLOT_HEIGHT = 160
const BAR_RADIUS = 2
const MAX_BAR_THICKNESS = 48
const DIMMED_FILL_OPACITY = 0.3

// Hoisted, not written at the call site: every `Cell` memo below keys on these,
// and a fresh array (or arrow) per render rebuilds the chart definition on every
// parent render.
const CALLS_SERIES = [{ key: "calls", label: "Calls", color: "var(--primary)" }] as const
const ERROR_RATE_SERIES = [
	{ key: "errorRate", label: "Error rate", color: "var(--severity-error)" },
] as const
const DURATION_SERIES = [
	{ key: "p50", label: "P50", color: "var(--muted-foreground)" },
	{ key: "p90", label: "P90", color: "var(--primary)" },
	{ key: "p95", label: "P95", color: "var(--severity-error)" },
] as const
const CALLS_PER_SESSION_SERIES = [
	{ key: "callsPerSession", label: "Calls per session", color: "var(--chart-2)" },
] as const

const formatOneDecimal = (value: number): string => value.toFixed(1)

/** One bar series of one cell. `key` is the column it reads off the row. */
interface ChartSeries {
	readonly key: string
	readonly label: string
	readonly color: string
}

interface ChartRow extends Record<string, string | number | Date | null> {
	bucket: string
	date: Date
}

/** One bar: a series at a bucket. `row` carries the whole bucket for the tooltip. */
interface BarCell {
	readonly row: ChartRow
	readonly key: string
	readonly color: string
}

function valueAt(row: ChartRow, key: string): number | null {
	const value = row[key]
	return typeof value === "number" ? value : null
}

/**
 * The tool detail page's four readings of one tool, as a 2×2 grid divided by
 * hairlines.
 *
 * Four small charts rather than one chart with a metric selector, because the
 * question this page answers is a comparison BETWEEN them: a tool whose volume
 * is flat while its error rate climbs is a different story from one where both
 * rise together, and a selector makes that story something you have to
 * remember rather than see.
 *
 * Bars, not smoothed lines: a tool's calls are sparse, and a curve through a
 * handful of buckets reads as a trend the samples do not support.
 *
 * The series read behind this page asks for `split: "none"`, so a point is
 * already the whole tool's bucket — its quantiles are measured and its session
 * count is a real `uniqExact`, neither of which survives merging a per-model
 * split on the client.
 */
export function ToolDetailCharts({
	series,
	waiting,
}: {
	series: ReadonlyArray<ToolSeriesPoint>
	waiting?: boolean
}) {
	const rows = useMemo(
		() =>
			[...series]
				.sort((a, b) => a.bucket - b.bucket)
				.map((bucket) => {
					const iso = formatWarehouseDateTime(bucket.bucket)
					return {
						bucket: iso,
						date: bucketDate(iso),
						calls: bucket.calls,
						errorRate: errorRate(bucket),
						p50: bucket.p50,
						p90: bucket.p90,
						p95: bucket.p95,
						// Sessions is a distinct count per bucket, so this is "calls per
						// session that was active in this bucket" — the shape of how hard
						// a session leans on the tool, not a per-session average.
						callsPerSession: bucket.sessions > 0 ? bucket.calls / bucket.sessions : 0,
					} satisfies ChartRow
				}),
		[series],
	)

	return (
		<div className={cn("grid @min-[900px]/page:grid-cols-2", waiting && "opacity-60")}>
			<Cell title="Tool calls" rows={rows} series={CALLS_SERIES} format={formatNumber} />
			<Cell
				title="Error rate"
				rows={rows}
				series={ERROR_RATE_SERIES}
				format={formatErrorRate}
			/>
			<Cell title="Duration" rows={rows} series={DURATION_SERIES} format={formatDurationNs} />
			<Cell
				title="Calls per session"
				rows={rows}
				series={CALLS_PER_SESSION_SERIES}
				format={formatOneDecimal}
			/>
		</div>
	)
}

/**
 * One cell: a title, an optional legend, and the plot.
 *
 * The cell's own borders make the grid — a right hairline and a bottom one, both
 * dropped at the edges by the container's last-child rules, so the four cells
 * read as one divided surface rather than as four cards.
 */
function Cell({
	title,
	rows,
	series,
	format,
}: {
	title: string
	rows: ReadonlyArray<ChartRow>
	series: ReadonlyArray<ChartSeries>
	format: (value: number) => string
}) {
	const focusStore = useMemo(() => createTooltipFocusStore(), [])
	const { effectiveTimezone } = useTimezonePreference()

	const axis = useMemo(
		() => makeBucketAxis(rows.map((row) => row.bucket), effectiveTimezone),
		[rows, effectiveTimezone],
	)

	const definition = useMemo(() => {
		const yDomain = niceLinearDomain(linearYDomain({ rows, keys: series.map((entry) => entry.key) }))
		// One call against a peak of hundreds paints sub-pixel — see `minBarLength`.
		const lift = minBarLength(yDomain)
		// Long-form: `barY` groups side by side off `z` within ONE mark. Grouped,
		// never stacked — the duration percentiles do not add.
		const cells = rows.flatMap((row) =>
			series.map((entry) => ({ row, key: entry.key, color: entry.color })),
		)
		return defineChart({
			marks: [
				dashedGridY(),
				barY(cells, {
					x: (cell: BarCell) => cell.row.date,
					y: (cell: BarCell) => lift(valueAt(cell.row, cell.key)),
					z: (cell: BarCell) => cell.key,
					fill: (cell: BarCell) => cell.color,
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
							count: 3,
							// The duration formatter renders zero as an em dash — right for
							// a headline ("never measured"), wrong for an axis baseline.
							format: (value: number) => (value === 0 ? "0" : format(value)),
						},
					},
				},
			},
			margin: { left: 44, right: 8, top: 6 },
			focus: "group-x",
			// Sparse buckets sit far apart; keep the whole column live between them.
			maxFocusDistance: UNBOUNDED_FOCUS_DISTANCE,
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [rows, series, axis, format, focusStore])

	const tooltipSeries = useMemo<PlotTooltipSeries<BarCell>[]>(
		() =>
			series.map((entry) => ({
				label: entry.label,
				color: entry.color,
				value: (cell: BarCell) => valueAt(cell.row, entry.key),
				format,
			})),
		[series, format],
	)

	return (
		<section className="flex min-w-0 flex-col gap-3.5 border-b border-border px-6 pt-[22px] pb-5 @min-[900px]/page:[&:nth-child(odd)]:border-r">
			<div className="flex items-baseline gap-2.5">
				<h2 className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
					{title}
				</h2>
				<span className="grow" />
				{series.length > 1 ? (
					<span className="flex items-center gap-4 font-mono text-[11px] leading-3.5">
						{series.map((entry) => (
							<span key={entry.key} className="flex items-center gap-1.5">
								<span
									aria-hidden
									className="size-2 shrink-0 rounded-[2px]"
									style={{ backgroundColor: entry.color }}
								/>
								<span className="text-foreground/75">{entry.label}</span>
							</span>
						))}
					</span>
				) : null}
			</div>

			{rows.length === 0 ? (
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
								heading={(cell: BarCell) => axis.heading(cell.row.bucket)}
							/>
						)}
					/>
				</div>
			)}
		</section>
	)
}
