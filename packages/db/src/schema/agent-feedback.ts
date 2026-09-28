import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import type { OrgId, UserId } from "@maple/domain/primitives"

/**
 * Feedback about Maple itself, written by an agent (a coding assistant over MCP, a script on
 * the v2 API, Maple's own chat) rather than a person. Read by the Maple team for triage; the
 * org sees what its own agents sent.
 */
export const agentFeedback = pgTable(
	"agent_feedback",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		/** The human behind the credential the agent used. */
		userId: text("user_id").$type<UserId>().notNull(),
		/** `bug`, `feature_request`, `improvement`, `documentation`, `praise`, `other`. */
		kind: text("kind").notNull(),
		/** `blocking`, `degraded`, `minor`; null when the agent did not say. */
		impact: text("impact"),
		summary: text("summary").notNull(),
		/** Why the agent is sending this: what it was trying to do and what got in the way. */
		reason: text("reason").notNull(),
		details: text("details"),
		/** The MCP tool, endpoint, or page the feedback concerns. */
		relatedTo: text("related_to"),
		/** `coding_agent`, `chat_assistant`, `autonomous_agent`, `ci`, `other`. */
		agentType: text("agent_type").notNull(),
		/** The client, e.g. `claude-code`, `cursor`, as the agent reported it. */
		agentName: text("agent_name"),
		agentModel: text("agent_model"),
		agentVersion: text("agent_version"),
		/** `mcp` or `api`: the surface the feedback arrived on. */
		source: text("source").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		index("agent_feedback_org_created_idx").on(table.orgId, table.createdAt),
		index("agent_feedback_kind_created_idx").on(table.kind, table.createdAt),
	],
)

export type AgentFeedbackRow = typeof agentFeedback.$inferSelect
