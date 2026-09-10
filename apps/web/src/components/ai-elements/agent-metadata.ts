import { CompassIcon, FaceRobotIcon, MagnifierIcon, ShieldIcon } from "@/components/icons"
import type { IconComponent } from "@/components/icons"

/**
 * How a sub-agent presents itself: a name, what it is doing while it runs, and a glyph.
 *
 * The registry it mirrors lives server-side (`apps/api/src/chat/agents.ts`) and is not on the
 * wire — a delegation announces the agent's id and nothing else. So this is a display map with a
 * humanized fallback, the same shape `tool-metadata.ts` uses for tools: an agent added on the
 * server renders sensibly here before anyone touches this file.
 */
interface AgentPresentation {
	readonly label: string
	/** Present participle, for the live row. Reads as what is happening, not as a status. */
	readonly activity: string
	readonly icon: IconComponent
}

const AGENTS: Record<string, AgentPresentation> = {
	explore: { label: "Explore", activity: "Exploring", icon: MagnifierIcon },
	"investigation-planner": { label: "Planner", activity: "Planning", icon: CompassIcon },
	"investigation-validator": { label: "Validator", activity: "Validating", icon: ShieldIcon },
}

/** `hypothesis-<id>` lanes are written per run, so they are matched by prefix, not by entry. */
const HYPOTHESIS_PREFIX = "hypothesis-"

const humanize = (agent: string): string =>
	agent
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ")

export function agentPresentation(agent: string): AgentPresentation {
	const known = AGENTS[agent]
	if (known) return known
	if (agent.startsWith(HYPOTHESIS_PREFIX)) {
		return { label: "Hypothesis", activity: "Testing", icon: CompassIcon }
	}
	return { label: humanize(agent), activity: "Working", icon: FaceRobotIcon }
}
