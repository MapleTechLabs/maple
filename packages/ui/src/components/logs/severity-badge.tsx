import { Badge } from "../ui/badge"
import { cn } from "../../lib/utils"
import { getSeverityColor } from "../../lib/severity"

const SEVERITY_NUMBER_LABELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const

/**
 * The severity to show for a log: its text, else the OTel range its number falls
 * in (1-4 TRACE ... 21-24 FATAL), else "UNSET".
 */
export function severityLabel(severityText: string, severityNumber?: number): string {
	if (severityText.trim() !== "") return severityText
	if (severityNumber !== undefined && severityNumber >= 1 && severityNumber <= 24) {
		return SEVERITY_NUMBER_LABELS[Math.floor((severityNumber - 1) / 4)] ?? "UNSET"
	}
	return "UNSET"
}

interface SeverityBadgeProps {
	severity: string
	/** OTel severity number, used for the label when `severity` is empty. */
	severityNumber?: number
	className?: string
}

export function SeverityBadge({ severity, severityNumber, className }: SeverityBadgeProps) {
	const label = severityLabel(severity, severityNumber)
	const color = getSeverityColor(label)

	return (
		<Badge
			variant="secondary"
			className={cn("font-mono text-3xs uppercase", className)}
			style={{
				color,
				backgroundColor: `color-mix(in oklch, ${color} 10%, transparent)`,
			}}
		>
			{label}
		</Badge>
	)
}
