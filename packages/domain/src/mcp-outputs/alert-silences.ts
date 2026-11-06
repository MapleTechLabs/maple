/** Output schemas for the alert silence MCP tools. */
import { Schema } from "effect"

const MatcherValues = Schema.optionalKey(Schema.Array(Schema.String))

export const AlertSilenceMatchersRow = Schema.Struct({
	ruleIds: MatcherValues,
	tags: MatcherValues,
	services: MatcherValues,
	environments: MatcherValues,
})

export const AlertSilenceRow = Schema.Struct({
	id: Schema.String,
	reason: Schema.String,
	matchers: AlertSilenceMatchersRow,
	/** scheduled, active or ended. */
	status: Schema.String,
	startsAt: Schema.String,
	endsAt: Schema.String,
	createdBy: Schema.String,
})

export const ListAlertSilencesOutput = Schema.Struct({
	silences: Schema.Array(AlertSilenceRow),
	total: Schema.Number,
	/** The status filter; absent means active and scheduled. */
	status: Schema.optionalKey(Schema.String),
	limit: Schema.Number,
	hasMore: Schema.Boolean,
})

export const AlertSilenceMutationOutput = Schema.Struct({ silence: AlertSilenceRow })
