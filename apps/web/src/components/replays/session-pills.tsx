import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { cn } from "@maple/ui/lib/utils"

/** Green "Live" pill with the pulsing ring; `compact` is the dense list-row size. */
export function LivePill({ compact }: { compact?: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-full bg-success/10 font-medium text-success",
				compact ? "gap-1 px-1.5 py-px text-[10px] tracking-wide" : "gap-1.5 px-2 py-0.5 text-xs",
			)}
		>
			<StatusDot tone="success" pulse />
			{compact ? "LIVE" : "Live"}
		</span>
	)
}

export function ErrorCountPill({ count }: { count: number }) {
	return (
		<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-destructive">
			<StatusDot tone="error" size="sm" />
			{count} error{count === 1 ? "" : "s"}
		</span>
	)
}
