import { formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import {
	OVERVIEW_MOVER_MIN_SESSIONS,
	deltaToneClass,
	type OverviewCoverage,
	type OverviewMover,
} from "@/lib/agent-sessions/overview-analytics"

export interface OverviewMoversRailProps {
	movers: ReadonlyArray<OverviewMover>
	coverage: OverviewCoverage
	/** Names the window the moves are measured against, e.g. `7d`. */
	windowLabel: string
	/** Applies that mover's dimension filter to the whole board. */
	onSelect: (mover: OverviewMover) => void
}

/**
 * What changed, ranked across every dimension at once.
 *
 * One line per key rather than per metric, and a magnitude bar measured against
 * the worst move on the rail — the rail answers "where do I look first", which
 * is an ordering question and not a measurement.
 */
export function OverviewMoversRail({
	movers,
	coverage,
	windowLabel,
	onSelect,
}: OverviewMoversRailProps) {
	const worst = movers.reduce((max, mover) => Math.max(max, mover.score), 0)
	return (
		<aside className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground/80">
					What changed
				</h3>
				<span className="font-mono text-[11px] text-muted-foreground/70">
					vs prev {windowLabel}
				</span>
			</div>

			{movers.length === 0 ? (
				<p className="font-mono text-[11.5px] text-muted-foreground/70">
					Nothing moved enough to rank.
				</p>
			) : (
				<ol className="flex flex-col">
					{movers.map((mover, index) => (
						<li key={`${mover.dimension}:${mover.key}`}>
							<button
								type="button"
								onClick={() => onSelect(mover)}
								className="flex w-full flex-col gap-1 border-b border-border/70 py-2 text-left transition-colors hover:bg-accent/40"
							>
								<span className="flex items-baseline gap-2">
									<span className="font-mono text-[11px] tabular-nums text-muted-foreground/60">
										{String(index + 1).padStart(2, "0")}
									</span>
									<span className="font-mono text-[11px] text-muted-foreground">
										{mover.dimension}
									</span>
									<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
										{mover.label}
									</span>
								</span>
								<span className="flex items-baseline gap-2 pl-6 font-mono text-[11px] tabular-nums">
									<span className="text-muted-foreground">{mover.metricLabel}</span>
									<span className="text-muted-foreground/80">
										{mover.before} → {mover.after}
									</span>
									<span className={cn("ml-auto", deltaToneClass(mover.tone))}>
										{mover.deltaText}
									</span>
								</span>
								<span
									aria-hidden
									className="ml-6 h-[3px] rounded-full bg-muted"
									style={{ width: `${worst === 0 ? 0 : (mover.score / worst) * 100}%` }}
								/>
							</button>
						</li>
					))}
				</ol>
			)}

			<p className="font-mono text-[10.5px] leading-[15px] text-muted-foreground/60">
				Ranked by deviation; groups under {OVERVIEW_MOVER_MIN_SESSIONS} sessions excluded.
			</p>

			<div className="flex items-baseline justify-between gap-3 border-t border-border pt-3">
				<span className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground/80">
					Coverage
				</span>
			</div>
			<div className="flex items-baseline justify-between gap-3 font-mono text-[11.5px]">
				<span className="text-muted-foreground">{coverage.label}</span>
				<span className="tabular-nums text-foreground">{formatPercent(coverage.share)}</span>
			</div>
		</aside>
	)
}
