import { vendorLabel } from "./vendor"

// A session's identity and heading.

/** The name instrumentation writes when nothing named the agent. */
const PLACEHOLDER_AGENT_NAME = "default"

/** What a session is called: the agent it ran, else the framework, else "Agent session". */
export const sessionIdentity = (summary: {
	readonly agentNames: ReadonlyArray<string>
	readonly vendorIds: ReadonlyArray<string>
}): string => {
	const vendorId = summary.vendorIds[0]
	const framework = vendorId === undefined ? undefined : vendorLabel(vendorId)
	const agentName = summary.agentNames.find((name) => name !== PLACEHOLDER_AGENT_NAME)
	if (agentName !== undefined) return agentName
	if (framework !== undefined && framework !== "Unidentified") return `${framework} session`
	return "Agent session"
}

/** A listed session's heading, from the one agent name the warehouse resolved in span order. */
export const sessionHeading = (agentName: string, vendorId: string): string =>
	sessionIdentity({ agentNames: agentName === "" ? [] : [agentName], vendorIds: [vendorId] })
