import { useMemo } from "react"
import { d3Curve, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"

import { formatWarehouseDateTime } from "@maple/query-engine"
import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	focusDot,
	usePlotChromeColors,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { ChartEmpty } from "@maple/ui/components/charts"
import { cn } from "@maple/ui/lib/utils"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"

import { CHART_EMPTY_MESSAGE, bucketDate, makeBucketAxis } from "@/components/infra/chart-utils"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { errorRate, formatDurationNs, type ToolSeriesPoint } from "@/lib/agent-sessions/tool-analytics"

const PLOT_HEIGHT = 160
const STROKE_WIDTH = 1.75

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

/** One line of one cell. `key` is the column it reads off the row. */
interface ChartSeries {
	readonly key: string
	readonly label: string
	readonly color: string
}

interface ChartRow extends Record<string, string | number | Date | null> {
	bucket: string
	date: Date
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
	const chromeColors = usePlotChromeColors()
	const focusStore = useMemo(() => createTooltipFocusStore(), [])
	const { effectiveTimezone } = useTimezonePreference()

	const axis = useMemo(
		() => makeBucketAxis(rows.map((row) => row.bucket), effectiveTimezone),
		[rows, effectiveTimezone],
	)

	const definition = useMemo(() => {
		const at = (row: ChartRow) => row.date
		const valueOf = (key: string) => (row: ChartRow) => {
			const value = row[key]
			return typeof value === "number" ? value : null
		}
		const curve = d3Curve(curveMonotoneX)
		return defineChart({
			marks: [
				dashedGridY(),
				...series.map((line) =>
					lineY(rows, {
						id: line.key,
						x: at,
						y: valueOf(line.key),
						stroke: line.color,
						strokeWidth: STROKE_WIDTH,
						curve,
					}),
				),
				...series.map((line) => focusDot(rows, at, valueOf(line.key), line.color, chromeColors)),
				focusCrosshair(chromeColors),
			],
			scales: {
				x: axis.x,
				y: {
					scale: scaleLinear,
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
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [rows, series, chromeColors, axis, format, focusStore])

	const tooltipSeries = useMemo<PlotTooltipSeries<ChartRow>[]>(
		() =>
			series.map((line) => ({
				label: line.label,
				color: line.color,
				value: (row: ChartRow) => {
					const value = row[line.key]
					return typeof value === "number" ? value : null
				},
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
						{series.map((line) => (
							<span key={line.key} className="flex items-center gap-1.5">
								<span
									aria-hidden
									className="h-[2.5px] w-3 shrink-0 rounded-full"
									style={{ backgroundColor: line.color }}
								/>
								<span className="text-foreground/75">{line.label}</span>
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
								heading={(row: ChartRow) => axis.heading(row.bucket)}
							/>
						)}
					/>
				</div>
			)}
		</section>
	)
}
