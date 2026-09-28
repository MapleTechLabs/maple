/** Output schema for `submit_feedback`. */
import { Schema } from "effect"

export const SubmitFeedbackOutput = Schema.Struct({
	/** Public `afb_…` id, the same one `GET /v2/agent_feedback` returns. */
	id: Schema.String,
	kind: Schema.String,
	impact: Schema.NullOr(Schema.String),
	summary: Schema.String,
	agentType: Schema.String,
	agentName: Schema.NullOr(Schema.String),
	agentModel: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
})
