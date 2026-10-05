import { Badge } from "@maple/ui/components/ui/badge"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { cn } from "@maple/ui/lib/utils"

/** Green "Live" pill with the pulsing ring; `compact` is the dense list-row size. */
export function LivePill({ compact }: { compact?: boolean }) {
	return (
		<Badge
			variant="success"
			shape="pill"
			size={compact ? "xs" : "default"}
			className={cn("bg-success/10 text-success", compact ? "tracking-wide" : "gap-1.5")}
		>
			<StatusDot tone="success" pulse />
			{compact ? "LIVE" : "Live"}
		</Badge>
	)
}

export function ErrorCountPill({ count }: { count: number }) {
	return (
		<Badge
			shape="pill"
			size="xs"
			mono
			className="gap-1.5 border-destructive/30 bg-destructive/10 text-destructive"
		>
			<StatusDot tone="error" size="sm" />
			{count} error{count === 1 ? "" : "s"}
		</Badge>
	)
}
