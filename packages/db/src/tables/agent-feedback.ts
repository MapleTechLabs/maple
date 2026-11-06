import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/domain/primitives"

/**
 * Feedback about Maple itself, written by an agent (a coding assistant over MCP, a script on
 * the v2 API, Maple's own chat) rather than a person. Read by the Maple team for triage; the
 * org sees what its own agents sent.
 */
export const AgentFeedback = PG.table("agent_feedback", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** The human behind the credential the agent used. */
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		/** `bug`, `feature_request`, `improvement`, `documentation`, `praise`, `other`. */
		kind: PG.text,
		/** `blocking`, `degraded`, `minor`; null when the agent did not say. */
		impact: PG.nullable(PG.text),
		summary: PG.text,
		/** Why the agent is sending this: what it was trying to do and what got in the way. */
		reason: PG.text,
		details: PG.nullable(PG.text),
		/** The MCP tool, endpoint, or page the feedback concerns. */
		relatedTo: PG.column(PG.nullable(PG.text), { name: "related_to" }),
		/** `coding_agent`, `chat_assistant`, `autonomous_agent`, `ci`, `other`. */
		agentType: PG.column(PG.text, { name: "agent_type" }),
		/** The client, e.g. `claude-code`, `cursor`, as the agent reported it. */
		agentName: PG.column(PG.nullable(PG.text), { name: "agent_name" }),
		agentModel: PG.column(PG.nullable(PG.text), { name: "agent_model" }),
		agentVersion: PG.column(PG.nullable(PG.text), { name: "agent_version" }),
		/** `mcp` or `api`: the surface the feedback arrived on. */
		source: PG.text,
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("agent_feedback_org_created_idx", ["orgId", "createdAt"]),
		PG.index("agent_feedback_kind_created_idx", ["kind", "createdAt"]),
	],
	tenantColumn: "orgId",
})

export type AgentFeedbackRow = PG.SelectRowOf<typeof AgentFeedback>
