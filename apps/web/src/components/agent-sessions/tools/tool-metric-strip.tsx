import { cn } from "@maple/ui/lib/utils"
import { formatPercent } from "@maple/ui/lib/format"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"

import { StatRailItem } from "@/components/common/stat-rail"
import {
	TOOL_PERCENTILES,
	formatToolCount,
	formatToolMetric,
	metricSpark,
	metricValue,
	toolDelta,
	toolMetricLabel,
	type ToolDelta,
	type ToolMetric,
	type ToolPercentile,
	type ToolSeriesPoint,
	type ToolTotals,
} from "@/lib/agent-sessions/tool-analytics"

/** Bars per spark; the last N buckets of the window. */
const SPARK_WINDOW = 24

interface ToolMetricStripProps {
	totals: ToolTotals
	/** The comparison window. Absent while it loads or if it failed — the deltas drop, the numbers stay. */
	previous: ToolTotals | undefined
	series: ReadonlyArray<ToolSeriesPoint>
	metric: ToolMetric
	percentile: ToolPercentile
	onSelectMetric: (metric: ToolMetric) => void
	/** Re-keys the Duration tile, the chart and the table highlight. */
	onSelectPercentile: (percentile: ToolPercentile) => void
	/** Names the comparison, e.g. "24h". */
	windowLabel: string
	/**
	 * Every session of the window, before any of this page's filters — the
	 * denominator the Sessions tile states its share against. Zero while the
	 * read is in flight, which the tile renders as no share rather than as 0%.
	 */
	allSessions: number
}

/** Tiles sit edge to edge under the page header rather than in a framed rail. */
const TILE = "min-w-0 flex-1 border-l border-border first:border-l-0"

/**
 * Four tiles that are also the chart's selector: whichever one is lit is what
 * the line below it plots.
 *
 * The Duration tile carries a P50 | P90 | P95 picker that re-keys the page;
 * the tile itself stays the same shape whichever is picked.
 */
export function ToolMetricStrip({
	totals,
	previous,
	series,
	metric,
	percentile,
	onSelectMetric,
	onSelectPercentile,
	windowLabel,
	allSessions,
}: ToolMetricStripProps) {
	const tile = (key: Exclude<ToolMetric, "duration">, eyebrow: string) => {
		const delta = toolDelta(totals, previous, key, percentile)
		// The Sessions tile compares against the window's whole session
		// population rather than against the previous window: "142 of 1,284" is
		// what makes a tool's reach legible, and the movement of a session count
		// under a tool filter is not.
		const share = key === "sessions" && allSessions > 0 ? totals.sessions / allSessions : undefined
		return (
			<StatRailItem
				key={key}
				eyebrow={eyebrow}
				value={formatToolMetric(metricValue(totals, key, percentile), key)}
				spark={metricSpark(series, key, percentile).slice(-SPARK_WINDOW)}
				subline={
					share !== undefined ? (
						<SublineText>
							<span>{formatPercent(share)}</span>
							<span className="text-muted-foreground/60">
								of all {formatToolCount(allSessions)} sessions
							</span>
						</SublineText>
					) : delta === null ? null : (
						<SublineText>
							<Delta delta={delta} />
							<span className="text-muted-foreground/60">vs prev {windowLabel}</span>
						</SublineText>
					)
				}
				onSelect={() => onSelectMetric(key)}
				selected={metric === key}
				className={TILE}
			/>
		)
	}

	return (
		<div className="flex flex-wrap border-b border-border @max-[900px]/page:flex-col">
			{tile("calls", "Tool calls")}
			{tile("sessions", "Sessions")}
			{tile("error_rate", "Error rate")}
			<DurationTile
				totals={totals}
				previous={previous}
				series={series}
				selected={metric === "duration"}
				percentile={percentile}
				onSelectMetric={onSelectMetric}
				onSelectPercentile={onSelectPercentile}
				windowLabel={windowLabel}
			/>
		</div>
	)
}

