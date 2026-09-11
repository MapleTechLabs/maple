import { cn } from "@maple/ui/lib/utils"

import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"
import { sessionIdentity } from "./session-detail/session-header"

/**
 * A session by what it is rather than what it is keyed by: the framework's mark
 * beside the agent it ran, or the framework where no agent was named. Shared so
 * every surface that names a session calls it what the Sessions list does.
 *
 * `agentName` is ONE name the warehouse resolved in span order, never an
 * unordered set — `sessionIdentity` reads the first name it is handed.
 */
export function SessionName({
	agentName,
	vendorId,
	iconSize = 15,
	className,
}: {
	agentName: string
	vendorId: string
	iconSize?: number
	className?: string
}) {
	const VendorIcon = vendorIcon(vendorId)
	const { heading } = sessionIdentity({
		agentNames: agentName === "" ? [] : [agentName],
		vendorIds: [vendorId],
	})
	return (
		<span className={cn("flex min-w-0 items-center gap-2", className)}>
			<span className="flex shrink-0 items-center text-muted-foreground" title={vendorLabel(vendorId)}>
				<VendorIcon size={iconSize} aria-hidden />
			</span>
			<span className="min-w-0 truncate" title={heading}>
				{heading}
			</span>
		</span>
	)
}
