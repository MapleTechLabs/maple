import { IsoDateTimeString, isPanelType, type PanelType } from "@maple/domain/http"
import { resolveTimeRangeWindow } from "@maple/query-engine"
import { toQueryBuilderDataSource } from "@maple/query-model"
import { Option, Schema } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import * as Keyed from "../../../data/keyed"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"
import * as Select from "../../../ui/select"
import type { PageContext } from "../../contract"
import { GenerateId } from "./command"
import { setAggregation, setDataSource, updateQuery, withRootOnly } from "./edits"
import type { EditorState } from "./editor-state"
import { Message } from "./message"
import type { Model } from "./model"
import { editState, type Return } from "./update"

// The submodel steps: selects, group-by chips, the leave dialog, and the dashboard range picker.

/** A select's value written into the state, by which select it is (`<field>:<query id>`). */
const applySelectValue = (state: EditorState, id: string, value: string): EditorState => {
	const [field = "", queryId = ""] = id.split(":")
	switch (field) {
		case "source": {
			const source = toQueryBuilderDataSource(value)
			return source === null ? state : setDataSource(state, queryId, source)
		}
		case "spans":
			return updateQuery(state, queryId, (query) => ({
				...query,
				whereClause: withRootOnly(query.whereClause, value === "root"),
			}))
		case "aggregation":
			return setAggregation(state, queryId, value)
		case "orderDirection":
			return value === "asc" || value === "desc"
				? updateQuery(state, queryId, (query) => ({ ...query, orderByDirection: value }))
				: state
		case "unit":
			return { ...state, unit: value === "duration" ? "duration_ms" : value }
		case "comparison":
			return { ...state, comparisonMode: value === "previous_period" ? "previous_period" : "none" }
		default:
			return state
	}
}

export const selectStep = (
	model: Model,
	context: PageContext,
	id: string,
	message: Select.Message,
): Return => {
	const current = model.selects[id] ?? Select.init(id, { value: "", selectedIndex: null })
	const next = Select.update(current, message)
	const lifted: Model = { ...model, selects: { ...model.selects, [id]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotSelectMessage({ id, message: inner }),
	)
	if (next.outMessage === undefined) return { model: lifted, commands }
	const value = next.outMessage.value
	const edited = editState(lifted, context, (state) => applySelectValue(state, id, value))
	return { ...edited, commands: [...commands, ...(edited.commands ?? [])] }
}

export const groupByStep = (
	model: Model,
	context: PageContext,
	queryId: string,
	message: Combobox.Message,
): Return => {
	const current = model.groupBys[queryId] ?? Combobox.init(`group-by-${queryId}`, "multiple")
	const next = Combobox.update(current, message)
	const lifted: Model = { ...model, groupBys: { ...model.groupBys, [queryId]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotGroupByMessage({ queryId, message: inner }),
	)
	if (next.outMessage === undefined || next.outMessage._tag !== "ChangedSelection")
		return { model: lifted, commands }
	const groupBy = [...next.outMessage.selected]
	const edited = editState(lifted, context, (state) =>
		updateQuery(state, queryId, (query) => ({ ...query, groupBy })),
	)
	return { ...edited, commands: [...commands, ...(edited.commands ?? [])] }
}

export const leaveDialogStep = (model: Model, message: Dialog.Message): Return => {
	const next = Dialog.update(model.leaveDialog, message)
	return {
		model: { ...model, leaveDialog: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotLeaveDialogMessage({ message: inner }),
		),
	}
}

/** `WidgetTimeRange`: Custom seeds an absolute override from the board's window. */
export const timeRangeModeStep = (model: Model, context: PageContext, mode: "dashboard" | "custom"): Return =>
	editState(model, context, (state): EditorState => {
		if (mode === "dashboard") return { ...state, timeRange: null }
		if (state.timeRange !== null) return state
		const window =
			model.timeRange === null || model.nowMs === null
				? null
				: resolveTimeRangeWindow(model.timeRange, {
						snap: true,
						timeZone: context.timeZone,
						nowMs: model.nowMs,
					})
		const startTime = Option.flatMap(Option.fromNullishOr(window?.startTime), decodeIso)
		const endTime = Option.flatMap(Option.fromNullishOr(window?.endTime), decodeIso)
		return {
			...state,
			timeRange:
				Option.isSome(startTime) && Option.isSome(endTime)
					? { type: "absolute", startTime: startTime.value, endTime: endTime.value }
					: { type: "relative", value: "1h" },
		}
	})

const decodeIso = Schema.decodeUnknownOption(IsoDateTimeString)

/** `TypePicker`. TODO(widget-editor): only the timeseries panels are configurable here yet. */
export const isConfigurablePanel = (panel: string): panel is PanelType =>
	isPanelType(panel) && (panel === "line" || panel === "bar" || panel === "area" || panel === "markdown")

export const chartStep = (model: Model, message: Chart.Message): Return => {
	const next = Chart.update(model.chart, message)
	return {
		model: { ...model, chart: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotChartMessage({ message: inner }),
		),
	}
}

export const acceptFetch = (
	model: Model,
	key: string,
	result: Message & { _tag: "CompletedFetchWidget" },
): Model => {
	const slot = model.requests[key]
	return slot === undefined
		? model
		: { ...model, requests: { ...model.requests, [key]: Keyed.accept(slot, key, result.result) } }
}

export const generate = (
	purpose: "addQuery" | "cloneQuery" | "addFormula",
	source: string,
): Return["commands"] => [GenerateId({ purpose, source })]
