import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
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
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						role="switch"
						aria-checked={live}
						onClick={() => onToggle(!live)}
						className={cn(
							"inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
							live
								? cn(TONE_BORDER.ok, TONE_SOFT.ok)
								: "border-border/70 text-muted-foreground hover:text-foreground",
						)}
					/>
				}
			>
				<StatusDot tone={live ? "ok" : "neutral"} />
				{live ? "Live" : "Paused"}
			</TooltipTrigger>
			<TooltipContent>
				{live
					? "Auto-refreshing every 15s. Click to pause."
					: "Paused. Click to resume auto-refresh."}
			</TooltipContent>
		</Tooltip>
	)
}
