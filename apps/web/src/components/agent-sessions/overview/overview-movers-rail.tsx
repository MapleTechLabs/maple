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
	/** Off means there is no previous window to rank against — `movers` is empty
	 *  then, and the rail says why rather than reading as "nothing moved". */
	compare: boolean
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
 * is an ordering question and not a measurement. The bar stays grey for the
 * same reason: the ranking is the bar's whole message, and the delta beside it
 * already says whether the move was bad news.
 */
export function OverviewMoversRail({
	movers,
	coverage,
	compare,
	windowLabel,
	onSelect,
}: OverviewMoversRailProps) {
	const worst = movers.reduce((max, mover) => Math.max(max, mover.score), 0)
	return (
		<aside className="flex flex-col">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="font-mono text-[12.5px] leading-4 font-medium text-foreground">
					What changed
				</h3>
				{compare ? (
					<span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
						vs prev {windowLabel}
					</span>
				) : null}
			</div>

			{!compare ? (
				<p className="pt-1.5 font-mono text-[11.5px] leading-[15px] text-muted-foreground/70">
					Turn on compare to rank what changed.
				</p>
			) : (
				<MoverLines movers={movers} worst={worst} onSelect={onSelect} />
			)}

			<div className="mt-3 flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-[11px]">
				<span className="font-mono text-[10.5px] leading-[14px] tracking-[0.09em] text-muted-foreground uppercase">
					Coverage
				</span>
				<span className="flex items-baseline justify-between gap-2 font-mono text-[10.5px] leading-[15px]">
					<span className="truncate text-muted-foreground/70">{coverage.label}</span>
					<span className="shrink-0 tabular-nums text-foreground">
						{formatPercent(coverage.share)}
					</span>
				</span>
				<span className="font-mono text-[10.5px] leading-[15px] text-muted-foreground/70">
					Cost is a floor, not a total.
				</span>
			</div>
		</aside>
	)
}

/** The ranked lines themselves, and what the rail says when nothing ranks. */
function MoverLines({
	movers,
	worst,
	onSelect,
}: {
	movers: ReadonlyArray<OverviewMover>
	worst: number
	onSelect: (mover: OverviewMover) => void
}) {
	return (
		<>
			<p className="pt-1.5 font-mono text-[10.5px] leading-[15px] text-muted-foreground/70">
				Biggest movers across every breakdown. Click a line to filter the page.
			</p>

			{movers.length === 0 ? (
				<p className="pt-3 font-mono text-[11.5px] text-muted-foreground/70">
					Nothing moved enough to rank.
				</p>
			) : (
				<ol className="flex flex-col pt-3">
					{movers.map((mover, index) => (
						<li key={`${mover.dimension}:${mover.key}`}>
							<button
								type="button"
								onClick={() => onSelect(mover)}
								className="flex w-full flex-col gap-[5px] border-t border-border pt-2.5 pb-[11px] text-left transition-colors hover:bg-accent/40"
							>
								<span className="flex items-center gap-[7px]">
									<span className="w-[14px] shrink-0 font-mono text-[10.5px] leading-[14px] tabular-nums text-muted-foreground/50">
										{String(index + 1).padStart(2, "0")}
									</span>
									<span className="shrink-0 font-mono text-[10.5px] leading-[14px] text-muted-foreground/70">
										{mover.dimension}
									</span>
									<span className="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-[14px] text-foreground">
										{mover.label}
									</span>
									<span
										className={cn(
											"shrink-0 font-mono text-[11.5px] leading-[14px] tabular-nums",
											deltaToneClass(mover.tone),
										)}
									>
										{mover.deltaText}
									</span>
								</span>
								<span className="flex items-center justify-between gap-2 pl-[21px]">
									<span className="truncate font-mono text-[10.5px] leading-[14px] text-muted-foreground/70">
										{mover.metricLabel}
									</span>
									<span className="shrink-0 font-mono text-[10.5px] leading-[14px] tabular-nums text-muted-foreground">
										{mover.before} → {mover.after}
									</span>
								</span>
								<span aria-hidden className="ml-[21px] h-[3px] rounded-[2px] bg-muted">
									<span
										className="block h-full rounded-[2px] bg-muted-foreground/50"
										style={{ width: `${worst === 0 ? 0 : (mover.score / worst) * 100}%` }}
									/>
								</span>
							</button>
						</li>
					))}
				</ol>
			)}

			<p className="pt-3 font-mono text-[10.5px] leading-[15px] text-muted-foreground/70">
				Ranked by deviation; groups under {OVERVIEW_MOVER_MIN_SESSIONS} sessions in either window are
				excluded.
			</p>
		</>
	)
}
