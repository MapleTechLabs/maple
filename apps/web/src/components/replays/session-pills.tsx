import { Badge } from "@maple/ui/components/ui/badge"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { countLabel } from "@maple/ui/lib/format"
import { TONE_BORDER, TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

/** Green "Live" pill with a static dot; `compact` is the dense list-row size. */
export function LivePill({ compact }: { compact?: boolean }) {
	return (
		<Badge
			variant="ok"
			pill
			size={compact ? "xs" : "default"}
			className={compact ? "tracking-wide" : "gap-1.5"}
		>
			<StatusDot tone="ok" />
			{compact ? "LIVE" : "Live"}
		</Badge>
	)
}

export function ErrorCountPill({ count }: { count: number }) {
	return (
		<Badge pill size="xs" mono className={cn("gap-1.5", TONE_SOFT.crit, TONE_BORDER.crit)}>
			<StatusDot tone="crit" size="sm" />
			{countLabel(count, "error")}
		</Badge>
	)
}
