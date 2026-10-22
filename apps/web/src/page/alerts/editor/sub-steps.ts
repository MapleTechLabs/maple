import { AlertComparator, AlertSeverity, AlertSignalType } from "@maple/domain/http"
import { QueryEngineAlertReducer } from "@maple/domain/query-engine"
import { Schema } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import * as Combobox from "../../../ui/combobox"
import * as RadioGroup from "../../../ui/radio-group"
import * as Select from "../../../ui/select"
import type { PageContext } from "../../contract"
import { applyQueryChange } from "../../kit/query-builder/change"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { setBuiltinSignal, setChips, setSeverity } from "./form-steps"
import { Message } from "./message"
import { panelInputsOf } from "./where-inputs"
import type { Model } from "./model"
import { ReadEditorClock } from "./command"
import { editForm, type Return } from "./steps"

// The child Submodels the form is built from: selects, chip pickers, the query panel, the chart,
// and the preview's own lookback picker.

const decodeComparator = Schema.decodeUnknownOption(AlertComparator)
const decodeReducer = Schema.decodeUnknownOption(QueryEngineAlertReducer)
const decodeSignal = Schema.decodeUnknownOption(AlertSignalType)
const decodeSeverity = Schema.decodeUnknownOption(AlertSeverity)

/** The built-in signal and severity radio groups; their value is the form's. */
export const radioStep = (
	model: Model,
	context: PageContext,
	group: "signal" | "severity",
	message: RadioGroup.Message,
): Return => {
	const current =
		model.form === null ? null : group === "signal" ? model.form.signalType : model.form.severity
	const next = RadioGroup.update(RadioGroup.init(current ?? undefined), message)
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotRadioMessage({ group, message: inner }),
	)
	const value = next.model.maybeValue
	if (value._tag === "None" || value.value === current) return { model, commands }
	const edited = editForm(model, context, (form) => {
		if (group === "signal") {
			const signal = decodeSignal(value.value)
			return signal._tag === "Some" ? setBuiltinSignal(form, signal.value) : form
		}
		const severity = decodeSeverity(value.value)
		return severity._tag === "Some" ? setSeverity(form, severity.value) : form
	})
	return withCommands(edited, commands)
}

const withCommands = (step: Return, commands: Return["commands"]): Return => ({
	...step,
	commands: [...(commands ?? []), ...(step.commands ?? [])],
})

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
	const edited = editForm(lifted, context, (form) => {
		if (id === "rule-comparator") {
			const comparator = decodeComparator(value)
			return comparator._tag === "Some" ? { ...form, comparator: comparator.value } : form
		}
		const reducer = decodeReducer(value)
		return reducer._tag === "Some" ? { ...form, rawQueryReducer: reducer.value } : form
	})
	return withCommands(edited, commands)
}

export const comboStep = (
	model: Model,
	context: PageContext,
	id: string,
	message: Combobox.Message,
): Return => {
	const current = model.combos[id] ?? Combobox.init(id, "multiple")
	const next = Combobox.update(current, message)
	const lifted: Model = { ...model, combos: { ...model.combos, [id]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotComboMessage({ id, message: inner }),
	)
	if (next.outMessage === undefined || next.outMessage._tag !== "ChangedSelection")
		return { model: lifted, commands }
	const selected = next.outMessage.selected
	return withCommands(
		editForm(lifted, context, (form) => setChips(form, id, selected)),
		commands,
	)
}

/** The rule's one query panel; its edits land on `queryBuilderDraft`. */
export const queryPanelStep = (model: Model, context: PageContext, message: QueryPanel.Message): Return => {
	const next = QueryPanel.update(model.queryPanels, message, panelInputsOf(model, context))
	const lifted: Model = { ...model, queryPanels: next.model }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotQueryPanelMessage({ message: inner }),
	)
	const out = next.outMessage
	if (out === undefined || out._tag !== "ChangedQuery") return { model: lifted, commands }
	const edited = editForm(lifted, context, (form) => ({
		...form,
		queryBuilderDraft: applyQueryChange(form.queryBuilderDraft, out.change),
	}))
	return withCommands(edited, commands)
}

export const chartStep = (model: Model, message: Chart.Message): Return => {
	const next = Chart.update(model.chart, message)
	return {
		model: { ...model, chart: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotChartMessage({ message: inner }),
		),
	}
}

/** The preview-only lookback: it re-runs the preview, never the rule being saved. */
export const timePickerStep = (model: Model, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotTimePickerMessage({ message: inner }),
	)
	const lifted = { ...model, timePicker: next.model }
	// TODO(alert-preview): keep a custom preview window too; only presets are stored here.
	if (next.outMessage?._tag !== "SelectedPreset") return { model: lifted, commands }
	// The clock read resolves the new preset into the preview window.
	return {
		model: { ...lifted, previewPreset: next.outMessage.presetValue },
		commands: [...commands, ReadEditorClock()],
	}
}
