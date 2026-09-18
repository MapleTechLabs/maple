/**
 * The running pass's step feed. It also renders on a failed pass, where how far the run got
 * is the only account that outlives the agent's event stream.
 */
import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"

import { useTickingNow } from "@/hooks/use-ticking-now"

/** Silence past this is named as a stall. Well above the 8s heartbeat: a model call between steps can take tens of seconds. */
const STALL_MS = 90_000

/** A silence in whole minutes, for a sentence; `splitDuration` is a stopwatch face for stat tiles. */
const silenceLabel = (ms: number): string => {
	const minutes = Math.floor(ms / 60_000)
	return minutes < 1 ? "under a minute" : minutes === 1 ? "a minute" : `${minutes} minutes`
}

export function RunProgress({
	investigation,
	className,
}: {
	investigation: V2Investigation
	className?: string
}) {
	const progress = investigation.progress
	const running = investigation.status === "investigating"
	// Only while running: a finished pass has nothing ticking.
	const now = useTickingNow(running && progress !== null)
	const silentFor = progress === null ? 0 : Math.max(0, now - progress.updatedAt)
	const stalled = running && silentFor > STALL_MS

	const steps = progress?.steps ?? []
	if (steps.length === 0) return running ? <AwaitingFirstStep className={className} /> : null

	return (
		<div className={cn("flex flex-col gap-2.5", className)}>
			<Header count={progress?.stepCount ?? 0} stalled={stalled} silentFor={silentFor} />
			<ol className="flex flex-col">
				{steps.map((step, index) => {
					const last = index === steps.length - 1
					return (
						<li
							key={`${step.at}-${step.tool}-${index}`}
							className="flex items-baseline gap-2.5 py-[3px] text-xs"
						>
							{/* The pulse claims something is happening now, so a stalled run goes still. */}
							<span
								aria-hidden
								className={cn(
									"size-1 shrink-0 translate-y-[-2px] rounded-full",
									last && running && !stalled
										? "animate-pulse bg-primary"
										: last && stalled
											? "bg-severity-warn"
											: "bg-muted-foreground/35",
								)}
							/>
							<span
								className={cn(
									"min-w-0 flex-1 truncate",
									last && running ? "text-foreground" : "text-muted-foreground",
								)}
								title={step.label}
							>
								{step.label}
							</span>
						</li>
					)
				})}
			</ol>
		</div>
	)
}

/** The count (`stepCount`, since `steps` is a capped tail) and whether the run is still moving. */
function Header({ count, stalled, silentFor }: { count: number; stalled: boolean; silentFor: number }) {
	return (
		<div className="flex items-baseline gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
			<span>
				{count} {count === 1 ? "step" : "steps"}
			</span>
			{stalled ? (
				<>
					<span aria-hidden className="text-muted-foreground/40">
						·
					</span>
					<span className="text-severity-warn normal-case tracking-normal">
						no step for {silenceLabel(silentFor)}
					</span>
				</>
			) : null}
		</div>
	)
}

/** The gap between a pass starting and its first tool call. */
function AwaitingFirstStep({ className }: { className?: string }) {
	return (
		<div className={cn("flex items-center gap-2.5 text-xs text-muted-foreground", className)}>
			<span aria-hidden className="size-1 shrink-0 animate-pulse rounded-full bg-primary" />
			Starting the pass
		</div>
	)
}
