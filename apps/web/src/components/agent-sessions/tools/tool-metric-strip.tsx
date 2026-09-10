import { cn } from "@maple/ui/lib/utils"
import { formatPercent } from "@maple/ui/lib/format"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { BarSpark } from "@/components/infra/primitives/stat-rail"
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
	/** Picking a percentile column also takes the chart — see `DurationTile`. */
	onSelectPercentile: (percentile: ToolPercentile) => void
	/** Names the comparison, e.g. "24h". */
	windowLabel: string
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
 * The fourth is wider than the others: a duration has three readings, and the
 * question "is the tail getting worse while the median holds?" is the one this
 * page is most often opened for. Collapsing that to a single percentile behind
 * a dropdown would hide the comparison; three tiles would spend three quarters
 * of the strip on one metric. So the tile carries all three side by side, each
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
	const tile = (key: Exclude<ToolMetric, "duration">, eyebrow: string) => {
		const selected = metric === key
		const delta = metricDelta(totals, previous, key, percentile)
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
					{delta === null ? null : (
						<>
							<Delta delta={delta} riseIsBad={metricRiseIsBad(key)} />
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
 * Duration, folded to the driving percentile until it is asked about.
 *
 * Collapsed it is one tile among four: the P90 (or whichever is driving), a
 * spark and a delta, at the size and weight the other three use. Clicking it
 * takes the chart AND opens the three readings — P50 | P90 | P95 side by side,
 * each with its own delta, each a click to re-key the page — because "is the
 * tail getting worse while the median holds?" is the question this page is
 * most often opened for, and it is only worth the width while it is being
 * asked. The tile widens as it opens; that is the reveal, not a shift.
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
	const eyebrow = (
		<span className="flex items-baseline gap-2">
			<span className={cn(EYEBROW, selected ? "text-primary" : "text-muted-foreground/80")}>
				Duration
			</span>
			{/* Which reading the number is, while it is the only one shown. */}
			{selected ? null : (
				<span className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground/60">
					{percentile}
				</span>
			)}
		</span>
	)

	if (!selected) {
		const delta = metricDelta(totals, previous, "duration", percentile)
		return (
			<button
				type="button"
				aria-pressed={false}
				onClick={() => onSelectMetric("duration")}
				className={cn(TILE, TILE_IDLE)}
			>
				{eyebrow}
				<span className="flex items-end justify-between gap-3">
					<Value selected={false}>{formatToolMetric(totals[percentile], "duration")}</Value>
					<Spark values={spark} />
				</span>
				<span className="flex h-3.5 items-center gap-[5px] font-mono text-[11.5px] tabular-nums">
					{delta === null ? null : (
						<>
							<Delta delta={delta} riseIsBad />
							<span className="text-muted-foreground/60">vs prev {windowLabel}</span>
						</>
					)}
				</span>
			</button>
		)
	}

	return (
		<div className={cn(TILE, TILE_SELECTED, "grow-[1.85] pr-6")}>
			<span className="flex h-5 items-center gap-2">
				{eyebrow}
				{/* One comparison for all three columns, stated once. */}
				<span className="font-mono text-[10.5px] leading-3.5 tracking-[0.02em] text-muted-foreground/50">
					vs prev {windowLabel}
				</span>
			</span>

			<span className="flex items-start gap-5">
				<span className="flex min-w-0 grow">
					{TOOL_PERCENTILES.map((candidate) => {
						const driving = candidate === percentile
						const delta = metricDelta(totals, previous, "duration", candidate)
						return (
							<button
								key={candidate}
								type="button"
								aria-pressed={driving}
								onClick={() => onSelectPercentile(candidate)}
								className="group flex min-w-0 flex-1 flex-col items-start gap-[7px] text-left focus-visible:outline-none"
							>
								<span
									className={cn(
										"flex items-baseline gap-1.5 border-b pt-1.5 pb-px transition-colors",
										driving ? "border-border" : "border-transparent",
									)}
								>
									<span
										className={cn(
											"font-mono text-[10.5px] uppercase leading-3.5 tracking-[0.04em] transition-colors",
											driving
												? "text-muted-foreground"
												: "text-muted-foreground/60 group-hover:text-muted-foreground",
										)}
									>
										{candidate}
									</span>
									{/* One size for all three: which one is driving is said by the
									    label, not by the number's weight. */}
									<span
										className={cn(
											"whitespace-nowrap text-[19px] font-semibold leading-5 tracking-[-0.015em] tabular-nums",
											driving ? "text-foreground" : "text-foreground/75",
										)}
									>
										{formatToolMetric(totals[candidate], "duration")}
									</span>
								</span>
								<span className="flex h-3.5 items-center font-mono text-[11.5px] tabular-nums">
									{delta === null ? null : <Delta delta={delta} riseIsBad />}
								</span>
							</button>
						)
					})}
				</span>
				{/* One spark, for the percentile actually driving the page. Three would
				    be three unreadable 5px-tall charts. */}
				<Spark values={spark} />
			</span>
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
function Delta({ delta, riseIsBad }: { delta: number; riseIsBad: boolean }) {
	const rose = delta > 0
	const flat = Math.abs(delta) < 0.001
	const good = riseIsBad ? !rose : rose

	return (
		<span
			className={cn(
				"inline-flex items-center gap-[5px]",
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
