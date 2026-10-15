import { FilterChip } from "@maple/ui/components/ui/filter-chip"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

export function AnomalyLiveIndicator({
	live,
	onToggle,
}: {
	live: boolean
	onToggle: (live: boolean) => void
}) {
	return (
		<Tooltip>
			<TooltipTrigger render={<FilterChip pressed={live} onPressedChange={onToggle} tone="ok" dot />}>
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
