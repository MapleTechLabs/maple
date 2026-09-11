import { cn } from "@maple/ui/lib/utils"
import { formatPercent } from "@maple/ui/lib/format"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { BarSpark } from "@/components/infra/primitives/stat-rail"
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

/**
 * The active-tile marker: a 2px lane reserved on every tile, painted only on
 * the selected one, so the contents never shift sideways as the selection
 * moves. The same mark the picked table rows use — it is the same gesture.
 */
const TILE =
	"relative flex min-w-0 flex-1 flex-col gap-[7px] border-l border-border py-4 pl-[22px] pr-5 text-left transition-colors first:border-l-0 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors focus-visible:outline-none"
const TILE_SELECTED = "bg-primary/10 before:bg-primary"
const TILE_IDLE = "before:bg-transparent hover:bg-muted/25"

const EYEBROW = "font-mono text-[10.5px] uppercase leading-5 tracking-[0.09em] transition-colors"

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
		const selected = metric === key
		const delta = toolDelta(totals, previous, key, percentile)
		// The Sessions tile compares against the window's whole session
		// population rather than against the previous window: "142 of 1,284" is
		// what makes a tool's reach legible, and the movement of a session count
		// under a tool filter is not.
		const share =
			key === "sessions" && allSessions > 0 ? totals.sessions / allSessions : undefined
		const spark = metricSpark(series, key, percentile).slice(-SPARK_WINDOW)
		return (
			<button
				key={key}
				type="button"
				aria-pressed={selected}
				onClick={() => onSelectMetric(key)}
				className={cn(TILE, selected ? TILE_SELECTED : TILE_IDLE)}
			>
				<span className={cn(EYEBROW, selected ? "text-primary" : "text-muted-foreground/80")}>
					{eyebrow}
				</span>
				<span className="flex items-end justify-between gap-3">
					<Value selected={selected}>
						{formatToolMetric(metricValue(totals, key, percentile), key)}
					</Value>
					<Spark values={spark} />
				</span>
				<span className="flex h-3.5 items-center gap-[5px] font-mono text-[11.5px] tabular-nums">
					{share !== undefined ? (
						<>
							<span className="text-muted-foreground">{formatPercent(share)}</span>
							<span className="text-muted-foreground/60">
								of all {formatToolCount(allSessions)} sessions
							</span>
						</>
					) : delta === null ? null : (
						<>
							<Delta delta={delta} />
							<span className="text-muted-foreground/60">vs prev {windowLabel}</span>
						</>
					)}
				</span>
			</button>
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

function Value({ selected, children }: { selected: boolean; children: React.ReactNode }) {
	return (
		<span
			className={cn(
				"shrink-0 whitespace-nowrap text-[26px] font-semibold leading-7 tracking-[-0.02em] tabular-nums",
				selected ? "text-foreground" : "text-foreground/75",
			)}
		>
			{children}
		</span>
	)
}

/** Every spark is drawn in the primary: the tiles are one instrument, not four readouts. */
function Spark({ values }: { values: ReadonlyArray<number> }) {
	return values.length > 1 ? (
		<BarSpark values={values} color="var(--primary)" className="h-7 w-24 min-w-0 shrink" />
	) : (
		<span className="h-7 w-24 min-w-0 shrink" />
	)
}

/**
 * Duration: the same tile as the other three, keyed on one percentile. The
 * P50 | P90 | P95 picker sits in the eyebrow row, always visible and always
 * the same size, so choosing a percentile never changes the tile's shape.
 * The picker is a sibling of the select button rather than a child — nested
 * buttons are invalid HTML — and the select button covers the tile behind it.
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
	const spark = metricSpark(series, "duration", percentile).slice(-SPARK_WINDOW)
	const delta = toolDelta(totals, previous, "duration", percentile)
	return (
		<div className={cn(TILE, selected ? TILE_SELECTED : TILE_IDLE)}>
			<button
				type="button"
				aria-pressed={selected}
				aria-label={toolMetricLabel("duration", percentile)}
				onClick={() => onSelectMetric("duration")}
				className="absolute inset-0 focus-visible:outline-none"
			/>
			<span className="pointer-events-none relative flex h-5 items-center justify-between gap-2">
				<span className={cn(EYEBROW, selected ? "text-primary" : "text-muted-foreground/80")}>
					Duration
				</span>
				<span
					aria-label="Percentile"
					className="pointer-events-auto flex items-center gap-px rounded-sm border border-border bg-background/60 p-px"
				>
					{TOOL_PERCENTILES.map((candidate) => {
						const driving = candidate === percentile
						return (
							<button
								key={candidate}
								type="button"
								aria-pressed={driving}
								onClick={() => onSelectPercentile(candidate)}
								className={cn(
									"rounded-[3px] px-1.5 font-mono text-[10px] uppercase leading-4 tracking-[0.04em] transition-colors focus-visible:outline-none",
									driving
										? "bg-muted text-foreground"
										: "text-muted-foreground/70 hover:text-foreground",
								)}
							>
								{candidate}
							</button>
						)
					})}
				</span>
			</span>
			<span className="pointer-events-none relative flex items-end justify-between gap-3">
				<Value selected={selected}>{formatToolMetric(totals[percentile], "duration")}</Value>
				<Spark values={spark} />
			</span>
			<span className="pointer-events-none relative flex h-3.5 items-center gap-[5px] font-mono text-[11.5px] tabular-nums">
				{delta === null ? null : (
					<>
						<Delta delta={delta} />
						<span className="text-muted-foreground/60">vs prev {windowLabel}</span>
					</>
				)}
			</span>
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
			<span aria-hidden>
				{delta.direction === "flat" ? "→" : delta.direction === "up" ? "↑" : "↓"}
			</span>
			{delta.text}
		</span>
	)
}

export function ToolMetricStripLoading() {
	return (
		<div className="flex border-b border-border">
			{Array.from({ length: 4 }).map((_, index) => (
				<div key={index} className={TILE}>
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
