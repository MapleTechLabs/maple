import { useMemo, type ReactNode } from "react"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { makeBucketAxis } from "@/components/infra/chart-utils"
import { useLinkedCursor } from "@/hooks/use-linked-cursor"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import {
	OVERVIEW_CHARTS,
	type OverviewChartSummary,
	type OverviewModelMix,
	type OverviewSeriesPoint,
} from "@/lib/agent-sessions/overview-analytics"
import {
	buildOverviewPlotSpec,
	type OverviewPlotLegendItem,
	type OverviewPlotSpec,
} from "@/lib/agent-sessions/overview-chart-specs"

import { DeltaReading } from "./overview-delta"
import { OVERVIEW_PLOT_HEIGHT, OverviewSmallMultiple } from "./overview-small-multiple"

export interface OverviewTrendsProps {
	charts: ReadonlyArray<OverviewChartSummary>
	/** One point per bucket of the selected window, oldest first. */
	series: ReadonlyArray<OverviewSeriesPoint>
	/** The previous period, already shifted onto this axis. Empty with compare off. */
	previousSeries: ReadonlyArray<OverviewSeriesPoint>
	modelMix: OverviewModelMix
	/** The bucket width and range, e.g. `6h buckets · previous 7 days`. */
	note: string
	/** The "What changed" rail, placed beside the grid. */
	rail: ReactNode
	waiting?: boolean
}

/**
 * Nine readings of one window at one bucket width, in one grid.
 *
 * Small multiples rather than one chart with a metric picker: the questions a
 * regression raises are "did anything else move at the same instant", and that
 * is a comparison across charts, not a sequence of them. One axis is built here
 * for all nine — a shared bucket domain is what lets a rule drawn at the same
 * fraction of every plot land on the same instant, which is the whole basis of
 * the linked cursor below.
 */
export function OverviewTrends({
	charts,
	series,
	previousSeries,
	modelMix,
	note,
	rail,
	waiting = false,
}: OverviewTrendsProps) {
	const { effectiveTimezone } = useTimezonePreference()
	const { containerProps } = useLinkedCursor(true)

	const axis = useMemo(() => {
		const buckets = new Set<number>()
		for (const point of series) buckets.add(point.bucket)
		for (const point of previousSeries) buckets.add(point.bucket)
		for (const point of modelMix.points) buckets.add(point.bucket)
		const sorted = [...buckets].sort((a, b) => a - b)
		const base = makeBucketAxis(
			sorted.map((ms) => new Date(ms).toISOString()),
			effectiveTimezone,
		)
		const spanMs = sorted.length < 2 ? 0 : sorted[sorted.length - 1]! - sorted[0]!
		return {
			...base,
			// The shared tick format is written for a full-width chart: "Sep 5, 12:00
			// AM" is most of a 280px plot, so one label survived thinning and the axis
			// read as unlabelled. These carry the terse form the design uses.
			x: {
				...base.x,
				axis: {
					...base.x.axis,
					ticks: { ...base.x.axis.ticks, format: terseTick(spanMs, effectiveTimezone) },
				},
			},
		}
	}, [series, previousSeries, modelMix, effectiveTimezone])

	const specs = useMemo(() => {
		const input = { series, previousSeries, modelMix }
		return new Map(OVERVIEW_CHARTS.map((id) => [id, buildOverviewPlotSpec(id, input)]))
	}, [series, previousSeries, modelMix])

	return (
		<section className="border-b border-border">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-6 pt-4 pb-3">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
					<h2 className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
						Trends
					</h2>
					<span className="font-mono text-[11.5px] text-muted-foreground">
						nine metrics, one clock — hover any chart to move the crosshair on all nine
					</span>
				</div>
				<span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{note}</span>
			</div>

			<div
				className={cn(
					"flex flex-col transition-opacity @min-[1100px]/page:flex-row",
					waiting && "opacity-60",
				)}
				{...containerProps}
			>
				<div className={cn("min-w-0 flex-1 pl-2", CHART_GRID)}>
					{charts.map((chart) => (
						<ChartCell key={chart.id} chart={chart} spec={specs.get(chart.id)} axis={axis} />
					))}
				</div>
				<div className="shrink-0 px-6 py-4 @max-[1100px]/page:max-w-[560px] @min-[1100px]/page:w-[320px] @min-[1100px]/page:border-l @min-[1100px]/page:border-border @min-[1100px]/page:pt-0">
					{rail}
				</div>
			</div>
		</section>
	)
}

const DAY_MS = 86_400_000

/**
 * An x tick as one of these plots can afford to print it: a clock alone inside
 * a day, a date alone on a midnight boundary, and the pair only where a tick
 * lands mid-day in a window that spans several.
 */
function terseTick(spanMs: number, timeZone: string | undefined): (value: Date) => string {
	const day = new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric" })
	const clock = new Intl.DateTimeFormat(undefined, {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})
	return (value: Date) => {
		const time = clock.format(value).replace(/^24:/, "00:")
		if (spanMs <= DAY_MS) return time
		return time === "00:00" ? day.format(value) : `${day.format(value)} ${time}`
	}
}

