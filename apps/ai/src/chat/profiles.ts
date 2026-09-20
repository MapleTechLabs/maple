/**
 * What a turn's ORIGIN decides, in one table.
 *
 * A turn has two axes. Its `ChatMode` says what the conversation is — persona and budget, derived
 * from the session id. Its `ChatTurnOrigin` says who is driving it. This module is the second axis
 * and nothing else reads it: every consumer takes the resolved profile rather than asking about
 * the origin again, so a turn cannot run on one surface and be billed, traced or prompted as
 * another.
 *
 * It replaces a set of comparisons against sentinel user ids (`internal-service`, and a bot id
 * beside it). A sentinel is an identity being asked a question it cannot answer — "who is this?"
 * standing in for "how was this raised?" — and it drifts the moment a second caller needs the same
 * behaviour under a different name.
 */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import type { PermissionRuleset } from "@maple/domain/permission"
import type { AgentDefinition } from "./agents"
import { READ_ONLY_RULESET } from "./permissions"
import { CONNECTOR_SYSTEM_PROMPT } from "./prompts"

/**
 * How a turn is labelled to everything downstream of the run: the LLM call's tags, the billing
 * meter's source, and the `chat.turn` span. Two values, so it groups.
 */
export type ChatSurface = "chat" | "bot"

export interface TurnProfile {
	/**
	 * Which audience of tools exists at all. `bot` is deliberately NOT an internal surface
	 * (`INTERNAL_SURFACES` in `../mcp/tools/types.ts`), so the agents-only tools — the repository
	 * sandbox above all — are absent from a connector turn's catalog rather than merely gated. A
	 * reply lands wherever the thread is readable, and nothing proposes `sandbox_exec` for approval
	 * first.
	 */
	readonly toolSurface: McpToolSurface
	/** The one label. See {@link ChatSurface}. */
	readonly label: ChatSurface
	/** The ruleset this turn is evaluated against, which is not always its agent's. */
	readonly ruleset: PermissionRuleset
	/** The persona this turn speaks as, which is not always its mode's. */
	readonly prompt: string
}

export const profileForTurn = (agent: AgentDefinition, origin: ChatTurnOrigin): TurnProfile => {
	switch (origin.kind) {
		case "app":
			return {
				toolSurface: "chat",
				label: "chat",
				ruleset: agent.permission,
				prompt: agent.prompt,
			}
		case "autonomous":
			// An unattended pass cannot obtain an approval, so the mutating tools are dead weight to
			// it: a schema on every model call, and a wasted call plus a repeated-failure slot the
			// moment it tries one. Denial is what works where nobody can approve.
			return {
				toolSurface: "chat",
				label: "chat",
				ruleset: READ_ONLY_RULESET,
				prompt: agent.prompt,
			}
		case "connector":
			// The same propose-then-apply model as the app: reads run, mutations are offered with
			// their real schema and resolve to `ask`, so the call is emitted as a proposal and the
			// handler refuses. The connector renders the approval in the thread.
			return {
				toolSurface: "bot",
				label: "bot",
				ruleset: agent.permission,
				prompt: CONNECTOR_SYSTEM_PROMPT,
			}
	}
}
