import { Badge } from "@maple/ui/components/ui/badge"
import { StatusDot } from "@maple/ui/components/ui/status-dot"

/** Green "Live" pill with the pulsing ring; `compact` is the dense list-row size. */
export function LivePill({ compact }: { compact?: boolean }) {
	return (
		<Badge
			variant="ok"
			pill
			size={compact ? "xs" : "default"}
			className={compact ? "tracking-wide" : "gap-1.5"}
		>
			<StatusDot tone="ok" pulse />
			{compact ? "LIVE" : "Live"}
		</Badge>
	)
}

export function ErrorCountPill({ count }: { count: number }) {
	return (
		<Badge
			pill
			size="xs"
			mono
			className="gap-1.5 border-severity-error/30 bg-severity-error/10 text-severity-error"
		>
			<StatusDot tone="crit" size="sm" />
			{count} error{count === 1 ? "" : "s"}
		</Badge>
	)
}
