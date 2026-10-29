import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import * as Tabs from "../../../../ui/tabs"
import * as InfraCorrelation from "../../../kit/infra-correlation"
import { SpanNodeData } from "../trace-data"

// The span detail panel's Model: its own state beside the Tabs and Infrastructure children.

const Attributes = Schema.Record(Schema.String, Schema.String)

/** `SpanEvent` (`@maple/query-engine`): one OTel event with its attributes. */
export const SpanEventData = Schema.Struct({
	name: Schema.String,
	timestamp: Schema.String,
	offsetMs: Schema.Number,
	attributes: Attributes,
})
export type SpanEventData = typeof SpanEventData.Type

/** `SpanDetailResult`: the full attribute maps and events of the selected span. */
export const SpanDetail = Schema.Struct({
	spanAttributes: Attributes,
	resourceAttributes: Attributes,
	events: Schema.Array(SpanEventData),
})
export type SpanDetail = typeof SpanDetail.Type

/** The `Log` fields a Logs-tab entry reads. */
export const LogEntry = Schema.Struct({
	timestamp: Schema.String,
	severityText: Schema.String,
	body: Schema.String,
})
export type LogEntry = typeof LogEntry.Type

export const CopyStatus = Schema.Literals(["idle", "copied", "error"])
export type CopyStatus = typeof CopyStatus.Type

/** `useCopy` per copy target: the status and the generation a reset must match. */
export const CopyState = Schema.Struct({ status: CopyStatus, generation: Schema.Number })
export type CopyState = typeof CopyState.Type

export const Model = Schema.Struct({
	span: SpanNodeData,
	traceStartTime: Schema.String,
	totalDurationMs: Schema.Number,
	detail: KeyedSchema(SpanDetail, LoadFailure),
	logs: KeyedSchema(Schema.Array(LogEntry), LoadFailure),
	tabs: Tabs.Model,
	/** Copy status by target id (`span-name`, `attr:span:db.system`, ...). */
	copies: Schema.Record(Schema.String, CopyState),
	/** Open collapsibles by id (stack traces, JSON values, Maple internal). */
	openIds: Schema.Array(Schema.String),
	isErrorExpanded: Schema.Boolean,
	/** The Infrastructure tab. */
	infra: InfraCorrelation.Model,
})
export type Model = typeof Model.Type

/** What the attribute, error and log parts read: the agent session's span popover holds just this. */
export const PanelState = Schema.Struct({
	detail: Model.fields.detail,
	logs: Model.fields.logs,
	copies: Model.fields.copies,
	openIds: Model.fields.openIds,
	isErrorExpanded: Model.fields.isErrorExpanded,
})
export type PanelState = typeof PanelState.Type
