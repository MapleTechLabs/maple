import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Combobox from "../../../ui/combobox"
import * as Select from "../../../ui/select"
import { initWhereFields, WhereFieldMessage, WhereFields } from "../where-field"
import { AddOnKey, QueryChange, QueryTextField } from "./change"

// `QueryPanel`'s own state: the
// selects and group-by chips of every panel, and which panels are collapsed. The drafts stay with
// the host page; an edit leaves as `ChangedQuery` for the host to apply.

export const Model = Schema.Struct({
	/** Prefixes the selects' slot ids (`<prefix>-select-<field>:<query id>`). */
	slotPrefix: Schema.String,
	selects: Schema.Record(Schema.String, Select.Model),
	groupBys: Schema.Record(Schema.String, Combobox.Model),
	/** `MetricsBody`: the metric picker and the one-field "by" combobox, by query id. */
	metricPickers: Schema.Record(Schema.String, Combobox.Model),
	metricBreakdowns: Schema.Record(Schema.String, Combobox.Model),
	collapsed: Schema.Array(Schema.String),
	/** Each where editor's caret, list and active key values, by query id. */
	whereFields: WhereFields,
})
export type Model = typeof Model.Type

export const init = (slotPrefix: string): Model => ({
	slotPrefix,
	selects: {},
	groupBys: {},
	metricPickers: {},
	metricBreakdowns: {},
	collapsed: [],
	whereFields: initWhereFields(),
})

export const Message = defineMessageUnion({
	GotSelectMessage: { id: Schema.String, message: Select.Message },
	GotGroupByMessage: { queryId: Schema.String, message: Combobox.Message },
	/** `value`: the draft's metric, which a closed picker's input reads (and keeps on opening). */
	GotMetricMessage: { queryId: Schema.String, value: Schema.String, message: Combobox.Message },
	GotMetricBreakdownMessage: { queryId: Schema.String, message: Combobox.Message },
	ToggledCollapsed: { queryId: Schema.String },
	ToggledVisible: { queryId: Schema.String },
	ChangedText: { queryId: Schema.String, field: QueryTextField, value: Schema.String },
	ToggledAddOn: { queryId: Schema.String, key: AddOnKey },
	ClickedClone: { queryId: Schema.String },
	ClickedRemove: { queryId: Schema.String },
	/** The where editors' suggestions; a field id is its query's id. */
	GotWhereField: { message: WhereFieldMessage },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	ChangedQuery: { queryId: Schema.String, change: QueryChange },
	/** A metric picked: the host knows whether it is monotonic from the list it fetched. */
	PickedMetric: { queryId: Schema.String, value: Schema.String },
	/** `onMetricSearch`: the host re-reads the metric list for what is typed. */
	ChangedMetricSearch: { search: Schema.String },
	ClickedClone: { queryId: Schema.String },
	ClickedRemove: { queryId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type
