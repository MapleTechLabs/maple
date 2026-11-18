/**
 * What a turn's origin decides, in one table.
 *
 * The mode says what a conversation is; the origin says who is driving this turn. This is the only
 * reader of the second — every consumer takes the resolved profile — so a turn cannot run on one
 * surface and be billed, traced or prompted as another.
 */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import { PermissionRule, type PermissionRuleset } from "@maple/domain/permission"
import type { TenantContext } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { mayQueryDataSources, queryCallerOf } from "@maple/backend/services/data-sources/query-caller"
import { Array as Arr } from "effect"
import { DASHBOARD_AUTHORING_TOOLS } from "../mcp/tools/types"
import type { AgentDefinition } from "./agents"
import { READ_ONLY_RULESET } from "./permissions"
import { CONNECTOR_SYSTEM_PROMPT } from "./prompts"
import type { LlmCallTags } from "../platform/Llm"

/** The tool audience, and the label on the LLM tags, the billing source and the turn span. */
export type ChatSurface = LlmCallTags["surface"]

export interface TurnProfile {
	readonly surface: ChatSurface
	readonly ruleset: PermissionRuleset
	readonly prompt: string
}

/** The ruleset an analyst's turn runs under: only dashboard changes are still proposed to them. */
const forAnalyst = (ruleset: PermissionRuleset): PermissionRuleset =>
	Arr.map(ruleset, (rule) =>
		rule.action === "ask" && !DASHBOARD_AUTHORING_TOOLS.has(rule.tool)
			? new PermissionRule({ tool: rule.tool, action: "deny" })
			: rule,
	)

/** The profile for whoever the turn's tools run as: an analyst is offered no change outside dashboards. */
export const profileForRoles = (profile: TurnProfile, roles: ReadonlyArray<string>): TurnProfile =>
	Policy.isAnalyst(roles) ? { ...profile, ruleset: forAnalyst(profile.ruleset) } : profile

/** The tool whose call the data source service would refuse this turn. */
const QUERY_DATA_SOURCE = "query_data_source"

/**
 * The profile for the tenant a turn's tools run as. On top of the role rules, a turn whose query
 * the service would refuse is not offered the tool: a listed tool invites a call that only fails.
 */
export const profileForTenant = (
	profile: TurnProfile,
	tenant: Pick<TenantContext, "roles" | "turnOrigin" | "turnStarter">,
): TurnProfile => {
	const byRole = profileForRoles(profile, tenant.roles)
	return mayQueryDataSources(queryCallerOf(tenant))
		? byRole
		: {
				...byRole,
				ruleset: [...byRole.ruleset, new PermissionRule({ tool: QUERY_DATA_SOURCE, action: "deny" })],
			}
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
			// Mutations are proposed exactly as in the app; the connector renders the approval. `bot`
			// sees the agent-audience tools (the repository sandbox) but not the internal ones (the
			// pull request reviewer's), which are absent rather than gated.
			return { surface: "bot", ruleset: agent.permission, prompt: CONNECTOR_SYSTEM_PROMPT }
	}
}
