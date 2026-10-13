import type { AlertSeverity } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { TONE_BORDER, TONE_SOFT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

const toneBySeverity: Record<AlertSeverity, Tone> = {
	warning: "warn",
	critical: "crit",
} satisfies Record<AlertSeverity, Tone>

const labelBySeverity: Record<AlertSeverity, string> = {
	warning: "Warning",
	critical: "Critical",
} satisfies Record<AlertSeverity, string>

export function AlertSeverityBadge({ severity, className }: { severity: AlertSeverity; className?: string }) {
	return (
		<Badge variant="outline" className={cn(TONE_BORDER[toneBySeverity[severity]], TONE_SOFT[toneBySeverity[severity]], className)}>
			{labelBySeverity[severity]}
		</Badge>
	)
}
