import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "../../data/load-failure"
import * as Tabs from "../../ui/tabs"
import { SpanNodeData } from "../trace-data"
import { LogEntry, SpanDetail } from "../trace-source"

// The span detail panel, as a Submodel. Its reads go through `TraceSource`.

/** One read: its data and the key it was requested under, so a superseded answer is dropped. */
export const ReadSchema = <A, AI>(dataSchema: Schema.Codec<A, AI>) =>
	Schema.Struct({
		key: Schema.NullOr(Schema.String),
		data: AsyncData.Schema(dataSchema, LoadFailure).schema,
	})
export type Read<A> = Readonly<{ key: string | null; data: AsyncData.AsyncData<A, LoadFailure> }>

export const idleRead = <A>(): Read<A> => ({ key: null, data: AsyncData.Idle() })

/** Folds a result in only if it answers the read's current key. */
export const acceptRead = <A>(read: Read<A>, key: string, result: Result.Result<A, LoadFailure>): Read<A> =>
	read.key !== key ? read : { key, data: AsyncData.settle(read.data, result) }

export const CopyStatus = Schema.Literals(["idle", "copied", "error"])
export type CopyStatus = typeof CopyStatus.Type

/** `useCopy` per copy target: the status and the generation a reset must match. */
export const CopyState = Schema.Struct({ status: CopyStatus, generation: Schema.Number })
export type CopyState = typeof CopyState.Type

export const Model = Schema.Struct({
	span: SpanNodeData,
	traceStartTime: Schema.String,
	totalDurationMs: Schema.Number,
	detail: ReadSchema(SpanDetail),
	logs: ReadSchema(Schema.Array(LogEntry)),
	tabs: Tabs.Model,
	/** Copy status by target id (`span-name`, `attr:span:db.system`, ...). */
	copies: Schema.Record(Schema.String, CopyState),
	/** Open collapsibles by id (stack traces, JSON values, Maple internal). */
	openIds: Schema.Array(Schema.String),
	isErrorExpanded: Schema.Boolean,
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
