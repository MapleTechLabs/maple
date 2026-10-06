import { Badge } from "@maple/ui/components/ui/badge"

import { MAPLE_REGION_LABELS, type MapleRegion } from "@/lib/region"

/** A compact `US` / `EU` tag naming where an organization's data lives. */
export function RegionBadge({ region, className }: { region: MapleRegion; className?: string }) {
	const label = MAPLE_REGION_LABELS[region]
	return (
		<Badge
			variant="meta"
			size="xs"
			mono
			title={`Data region: ${label.name}`}
			className={className}
		>
			{label.short}
		</Badge>
	)
}
