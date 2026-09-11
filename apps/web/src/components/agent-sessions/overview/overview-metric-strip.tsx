import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { deltaToneClass, type OverviewTile } from "@/lib/agent-sessions/overview-analytics"

export interface OverviewMetricStripProps {
	tiles: ReadonlyArray<OverviewTile>
	waiting?: boolean
}

/**
 * Seven readings of the window, left to right, and not a selector: nothing
 * below the strip changes when one is read. The grid underneath already draws
 * all nine series at once, so a tile that took over a chart would be a step
 * backwards from what is already on screen.
 */
export function OverviewMetricStrip({ tiles, waiting = false }: OverviewMetricStripProps) {
	return (
		<div
			className={cn(
				"grid grid-cols-2 gap-px border-b border-border bg-border @min-[900px]/page:grid-cols-4 @min-[1200px]/page:grid-cols-7",
				waiting && "opacity-60",
			)}
		>
			{tiles.map((tile) => (
				<div key={tile.id} className="flex flex-col gap-1 bg-background px-6 py-3.5">
					<span className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground/80">
						{tile.label}
					</span>
					<span className="flex items-baseline gap-1">
						<span className="text-[19px] font-semibold leading-6 tracking-[-0.01em] tabular-nums text-foreground">
							{tile.value}
						</span>
						{tile.unit === undefined ? null : (
							<span className="font-mono text-[11px] text-muted-foreground">{tile.unit}</span>
						)}
					</span>
					<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
						{tile.delta === null ? null : (
							<span className={cn("mr-1.5", deltaToneClass(tile.delta.tone))}>
								{tile.delta.text}
							</span>
						)}
						{tile.sub}
					</span>
				</div>
			))}
		</div>
	)
}

/** The strip's shape while the summary read is in flight. */
export function OverviewMetricStripLoading() {
	return (
		<div className="grid grid-cols-2 gap-px border-b border-border bg-border @min-[900px]/page:grid-cols-4 @min-[1200px]/page:grid-cols-7">
			{Array.from({ length: 7 }).map((_, index) => (
				<div key={index} className="flex flex-col gap-2 bg-background px-6 py-3.5">
					<Skeleton className="h-2.5 w-16" />
					<Skeleton className="h-5 w-20" />
					<Skeleton className="h-2.5 w-24" />
				</div>
			))}
		</div>
	)
}
