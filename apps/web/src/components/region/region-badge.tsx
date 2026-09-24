import { cn } from "@maple/ui/lib/utils"

import { MAPLE_REGION_LABELS, type MapleRegion } from "@/lib/region"

/** A compact `US` / `EU` tag naming where an organization's data lives. */
export function RegionBadge({ region, className }: { region: MapleRegion; className?: string }) {
	const label = MAPLE_REGION_LABELS[region]
	return (
		<span
			title={`Data region: ${label.name}`}
			className={cn(
				"inline-flex h-4 shrink-0 items-center rounded-sm border border-border px-1 font-mono text-[10px] font-medium leading-none text-muted-foreground",
				className,
			)}
		>
			{label.short}
		</span>
	)
}
