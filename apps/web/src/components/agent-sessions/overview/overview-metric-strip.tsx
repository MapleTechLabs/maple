import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import type { OverviewTile } from "@/lib/agent-sessions/overview-analytics"

import { DeltaReading } from "./overview-delta"

export interface OverviewMetricStripProps {
	tiles: ReadonlyArray<OverviewTile>
	waiting?: boolean
}

/**
 * Seven tiles, hairline-divided, in one band.
 *
 * `gap-px` over a border-coloured ground rather than `divide-x`: the strip
 * folds to four columns and then to two, and a divide rule would leave a stray
 * hairline at the page's own edge on every wrapped row. The last tile spans two
 * columns where seven does not divide, so the ground never shows through as a
 * missing tile.
 */
const STRIP = cn(
	"grid grid-cols-2 gap-px border-b border-border bg-border",
	"@min-[900px]/page:grid-cols-4 @min-[1200px]/page:grid-cols-7",
	"[&>*:last-child]:col-span-2 @min-[1200px]/page:[&>*:last-child]:col-span-1",
)

/**
 * Seven readings of the window, left to right, and not a selector: nothing
 * below the strip changes when one is read. The grid underneath already draws
 * all nine series at once, so a tile that took over a chart would be a step
 * backwards from what is already on screen.
 */
export function OverviewMetricStrip({ tiles, waiting = false }: OverviewMetricStripProps) {
	return (
		<div className={cn(STRIP, "transition-opacity", waiting && "opacity-60")}>
			{tiles.map((tile) => (
				<div
					key={tile.id}
					className="flex min-w-0 flex-col gap-[7px] bg-background py-[15px] pr-3.5 pl-6"
				>
					<span className="truncate font-mono text-[10.5px] leading-[14px] tracking-[0.09em] text-muted-foreground uppercase">
						{tile.label}
					</span>
					<span className="flex items-baseline gap-1.5">
						<span className="truncate text-[24px] leading-[26px] font-semibold tracking-[-0.02em] text-foreground tabular-nums">
							{tile.value}
						</span>
						{tile.unit === undefined ? null : (
							<span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
								{tile.unit}
							</span>
						)}
					</span>
					<span className="flex items-center gap-1.5 font-mono text-[11.5px] leading-[14px] tabular-nums">
						<DeltaReading delta={tile.delta} />
						<span className="truncate text-muted-foreground/70">{tile.sub}</span>
					</span>
				</div>
			))}
		</div>
	)
}

/** The strip's shape while the summary read is in flight. */
export function OverviewMetricStripLoading() {
	return (
		<div className={STRIP}>
			{Array.from({ length: 7 }).map((_, index) => (
				<div key={index} className="flex flex-col gap-[7px] bg-background py-[15px] pr-3.5 pl-6">
					<Skeleton className="h-2.5 w-16" />
					<Skeleton className="h-5 w-20" />
					<Skeleton className="h-2.5 w-24" />
				</div>
			))}
		</div>
	)
}
