import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { SlotSchema } from "../../data/slot"

// The Query page as data.

export const LocalTable = Schema.Struct({ name: Schema.String, totalRows: Schema.NullOr(Schema.Number) })
export type LocalTable = typeof LocalTable.Type

/** One `/local/query` row as the server sent it. */
export const ResultRow = Schema.Record(Schema.String, Schema.Unknown)
export type ResultRow = typeof ResultRow.Type

/** The console's submission: none yet, running, or its answer. `id` retires a cancelled run's answer. */
export const RunState = defineTaggedUnion({
	Idle: {},
	Running: { id: Schema.Number, sql: Schema.String },
	Succeeded: { id: Schema.Number, sql: Schema.String, rows: Schema.Array(ResultRow), elapsedMs: Schema.Number },
	Failed: { id: Schema.Number, sql: Schema.String, title: Schema.String, detail: Schema.String },
})
export type RunState = typeof RunState.Type

export const Model = Schema.TaggedStruct("QueryPage", {
	/** `navigator.platform` reads Mac: the shortcut hint shows ⌘, else Ctrl. */
	isMac: Schema.Boolean,
	/** The sidebar's `system.tables` read; a failure keeps `describeQueryError`'s detail as its message. */
	tables: SlotSchema(Schema.Array(LocalTable)),
	run: RunState,
	nextRunId: Schema.Number,
})
export type Model = typeof Model.Type
