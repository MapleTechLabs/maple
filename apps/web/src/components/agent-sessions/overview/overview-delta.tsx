import { cn } from "@maple/ui/lib/utils"

import { deltaToneClass, type OverviewDelta } from "@/lib/agent-sessions/overview-analytics"

const ARROW = { up: "↑", down: "↓", flat: "→" } as const

/**
 * How a reading moved: an arrow for the direction, a colour for whether that
 * was good news.
 *
 * Two signals, never one — colour alone is unreadable to a reader who cannot
 * separate the greens from the reds, and an arrow alone cannot say that a
 * falling cache-hit ratio is the bad kind of falling. The sign is dropped from
 * the number because the arrow already carries it, and `↓ -4.9%` says it twice.
 */
export function DeltaReading({ delta, className }: { delta: OverviewDelta | null; className?: string }) {
	if (delta === null) return null
	return (
		<span
			className={cn(
				"flex shrink-0 items-center gap-1 tabular-nums",
				deltaToneClass(delta.tone),
				className,
			)}
			title={`${delta.direction === "flat" ? "Flat" : delta.direction === "up" ? "Up" : "Down"} vs the previous period`}
		>
			<span aria-hidden>{ARROW[delta.direction]}</span>
			{delta.text.replace(/^[+-]/, "")}
		</span>
	)
}
