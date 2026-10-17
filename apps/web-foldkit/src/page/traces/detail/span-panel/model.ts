import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import * as Tabs from "../../../../ui/tabs"
import { SpanNodeData } from "../trace-data"

// `SpanDetailPanel` (apps/web/src/components/traces/span-detail-panel.tsx) as a Submodel.

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
})
export type Model = typeof Model.Type
