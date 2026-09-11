import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"

import {
	deltaToneClass,
	type OverviewChartSummary,
	type OverviewModelMix,
	type OverviewSeriesPoint,
} from "@/lib/agent-sessions/overview-analytics"

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
 * is a comparison across charts, not a sequence of them.
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
	return (
		<section className="border-b border-border px-6 py-4">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-3">
				<h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Trends</h2>
				<span className="font-mono text-[11.5px] text-muted-foreground">{note}</span>
			</div>

			<div
				className={cn(
					"flex flex-col gap-6 transition-opacity @min-[1100px]/page:flex-row",
					waiting && "opacity-60",
				)}
			>
				<div className="grid min-w-0 flex-1 grid-cols-1 gap-px bg-border @min-[700px]/page:grid-cols-2 @min-[1000px]/page:grid-cols-3">
					{charts.map((chart) => (
						<ChartCell
							key={chart.id}
							chart={chart}
							buckets={chart.id === "modelMix" ? modelMix.points.length : series.length}
							ghost={previousSeries.length > 0}
						/>
					))}
				</div>
				<div className="shrink-0 @min-[1100px]/page:w-[300px]">{rail}</div>
			</div>
		</section>
	)
}

/**
 * One small multiple.
 *
 * The plot area is a placeholder in this pass — the headline, the unit and the
 * delta are the parts the rest of the page is wired to, and the marks land here
 * without moving anything above them.
 */
function ChartCell({
	chart,
	buckets,
	ghost,
}: {
	chart: OverviewChartSummary
	buckets: number
	ghost: boolean
}) {
	return (
		<figure className="flex flex-col gap-1.5 bg-background px-3 py-3" data-chart={chart.id}>
			<figcaption className="flex flex-col gap-0.5">
				<span className="font-mono text-[11.5px] text-foreground">{chart.title}</span>
				<span className="flex items-baseline gap-2">
					<span className="text-[15px] font-semibold tabular-nums leading-5 text-foreground">
						{chart.value}
					</span>
					{chart.delta === null ? null : (
						<span
							className={cn(
								"font-mono text-[11px] tabular-nums",
								deltaToneClass(chart.delta.tone),
							)}
						>
							{chart.delta.text}
						</span>
					)}
				</span>
				<span className="font-mono text-[10.5px] text-muted-foreground/70">{chart.unit}</span>
			</figcaption>
			<div className="flex h-[120px] items-center justify-center rounded border border-dashed border-border/70 bg-muted/25">
				<span className="font-mono text-[10.5px] text-muted-foreground/60">
					{buckets === 0 ? "no data in range" : `${buckets} buckets${ghost ? " · ghost" : ""}`}
				</span>
			</div>
		</figure>
	)
}
