import { sessionIdentity } from "./session-detail/session-header"

/**
 * What a session is called wherever it is listed: the agent it ran, or the
 * framework where no agent was named.
 *
 * `agentName` is ONE name the warehouse resolved in span order, never an
 * unordered set — `sessionIdentity` reads the first name it is handed.
 */
export const sessionHeading = (agentName: string, vendorId: string): string =>
	sessionIdentity({ agentNames: agentName === "" ? [] : [agentName], vendorIds: [vendorId] })
