/**
 * What the pass is doing, while it is doing it.
 *
 * The page used to answer this with one sentence that never changed: "Maple is
 * gathering evidence", for however long the run took, on every investigation. A
 * reader could see that something was running and for how long, and nothing at
 * all about what. The steps existed, in the agent's event stream, behind the
 * Transcript tab, and only while the tab stayed open.
 *
 * It renders after the run too, on a pass that failed. That is the case the feed
 * is worth the most in: the diagnosis is missing, and how far it got before it
 * stopped is the only evidence left about why.
 */
import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"

import { useTickingNow } from "@/hooks/use-ticking-now"

/**
 * After this long without a step, a running pass is described as waiting rather
 * than working.
 *
 * Generously above the writer's 8s heartbeat. The gap between steps is a model
 * call, which can legitimately run tens of seconds, so this is set where silence
 * stops being ordinary rather than where it starts.
 */
const STALL_MS = 90_000

/**
 * A silence, in whole minutes.
 *
 * Not `splitDuration`, whose minute form is a clock face ("2:05" + "min"). That
 * is right for a stat tile counting up beside a label and wrong inside a
 * sentence, where the reader wants a rounded quantity rather than a stopwatch.
 */
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
	// Only while running, and only when there is a clock to run against: the hook
	// is the sanctioned timer exception, and a finished pass has nothing ticking.
	const now = useTickingNow(running && progress !== null)
	const silentFor = progress === null ? 0 : Math.max(0, now - progress.updatedAt)
	const stalled = running && silentFor > STALL_MS

	// The newest step at the bottom, which is where a reader watching one arrive
	// is already looking.
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
							{/*
							 * The pulse is a claim that something is happening right now, so
							 * a stalled run goes still. Leaving it animating over "no step
							 * for 4 minutes" is the card contradicting its own header.
							 */}
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

/**
 * The count, and whether the run is still moving.
 *
 * `stepCount` rather than `steps.length`: the feed is a capped tail, and a run
 * that took forty steps saying "12 steps" is a worse answer than no count.
 */
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
					{/*
					 * Named rather than hidden. A run whose last step is two minutes old
					 * looks identical to one working normally, and a reader deciding
					 * whether to wait or restart has no other signal to go on.
					 */}
					<span className="text-severity-warn normal-case tracking-normal">
						no step for {silenceLabel(silentFor)}
					</span>
				</>
			) : null}
		</div>
	)
}

/**
 * The gap between a pass starting and its first tool call.
 *
 * Short, usually. It still needs to say something, because the alternative is the
 * page going blank for the first few seconds of every investigation a reader
 * opens from the moment it was created.
 */
function AwaitingFirstStep({ className }: { className?: string }) {
	return (
		<div className={cn("flex items-center gap-2.5 text-xs text-muted-foreground", className)}>
			<span aria-hidden className="size-1 shrink-0 animate-pulse rounded-full bg-primary" />
			Starting the pass
		</div>
	)
}
