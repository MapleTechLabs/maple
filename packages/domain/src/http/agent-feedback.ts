import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

/**
 * Feedback about Maple from an agent: the v2 `agent_feedback` resource and the `send_maple_feedback`
 * MCP tool write the same row through `AgentFeedbackService`.
 */

export const AgentFeedbackKind = Schema.Literals([
	"bug",
	"feature_request",
	"improvement",
	"documentation",
	"praise",
	"other",
]).annotate({
	identifier: "@maple/AgentFeedbackKind",
	title: "Agent Feedback Kind",
	description:
		"`bug`: something is broken or wrong. `feature_request`: a capability that does not exist. `improvement`: something that works but could work better. `documentation`: docs or tool descriptions are missing, wrong, or misleading. `praise`: something worked well. `other`: none of the above.",
})
export type AgentFeedbackKind = Schema.Schema.Type<typeof AgentFeedbackKind>

export const AgentFeedbackImpact = Schema.Literals(["blocking", "degraded", "minor"]).annotate({
	identifier: "@maple/AgentFeedbackImpact",
	title: "Agent Feedback Impact",
	description:
		"`blocking`: the task could not be finished. `degraded`: it finished with a workaround or a worse result. `minor`: a papercut.",
})
export type AgentFeedbackImpact = Schema.Schema.Type<typeof AgentFeedbackImpact>

export const AgentType = Schema.Literals([
	"coding_agent",
	"chat_assistant",
	"autonomous_agent",
	"ci",
	"other",
]).annotate({
	identifier: "@maple/AgentType",
	title: "Agent Type",
	description:
		"`coding_agent`: an assistant working in a codebase (Claude Code, Cursor, Codex). `chat_assistant`: a conversational assistant answering a person. `autonomous_agent`: an unattended agent running on its own loop. `ci`: a pipeline or bot. `other`: none of the above.",
})
export type AgentType = Schema.Schema.Type<typeof AgentType>

export const AgentFeedbackSource = Schema.Literals(["api", "mcp"])
export type AgentFeedbackSource = Schema.Schema.Type<typeof AgentFeedbackSource>

export class AgentFeedbackPersistenceError extends HttpTaggedError<AgentFeedbackPersistenceError>()(
	"@maple/http/errors/AgentFeedbackPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{
		status: 503,
		code: "agent_feedback_unavailable",
		title: "Feedback is temporarily unavailable",
		message: "Feedback could not be saved right now. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}
