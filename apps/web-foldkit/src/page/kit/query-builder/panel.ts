import { toQueryBuilderDataSource } from "@maple/query-model"
import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Combobox from "../../../ui/combobox"
import * as Select from "../../../ui/select"
import { AddOnKey, QueryChange, QueryTextField } from "./change"

// `QueryPanel`'s own state (apps/web/src/components/dashboard-builder/config/query-panel.tsx): the
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
})
export type Model = typeof Model.Type

export const init = (slotPrefix: string): Model => ({
	slotPrefix,
	selects: {},
	groupBys: {},
	metricPickers: {},
	metricBreakdowns: {},
	collapsed: [],
})

export const Message = defineMessageUnion({
	GotSelectMessage: { id: Schema.String, message: Select.Message },
	GotGroupByMessage: { queryId: Schema.String, message: Combobox.Message },
	GotMetricMessage: { queryId: Schema.String, message: Combobox.Message },
	GotMetricBreakdownMessage: { queryId: Schema.String, message: Combobox.Message },
	ToggledCollapsed: { queryId: Schema.String },
	ToggledVisible: { queryId: Schema.String },
	ChangedText: { queryId: Schema.String, field: QueryTextField, value: Schema.String },
	ToggledAddOn: { queryId: Schema.String, key: AddOnKey },
	ClickedClone: { queryId: Schema.String },
	ClickedRemove: { queryId: Schema.String },
	PressedWhereEnter: {},
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
	PressedWhereEnter: {},
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const toggled = (list: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
	list.includes(value) ? list.filter((item) => item !== value) : [...list, value]

const changed = (model: Model, queryId: string, change: QueryChange, commands?: Return["commands"]): Return => ({
	model,
	...(commands === undefined ? undefined : { commands }),
	outMessage: OutMessage.ChangedQuery({ queryId, change }),
})

/** A select's value as a query change, by which select it is (`<field>:<query id>`). */
const selectChange = (field: string, value: string): QueryChange | null => {
	switch (field) {
		case "source": {
			const source = toQueryBuilderDataSource(value)
			return source === null ? null : QueryChange.SetSource({ source })
		}
		case "spans":
			return QueryChange.SetRootOnly({ isRootOnly: value === "root" })
		case "aggregation-across":
		case "aggregation":
			return QueryChange.SetAggregation({ aggregation: value })
		case "orderDirection":
			return value === "asc" || value === "desc" ? QueryChange.SetOrderDirection({ direction: value }) : null
		default:
			return null
	}
}

const selectStep = (model: Model, id: string, message: Select.Message): Return => {
	const current = model.selects[id] ?? Select.init(id, { value: "", selectedIndex: null })
	const next = Select.update(current, message)
	const lifted: Model = { ...model, selects: { ...model.selects, [id]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) => Message.GotSelectMessage({ id, message: inner }))
	if (next.outMessage === undefined) return { model: lifted, commands }
	const [field = "", queryId = ""] = id.split(":")
	const change = selectChange(field, next.outMessage.value)
	return change === null ? { model: lifted, commands } : changed(lifted, queryId, change, commands)
}

const groupByStep = (model: Model, queryId: string, message: Combobox.Message): Return => {
	const current = model.groupBys[queryId] ?? Combobox.init(`group-by-${queryId}`, "multiple")
	const next = Combobox.update(current, message)
	const lifted: Model = { ...model, groupBys: { ...model.groupBys, [queryId]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotGroupByMessage({ queryId, message: inner }),
	)
	if (next.outMessage === undefined || next.outMessage._tag !== "ChangedSelection") return { model: lifted, commands }
	return changed(lifted, queryId, QueryChange.SetGroupBy({ groupBy: [...next.outMessage.selected] }), commands)
}

export const metricPickerIdOf = (queryId: string): string => `metric-${queryId}`
export const metricBreakdownIdOf = (queryId: string): string => `metric-by-${queryId}`

/** The metric picker: a pick goes to the host, typing re-reads the list. */
const metricStep = (model: Model, queryId: string, message: Combobox.Message): Return => {
	const current = model.metricPickers[queryId] ?? Combobox.init(metricPickerIdOf(queryId), "single")
	const next = Combobox.update(current, message)
	const lifted: Model = { ...model, metricPickers: { ...model.metricPickers, [queryId]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotMetricMessage({ queryId, message: inner }),
	)
	if (message._tag === "ChangedInput")
		return { model: lifted, commands, outMessage: OutMessage.ChangedMetricSearch({ search: message.value }) }
	return next.outMessage?._tag === "ChangedValue"
		? { model: lifted, commands, outMessage: OutMessage.PickedMetric({ queryId, value: next.outMessage.value }) }
		: { model: lifted, commands }
}

const metricBreakdownStep = (model: Model, queryId: string, message: Combobox.Message): Return => {
	const current = model.metricBreakdowns[queryId] ?? Combobox.init(metricBreakdownIdOf(queryId), "single")
	const next = Combobox.update(current, message)
	const lifted: Model = { ...model, metricBreakdowns: { ...model.metricBreakdowns, [queryId]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotMetricBreakdownMessage({ queryId, message: inner }),
	)
	return next.outMessage?._tag === "ChangedValue"
		? changed(lifted, queryId, QueryChange.SetMetricBreakdown({ value: next.outMessage.value }), commands)
		: { model: lifted, commands }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotSelectMessage: ({ id, message: inner }) => selectStep(model, id, inner),
		GotGroupByMessage: ({ queryId, message: inner }) => groupByStep(model, queryId, inner),
		GotMetricMessage: ({ queryId, message: inner }) => metricStep(model, queryId, inner),
		GotMetricBreakdownMessage: ({ queryId, message: inner }) => metricBreakdownStep(model, queryId, inner),
		ToggledCollapsed: ({ queryId }) => ({ model: { ...model, collapsed: toggled(model.collapsed, queryId) } }),
		ToggledVisible: ({ queryId }) => changed(model, queryId, QueryChange.ToggledHidden()),
		ChangedText: ({ queryId, field, value }) => changed(model, queryId, QueryChange.SetText({ field, value })),
		ToggledAddOn: ({ queryId, key }) => changed(model, queryId, QueryChange.ToggledAddOn({ key })),
		ClickedClone: ({ queryId }) => ({ model, outMessage: OutMessage.ClickedClone({ queryId }) }),
		ClickedRemove: ({ queryId }) => ({ model, outMessage: OutMessage.ClickedRemove({ queryId }) }),
		PressedWhereEnter: () => ({ model, outMessage: OutMessage.PressedWhereEnter() }),
	})
