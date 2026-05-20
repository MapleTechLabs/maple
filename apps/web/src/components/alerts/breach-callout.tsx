import { cn } from "@maple/ui/utils"
import { CheckIcon, CircleInfoIcon, FireIcon } from "@/components/icons"
import { formatBreachDuration, type BreachStats } from "@/lib/alerts/breach-stats"

interface BreachCalloutProps {
	stats: BreachStats
	className?: string
}

/**
 * One-line "would have fired" summary rendered under the live preview chart.
 * Three resting states — empty (no data), healthy (zero breaches), breached
 * (one or more). The numbers come from `computeBreachStats` walking the same
 * `chartData` Recharts renders.
 */
export function BreachCallout({ stats, className }: BreachCalloutProps) {
	if (stats.bucketCount === 0) {
		return (
			<Tile tone="muted" icon={<CircleInfoIcon size={14} />} className={className}>
				<span className="text-muted-foreground">No data in the last 24h to evaluate.</span>
			</Tile>
		)
	}

	if (stats.breachCount === 0) {
		return (
			<Tile tone="ok" icon={<CheckIcon size={14} />} className={className}>
				<span>Would not have fired in the last 24h.</span>
			</Tile>
		)
	}

	return (
		<Tile tone="alert" icon={<FireIcon size={14} />} className={className}>
			<span>
				Would have fired{" "}
				<span className="font-mono font-semibold tabular-nums">{stats.breachCount}</span>{" "}
				{stats.breachCount === 1 ? "time" : "times"} in the last 24h
				{stats.longestRunMs !== null && stats.longestRunBuckets > 1 && (
					<>
						{" "}· longest breach{" "}
						<span className="font-mono font-semibold tabular-nums">
							{formatBreachDuration(stats.longestRunMs)}
						</span>
					</>
				)}
				.
			</span>
		</Tile>
	)
}

function Tile({
	tone,
	icon,
	children,
	className,
}: {
	tone: "ok" | "alert" | "muted"
	icon: React.ReactNode
	children: React.ReactNode
	className?: string
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
				tone === "ok" && "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
				tone === "alert" && "border-destructive/30 bg-destructive/5 text-destructive",
				tone === "muted" && "border-border bg-muted/30",
				className,
			)}
		>
			<span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
			<span className="flex-1">{children}</span>
		</div>
	)
}
