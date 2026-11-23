import { Schema } from "effect"
import { V2IngestRuleAction } from "../http/v2/ingest-rules"
import { IngestRuleCondition, IngestRuleSignal } from "../ingest-rules"

export const IngestRuleRow = Schema.Struct({
	/** REST id (`irule_…`). */
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.Boolean,
	position: Schema.Number,
	signals: Schema.Array(IngestRuleSignal),
	conditions: Schema.Array(IngestRuleCondition),
	action: V2IngestRuleAction,
	/** One line: what the rule does, for tables. */
	summary: Schema.String,
})
export type IngestRuleRow = Schema.Schema.Type<typeof IngestRuleRow>

export const ListIngestRulesOutput = Schema.Struct({ rules: Schema.Array(IngestRuleRow) })

export const IngestRuleMutationOutput = Schema.Struct({
	action: Schema.Literals(["created", "updated"]),
	rule: IngestRuleRow,
})

export const DeleteIngestRuleOutput = Schema.Struct({ id: Schema.String, name: Schema.String })

const PreviewExample = Schema.Struct({
	service: Schema.String,
	/** Span name or log body. */
	label: Schema.String,
	outcome: Schema.Literals(["dropped", "redacted", "parsed", "parse_failed"]),
	/** Changed and added values, `key -> after`; empty for drops. */
	changes: Schema.Array(Schema.String),
})

export const PreviewIngestRuleOutput = Schema.Struct({
	signal: IngestRuleSignal,
	sampled: Schema.Number,
	dropped: Schema.Number,
	redactedRecords: Schema.Number,
	redactedValues: Schema.Number,
	/** Logs a parse rule ran on, and those where a step failed. */
	parsed: Schema.optionalKey(Schema.Number),
	parseFailed: Schema.optionalKey(Schema.Number),
	examples: Schema.Array(PreviewExample),
	/** Rule problems; a rule with problems is not previewed. */
	problems: Schema.Array(Schema.String),
	/** What the sample cannot show, e.g. span events, which stored samples do not carry. */
	notes: Schema.optionalKey(Schema.Array(Schema.String)),
})
