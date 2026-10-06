import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { TONE_BORDER, TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

export function AnomalyLiveIndicator({
	live,
	onToggle,
}: {
	live: boolean
	onToggle: (live: boolean) => void
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={live}
			onClick={() => onToggle(!live)}
			title={
				live ? "Auto-refreshing every 15s — click to pause" : "Paused — click to resume auto-refresh"
			}
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
				live
					? cn(TONE_BORDER.ok, TONE_SOFT.ok)
					: "border-border/70 text-muted-foreground hover:text-foreground",
			)}
		>
			<StatusDot tone={live ? "ok" : "neutral"} pulse={live} />
			{live ? "Live" : "Paused"}
		</button>
	)
}
