import { cn } from "@maple/ui/lib/utils"
import { formatPercent } from "@maple/ui/lib/format"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { BarSpark, StatRail, StatRailItem } from "@/components/infra/primitives/stat-rail"
import { SPARK_COLOR } from "@/components/infra/severity-tokens"
import {
	TOOL_PERCENTILES,
	formatToolMetric,
	metricDelta,
	metricRiseIsBad,
	metricSpark,
	metricValue,
	type ToolMetric,
	type ToolPercentile,
	type ToolSeriesPoint,
	type ToolTotals,
} from "@/lib/agent-sessions/tool-analytics"

/** The rail's own spark budget, mirrored for the duration tile's full-width one. */
const SPARK_WINDOW = 28

interface ToolMetricStripProps {
	totals: ToolTotals
	/** The comparison window. Absent while it loads or if it failed — the deltas drop, the numbers stay. */
	previous: ToolTotals | undefined
	series: ReadonlyArray<ToolSeriesPoint>
	metric: ToolMetric
	percentile: ToolPercentile
	onSelectMetric: (metric: ToolMetric) => void
	/** Picking a percentile column also takes the chart — see `DurationTile`. */
	onSelectPercentile: (percentile: ToolPercentile) => void
	/** Names the comparison in the duration tile's header, e.g. "7d". */
	windowLabel: string
}

/**
 * Four tiles that are also the chart's selector: whichever one is lit is what
 * the line below it plots.
 *
 * Three of them are plain `StatRailItem`s — the same readout the infrastructure
 * pages use, with the selection support that page already added. The fourth is
 * not, and could not be: a duration has three readings, and the question
 * "is the tail getting worse while the median holds?" is the one this page is
 * most often opened for. Collapsing that to a single percentile behind a
 * dropdown would hide the comparison; three tiles would spend three quarters of
 * the strip on one metric. So the tile carries all three side by side, each
 * clickable, each with its own delta, and one shared "vs prev" in the header
 * because a single comparison window governs all three.
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
}: ToolMetricStripProps) {
	const tile = (key: Exclude<ToolMetric, "duration">, eyebrow: string, delay: number) => {
		const delta = metricDelta(totals, previous, key, percentile)
		return (
			<StatRailItem
				key={key}
				eyebrow={eyebrow}
				value={formatToolMetric(metricValue(totals, key, percentile), key)}
				spark={metricSpark(series, key, percentile)}
				delta={delta === null ? undefined : <Delta delta={delta} riseIsBad={metricRiseIsBad(key)} />}
				selected={metric === key}
				onSelect={() => onSelectMetric(key)}
				delay={delay}
			/>
		)
	}

	return (
		<StatRail>
			{tile("calls", "Tool calls", 0)}
			{tile("sessions", "Sessions", 60)}
			{tile("error_rate", "Error rate", 120)}
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
		</StatRail>
	)
}

/**
 * P50 | P90 | P95, at one size, with the driving percentile marked by a
 * full-strength label over a hairline rule rather than by being bigger or
 * louder. Size would say "this number matters more", and it does not — it is
 * the one the rest of the page is currently keyed to, which is a smaller claim
 * and deserves a smaller mark.
 *
 * The shell reproduces `StatRailItem`'s selectable chrome (the reserved 2px
 * lane, the `bg-muted/40` when lit) because the tile has to sit in the same rail
 * and read as one of four. It is not a `StatRailItem` because that component
 * takes one value, and pushing a three-column layout into it would have made
 * every other rail in the app pay for this page's shape.
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

	return (
		<div
			className={cn(
				"relative px-5 py-4 animate-in fade-in slide-in-from-bottom-1 duration-500",
				"before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors",
				selected ? "bg-muted/40 before:bg-primary" : "before:bg-transparent",
			)}
			style={{ animationDelay: "180ms", animationFillMode: "backwards" }}
		>
			<div className="flex items-baseline justify-between gap-3">
				<span
					className={cn(
						"truncate text-[11px] font-medium transition-colors",
						selected ? "text-primary" : "text-muted-foreground",
					)}
				>
					Duration
				</span>
				{/* One comparison for all three columns, stated once. */}
				<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80">
					vs prev {windowLabel}
				</span>
			</div>

			<div className="mt-2 grid grid-cols-3 gap-1">
				{TOOL_PERCENTILES.map((candidate) => {
					const driving = candidate === percentile
					const delta = metricDelta(totals, previous, "duration", candidate)
					return (
						<button
							key={candidate}
							type="button"
							aria-pressed={selected && driving}
							onClick={() => {
								onSelectPercentile(candidate)
								onSelectMetric("duration")
							}}
							className="group min-w-0 text-left focus-visible:outline-none"
						>
							<span
								className={cn(
									"inline-block border-b pb-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
									driving
										? "border-border text-foreground"
										: "border-transparent text-muted-foreground/70 group-hover:text-muted-foreground",
								)}
							>
								{candidate}
							</span>
							{/* One size for all three: which one is driving is said by the
							    label, not by the number's weight. */}
							<div className="mt-1 whitespace-nowrap font-mono text-[17px] font-semibold tabular-nums leading-none tracking-[-0.02em] text-foreground">
								{formatToolMetric(totals[candidate], "duration")}
							</div>
							<div className="mt-1 h-3 font-mono text-[10px] tabular-nums text-muted-foreground/80">
								{delta === null ? null : <Delta delta={delta} riseIsBad bare />}
							</div>
						</button>
					)
				})}
			</div>

			{/* One spark, for the percentile actually driving the page. Three would
			    be three unreadable 5px-tall charts. */}
			<div className="mt-2 h-7">
				{spark.length > 1 ? (
					<BarSpark values={spark} color={SPARK_COLOR.neutral} className="h-7 w-full" />
				) : null}
			</div>
		</div>
	)
}

/**
 * Change against the previous window.
 *
 * Colour follows *improvement*, not direction — a falling error rate is green —
 * and the arrow keeps pointing the way the number actually moved, so colour is
 * never the only thing carrying the meaning. Same rule and same tokens as the
 * web analytics strip.
 */
function Delta({ delta, riseIsBad, bare }: { delta: number; riseIsBad: boolean; bare?: boolean }) {
	const rose = delta > 0
	const flat = Math.abs(delta) < 0.001
	const good = riseIsBad ? !rose : rose

	return (
		<span
			className={cn(
				!bare && "font-mono text-[10px] tabular-nums",
				flat
					? "text-muted-foreground/70"
					: good
						? "text-[var(--severity-info)]"
						: "text-[var(--severity-error)]",
			)}
			title={`${flat ? "Flat" : rose ? "Up" : "Down"} ${formatPercent(Math.abs(delta))} vs the previous period`}
		>
			<span aria-hidden>{flat ? "→" : rose ? "↑" : "↓"}</span>
			{formatPercent(Math.abs(delta))}
		</span>
	)
}

export function ToolMetricStripLoading() {
	return (
		<StatRail>
			{Array.from({ length: 4 }).map((_, index) => (
				<div key={index} className="px-5 py-4">
					<Skeleton className="h-3 w-16" />
					<div className="mt-3 flex items-end justify-between gap-3">
						<Skeleton className="h-7 w-20" />
						<Skeleton className="h-7 w-24" />
					</div>
					<Skeleton className="mt-3 h-3 w-28" />
				</div>
			))}
		</StatRail>
	)
}