function SublineText({ children }: { children: React.ReactNode }) {
	return <span className="inline-flex items-center gap-[5px] font-mono tabular-nums">{children}</span>
}

/**
 * Duration: the same tile as the other three, keyed on one percentile. The
 * picker is a sibling of the tile's select button rather than a child (nested
 * buttons are invalid HTML), laid over the tile's top-right corner.
 */
function DurationTile({
	totals,
	previous,
	series,
	selected,
	percentile,
	onSelectMetric,
	onSelectPercentile,
	windowLabel,
}: {
	totals: ToolTotals
	previous: ToolTotals | undefined
	series: ReadonlyArray<ToolSeriesPoint>
	selected: boolean
	percentile: ToolPercentile
	onSelectMetric: (metric: ToolMetric) => void
	onSelectPercentile: (percentile: ToolPercentile) => void
	windowLabel: string
}) {
	const delta = toolDelta(totals, previous, "duration", percentile)
	return (
		<div className={cn("relative", TILE)}>
			<StatRailItem
				eyebrow="Duration"
				value={formatToolMetric(totals[percentile], "duration")}
				spark={metricSpark(series, "duration", percentile).slice(-SPARK_WINDOW)}
				subline={
					delta === null ? null : (
						<SublineText>
							<Delta delta={delta} />
							<span className="text-muted-foreground/60">vs prev {windowLabel}</span>
						</SublineText>
					)
				}
				onSelect={() => onSelectMetric("duration")}
				ariaLabel={toolMetricLabel("duration", percentile)}
				selected={selected}
				className="h-full"
			/>
			<ToggleGroup
				variant="outline"
				size="sm"
				aria-label="Percentile"
				value={[percentile]}
				onValueChange={(next: ReadonlyArray<unknown>) => {
					const picked = TOOL_PERCENTILES.find((candidate) => candidate === next[0])
					if (picked) onSelectPercentile(picked)
				}}
				className="absolute top-3 right-5 p-px"
			>
				{TOOL_PERCENTILES.map((candidate) => (
					<ToggleGroupItem
						key={candidate}
						value={candidate}
						className="h-5 min-w-0 px-1.5 font-mono text-[10px] uppercase sm:h-5 sm:min-w-0 sm:text-[10px]"
					>
						{candidate}
					</ToggleGroupItem>
				))}
			</ToggleGroup>
		</div>
	)
}

/**
 * Change against the previous window, in the unit the metric is read in —
 * a percentage for the counts, points for a rate, a duration for a latency.
 *
 * Colour follows *improvement*, not direction — a falling error rate is green —
 * and the arrow keeps pointing the way the number actually moved, so colour is
 * never the only thing carrying the meaning. Same rule and same tokens as the
 * web analytics strip.
 */
function Delta({ delta }: { delta: ToolDelta }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-[5px]",
				delta.direction === "flat"
					? "text-muted-foreground/70"
					: delta.good
						? "text-[var(--severity-info)]"
						: "text-[var(--severity-error)]",
			)}
			title={`${delta.direction === "flat" ? "Flat" : delta.direction === "up" ? "Up" : "Down"} ${delta.text} vs the previous period`}
		>
			<span aria-hidden>{delta.direction === "flat" ? "→" : delta.direction === "up" ? "↑" : "↓"}</span>
			{delta.text}
		</span>
	)
}

export function ToolMetricStripLoading() {
	return (
		<div className="flex border-b border-border">
			{Array.from({ length: 4 }).map((_, index) => (
				<div key={index} className={cn("flex flex-col gap-[7px] px-5 py-4", TILE)}>
					<Skeleton className="h-3 w-16" />
					<div className="flex items-end justify-between gap-3">
						<Skeleton className="h-7 w-20" />
						<Skeleton className="h-7 w-24" />
					</div>
					<Skeleton className="h-3 w-28" />
				</div>
			))}
		</div>
	)
}
