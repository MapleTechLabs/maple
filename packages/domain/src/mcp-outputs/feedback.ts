/** Output schema for `send_maple_feedback`. */
import { Schema } from "effect"

export const SendMapleFeedbackOutput = Schema.Struct({
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

/** One report as the Maple team triages it: the full text, plus who sent it from where. */
export const MapleFeedbackReport = Schema.Struct({
	id: Schema.String,
	orgId: Schema.String,
	userId: Schema.String,
	kind: Schema.String,
	impact: Schema.NullOr(Schema.String),
	summary: Schema.String,
	reason: Schema.String,
	details: Schema.NullOr(Schema.String),
	relatedTo: Schema.NullOr(Schema.String),
	agentType: Schema.String,
	agentName: Schema.NullOr(Schema.String),
	agentModel: Schema.NullOr(Schema.String),
	agentVersion: Schema.NullOr(Schema.String),
	source: Schema.String,
	createdAt: Schema.String,
})

/** Output schema for `list_maple_feedback`. */
export const ListMapleFeedbackOutput = Schema.Struct({
	reports: Schema.Array(MapleFeedbackReport),
	limit: Schema.Number,
	filters: Schema.Struct({
		kind: Schema.optionalKey(Schema.String),
		impact: Schema.optionalKey(Schema.String),
		startTime: Schema.optionalKey(Schema.String),
		relatedTo: Schema.optionalKey(Schema.String),
		orgId: Schema.optionalKey(Schema.String),
	}),
})
