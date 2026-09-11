import { cn } from "@maple/ui/lib/utils"

import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"
import { sessionIdentity } from "./session-detail/session-header"

/**
 * What a session is called wherever it is listed: the agent it ran, or the
 * framework where no agent was named.
 *
 * `agentName` is ONE name the warehouse resolved in span order, never an
 * unordered set — `sessionIdentity` reads the first name it is handed.
 */
export const sessionHeading = (agentName: string, vendorId: string): string =>
	sessionIdentity({ agentNames: agentName === "" ? [] : [agentName], vendorIds: [vendorId] }).heading

/**
 * A session by what it is rather than what it is keyed by: the framework's mark
 * beside {@link sessionHeading}. For surfaces that name a session in a line of
 * their own; the Sessions list builds its cell from the heading alone.
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
	const heading = sessionHeading(agentName, vendorId)
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
