import { Badge } from "../ui/badge"
import { cn } from "../../lib/utils"
import { getSeverityColor } from "../../lib/severity"

interface SeverityBadgeProps {
	severity: string
	className?: string
}

export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
	const color = getSeverityColor(severity)

	return (
		<Badge
			variant="secondary"
			className={cn("font-mono text-[10px] uppercase", className)}
			style={{
				color,
				backgroundColor: `color-mix(in oklch, ${color} 10%, transparent)`,
			}}
		>
			{severity}
		</Badge>
	)
}