/**
 * Hairlines between columns, never between rows — the grid is one instrument
 * and a full lattice would read as nine cards. The stacked breakpoints keep
 * that true at two and three columns and fall back to row rules at one, where
 * there is no column to divide.
 */
const CHART_GRID = cn(
	"grid grid-cols-1 @min-[700px]/page:grid-cols-2 @min-[1000px]/page:grid-cols-3",
	"[&>figure]:border-b [&>figure]:border-border [&>figure:last-child]:border-b-0",
	"@min-[700px]/page:[&>figure]:border-r @min-[700px]/page:[&>figure]:border-b-0",
	"@min-[700px]/page:[&>figure:nth-child(2n)]:border-r-0",
	"@min-[1000px]/page:[&>figure:nth-child(2n)]:border-r",
	"@min-[1000px]/page:[&>figure:nth-child(3n)]:border-r-0",
	"@min-[700px]/page:[&>figure:last-child]:border-r-0",
)

/**
 * One small multiple: what it measures, where it stands now, how it moved, what
 * the marks mean, and then the marks.
 */
function ChartCell({
	chart,
	spec,
	axis,
}: {
	chart: OverviewChartSummary
	spec: OverviewPlotSpec | undefined
	axis: ReturnType<typeof makeBucketAxis>
}) {
	return (
		<figure className="flex min-w-0 flex-col px-4 pt-3.5 pb-3" data-chart={chart.id}>
			<figcaption className="flex min-w-0 flex-col">
				<span className="flex items-baseline justify-between gap-2">
					<span className="truncate font-mono text-[12.5px] font-medium text-foreground">
						{chart.title}
					</span>
					<span className="shrink-0 font-mono text-[13px] tabular-nums text-foreground">
						{chart.value}
					</span>
				</span>
				<span className="flex items-center justify-between gap-2 pt-[3px]">
					<span className="truncate font-mono text-[10.5px] text-muted-foreground/70">
						{chart.unit}
					</span>
					<DeltaReading delta={chart.delta} className="font-mono text-[11px]" />
				</span>
			</figcaption>

			{spec === undefined ? null : (
				<>
					<div className="flex items-center gap-x-2 gap-y-1 overflow-hidden pt-[9px]">
						{spec.legend.map((item) => (
							<LegendItem key={item.label} item={item} />
						))}
						{spec.legendMore === 0 ? null : (
							<span className="shrink-0 font-mono text-[10.5px] leading-3 text-muted-foreground/70">
								+{spec.legendMore}
							</span>
						)}
					</div>
					<div className="pt-2">
						<OverviewSmallMultiple
							chartId={chart.id}
							title={chart.title}
							spec={spec}
							axis={axis}
						/>
					</div>
				</>
			)}
		</figure>
	)
}

function LegendItem({ item }: { item: OverviewPlotLegendItem }) {
	return (
		<span className="flex min-w-0 shrink items-center gap-1.5">
			<Swatch item={item} />
			<span className="truncate font-mono text-[10.5px] leading-3 text-muted-foreground">
				{item.label}
			</span>
		</span>
	)
}

function Swatch({ item }: { item: OverviewPlotLegendItem }) {
	if (item.kind === "ghost") {
		return (
			<span
				aria-hidden
				className="h-[2px] w-[9px] shrink-0"
				style={{
					backgroundImage: `repeating-linear-gradient(to right, ${item.color} 0 2.5px, transparent 2.5px 5px)`,
				}}
			/>
		)
	}
	if (item.kind === "line") {
		return (
			<span
				aria-hidden
				className="h-[2px] w-[9px] shrink-0 rounded-[1px]"
				style={{ backgroundColor: item.color }}
			/>
		)
	}
	return (
		<span
			aria-hidden
			className={cn(
				"h-[7px] shrink-0 rounded-[1px]",
				item.kind === "spread" ? "w-[9px] opacity-35" : "w-[7px]",
			)}
			style={{ backgroundColor: item.color }}
		/>
	)
}

/** The grid's shape while the summary read is in flight — nine cells, not one box. */
export function OverviewTrendsLoading() {
	return (
		<section className="border-b border-border">
			<div className="px-6 pt-4 pb-3">
				<Skeleton className="h-5 w-24" />
			</div>
			<div className={cn("pl-2", CHART_GRID)}>
				{OVERVIEW_CHARTS.map((id) => (
					<figure key={id} className="flex flex-col gap-2 px-4 pt-3.5 pb-3">
						<Skeleton className="h-3.5 w-32" />
						<Skeleton className="h-2.5 w-20" />
						<Skeleton className="w-full" style={{ height: OVERVIEW_PLOT_HEIGHT }} />
					</figure>
				))}
			</div>
		</section>
	)
}
