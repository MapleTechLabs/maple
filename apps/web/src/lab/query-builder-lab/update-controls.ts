import { toQueryBuilderDataSource } from "@maple/query-model"
import { Command, type Update } from "foldkit"
import { applyQueryChange, QueryChange } from "../../page/kit/query-builder/change"
import type { QueryDraft } from "../../page/kit/query-builder/draft"
import type { Resources } from "../../platform/resources"
import * as Combobox from "../../ui/combobox"
import * as Select from "../../ui/select"
import { parseMetricSelection } from "./derive"
import { Message, type Model } from "./model"

// The lab's selects (`<field>:<query id>`) and group-by comboboxes, each kept by id.

type Return = Update.Return<Model, Message, Resources>

export const updateQuery = (
	model: Model,
	queryId: string,
	updater: (query: QueryDraft) => QueryDraft,
): Model => ({
	...model,
	queries: model.queries.map((query) => (query.id === queryId ? updater(query) : query)),
})

/** A select's value as the edit its `onValueChange` makes. */
const selectEdit = (field: string, value: string): ((query: QueryDraft) => QueryDraft) | null => {
	switch (field) {
		case "source": {
			const source = toQueryBuilderDataSource(value)
			return source === null
				? null
				: (query) => applyQueryChange(query, QueryChange.SetSource({ source }))
		}
		case "aggregation":
			return (query) => applyQueryChange(query, QueryChange.SetAggregation({ aggregation: value }))
		case "orderDirection":
			return value === "asc" || value === "desc"
				? (query) => applyQueryChange(query, QueryChange.SetOrderDirection({ direction: value }))
				: null
		case "metric": {
			const parsed = parseMetricSelection(value)
			return parsed === null
				? null
				: (query) => (query.dataSource === "metrics" ? { ...query, ...parsed } : query)
		}
		case "signal":
			return value === "default" || value === "meter"
				? (query) => (query.dataSource === "metrics" ? { ...query, signalSource: value } : query)
				: null
		default:
			return null
	}
}

export const selectStep = (model: Model, id: string, message: Select.Message): Return => {
	const current = model.selects[id] ?? Select.init(id, { value: "", selectedIndex: null })
	const next = Select.update(current, message)
	const lifted: Model = { ...model, selects: { ...model.selects, [id]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotSelectMessage({ id, message: inner }),
	)
	if (next.outMessage === undefined) return { model: lifted, commands }
	const [field = "", queryId = ""] = id.split(":")
	const edit = selectEdit(field, next.outMessage.value)
	return { model: edit === null ? lifted : updateQuery(lifted, queryId, edit), commands }
}

/** `GroupByAutocomplete`'s combobox for a query, seeded with its first group-by field. */
export const groupByModelOf = (model: Model, query: QueryDraft): Combobox.Model =>
	model.groupBys[query.id] ??
	Combobox.init(`group-by-${query.id}`, "single", { selected: query.groupBy.slice(0, 1) })

export const groupByStep = (model: Model, queryId: string, message: Combobox.Message): Return => {
	const query = model.queries.find((candidate) => candidate.id === queryId)
	if (query === undefined) return { model }
	const next = Combobox.update(groupByModelOf(model, query), message)
	const lifted: Model = { ...model, groupBys: { ...model.groupBys, [queryId]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotGroupByMessage({ queryId, message: inner }),
	)
	if (next.outMessage === undefined || next.outMessage._tag !== "ChangedValue")
		return { model: lifted, commands }
	const { value } = next.outMessage
	const groupBy = value === "" ? [] : [value]
	return {
		model: updateQuery(lifted, queryId, (current) =>
			applyQueryChange(current, QueryChange.SetGroupBy({ groupBy })),
		),
		commands,
	}
}
