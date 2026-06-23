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
					? "border-success/30 bg-success/10 text-success"
					: "border-border/70 text-muted-foreground hover:text-foreground",
			)}
		>
			<span className="relative inline-flex size-1.5">
				{live ? (
					<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
				) : null}
				<span
					className={cn(
						"relative inline-flex size-full rounded-full",
						live ? "bg-success" : "bg-muted-foreground/50",
					)}
				/>
			</span>
			{live ? "Live" : "Paused"}
		</button>
	)
}
