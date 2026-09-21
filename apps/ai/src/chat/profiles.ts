/**
 * What a turn's origin decides, in one table.
 *
 * The mode says what a conversation is; the origin says who is driving this turn. This is the only
 * reader of the second — every consumer takes the resolved profile — so a turn cannot run on one
 * surface and be billed, traced or prompted as another.
 */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import type { PermissionRuleset } from "@maple/domain/permission"
import type { AgentDefinition } from "./agents"
import { READ_ONLY_RULESET } from "./permissions"
import { CONNECTOR_SYSTEM_PROMPT } from "./prompts"

/** The tool audience, and the label on the LLM tags, the billing source and the turn span. */
export type ChatSurface = "chat" | "bot"

export interface TurnProfile {
	readonly surface: ChatSurface
	readonly ruleset: PermissionRuleset
	readonly prompt: string
}

export const profileForTurn = (agent: AgentDefinition, origin: ChatTurnOrigin): TurnProfile => {
	switch (origin.kind) {
		case "app":
			return { surface: "chat", ruleset: agent.permission, prompt: agent.prompt }
		case "autonomous":
			// Nobody can approve an unattended pass, so a gated tool is a wasted call and a
			// repeated-failure slot. Denial is the only thing that works here.
			// An agent with its own unattended allowlist (the reviewer) runs under that instead.
			return {
				surface: "chat",
				ruleset: agent.autonomousPermission ?? READ_ONLY_RULESET,
				prompt: agent.prompt,
			}
		case "connector":
			// Mutations are proposed exactly as in the app; the connector renders the approval. What
			// it does not get is `bot`'s audience: not an internal surface, so the agents-only tools
			// — `sandbox_exec` above all — are absent rather than gated. Nothing proposes code
			// execution for approval first.
			return { surface: "bot", ruleset: agent.permission, prompt: CONNECTOR_SYSTEM_PROMPT }
	}
}
