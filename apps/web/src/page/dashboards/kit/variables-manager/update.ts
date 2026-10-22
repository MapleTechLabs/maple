import { toQueryBuilderMetricType } from "@maple/query-model"
import { Command, type Update } from "foldkit"
import * as Dialog from "../../../../ui/dialog"
import * as Field from "../../../../ui/field"
import * as Select from "../../../../ui/select"
import {
	draftError,
	newVariable,
	SOURCE_ITEMS,
	sourceValueOf,
	VARIABLE_TYPES,
	METRIC_TYPES,
	withSourceValue,
	withType,
} from "./derive"
import { type FormField, Message, type Model, OutMessage, type Variable } from "./model"

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const idOf = (base: string, part: string) => `${base}-${part}`

const selectInit = (id: string, values: ReadonlyArray<string>, value: string) =>
	Select.init(id, { value, selectedIndex: values.indexOf(value) === -1 ? null : values.indexOf(value) })

/** The form's controls, read from the draft being edited (or blank when none is open). */
const formFor = (model: Model, drafts: ReadonlyArray<Variable>, index: number | null): Model => {
	const draft = index === null ? undefined : drafts[index]
	const base = model.dialog.id
	const source = draft?.type === "query" ? draft.source : undefined
	return {
		...model,
		drafts,
		editingIndex: index,
		name: Field.init(draft?.name ?? ""),
		label: Field.init(draft?.label ?? ""),
		defaultValue: Field.init(draft?.defaultValue ?? ""),
		options: Field.init(
			draft?.type === "custom" ? draft.options.map((option) => option.value).join(", ") : "",
		),
		attributeKey: Field.init(source === undefined || source.kind === "facet" ? "" : source.attributeKey),
		metricNames: Field.init(source?.kind === "metric" ? source.metricNames.join(", ") : ""),
		typeSelect: selectInit(idOf(base, "type"), VARIABLE_TYPES, draft?.type ?? "query"),
		sourceSelect: selectInit(
			idOf(base, "source"),
			SOURCE_ITEMS.map((item) => item.value),
			draft?.type === "query" ? sourceValueOf(draft) : "facet:service",
		),
		metricTypeSelect: selectInit(
			idOf(base, "metric-type"),
			METRIC_TYPES,
			source?.kind === "metric" ? source.metricType : "gauge",
		),
	}
}

export const init = (id: string): Model =>
	formFor(
		{
			dialog: Dialog.init(id, "dialog"),
			drafts: [],
			editingIndex: null,
			startedEmpty: false,
			name: Field.init(),
			label: Field.init(),
			defaultValue: Field.init(),
			options: Field.init(),
			attributeKey: Field.init(),
			metricNames: Field.init(),
			typeSelect: Select.init(idOf(id, "type"), { value: "query", selectedIndex: 0 }),
			sourceSelect: Select.init(idOf(id, "source"), { value: "facet:service", selectedIndex: 0 }),
			metricTypeSelect: Select.init(idOf(id, "metric-type"), { value: "gauge", selectedIndex: null }),
		},
		[],
		null,
	)

const wrapDialog = (message: Dialog.Message) => Message.GotDialogMessage({ message })

/** Remounted on every opening: the session starts from the saved variables. */
export const open = (model: Model, variables: ReadonlyArray<Variable>): Return => {
	const startedEmpty = variables.length === 0
	const opened = Dialog.open(model.dialog)
	const drafts = startedEmpty ? [newVariable()] : structuredClone(variables)
	return {
		model: {
			...formFor({ ...model, dialog: opened.model, startedEmpty }, drafts, startedEmpty ? 0 : null),
		},
		commands: Command.mapMessages(opened.commands ?? [], wrapDialog),
	}
}

const withDraft = (model: Model, update: (draft: Variable) => Variable): ReadonlyArray<Variable> =>
	model.drafts.map((draft, index) => (index === model.editingIndex ? update(draft) : draft))

const withLabel = (draft: Variable, value: string): Variable => {
	const { label: _label, ...rest } = draft
	return value === "" ? rest : { ...rest, label: value }
}

const withDefault = (draft: Variable, value: string): Variable => {
	const { defaultValue: _defaultValue, ...rest } = draft
	return value === "" ? rest : { ...rest, defaultValue: value }
}

/** A typed value lands in the draft, as the controlled inputs' `onChange` does. */
const applyField = (draft: Variable, field: FormField, value: string): Variable => {
	switch (field) {
		case "name":
			return { ...draft, name: value }
		case "label":
			return withLabel(draft, value)
		case "defaultValue":
			return withDefault(draft, value)
		case "options":
			return draft.type !== "custom"
				? draft
				: {
						...draft,
						options: value
							.split(",")
							.map((option) => option.trim())
							.filter((option) => option.length > 0)
							.map((option) => ({ value: option })),
					}
		case "attributeKey":
			return draft.type !== "query" || draft.source.kind === "facet"
				? draft
				: { ...draft, source: { ...draft.source, attributeKey: value } }
		case "metricNames":
			return draft.type !== "query" || draft.source.kind !== "metric"
				? draft
				: {
						...draft,
						source: { ...draft.source, metricNames: value.split(",").map((name) => name.trim()) },
					}
	}
}

const fieldStep = (model: Model, field: FormField, message: Field.Message): Return => {
	const next = Field.update(model[field], message)
	const updated = { ...model, [field]: next.model }
	return message._tag === "ChangedValue"
		? {
				model: {
					...updated,
					drafts: withDraft(updated, (draft) => applyField(draft, field, message.value)),
				},
			}
		: { model: updated }
}

/** A select step; a pick retypes the draft and re-reads the form from it (the inputs are controlled). */
const selectStep = (
	model: Model,
	key: "typeSelect" | "sourceSelect" | "metricTypeSelect",
	message: Select.Message,
	wrap: (message: Select.Message) => Message,
	apply: (draft: Variable, value: string) => Variable,
): Return => {
	const next = Select.update(model[key], message)
	const commands = Command.mapMessages(next.commands ?? [], wrap)
	const updated = { ...model, [key]: next.model }
	if (next.outMessage === undefined) return { model: updated, commands }
	const value = next.outMessage.value
	const drafts = withDraft(updated, (draft) => apply(draft, value))
	const refreshed = formFor(updated, drafts, updated.editingIndex)
	return {
		model: {
			...refreshed,
			name: updated.name,
			label: updated.label,
			defaultValue: updated.defaultValue,
			[key]: next.model,
		},
		commands,
	}
}

const applyType = (draft: Variable, value: string): Variable => {
	const type = VARIABLE_TYPES.find((candidate) => candidate === value)
	return type === undefined ? draft : withType(draft, type)
}

const applySource = (draft: Variable, value: string): Variable =>
	draft.type === "query" ? withSourceValue(draft, value) : draft

const applyMetricType = (draft: Variable, value: string): Variable => {
	const metricType = toQueryBuilderMetricType(value)
	return draft.type === "query" &&
		draft.source.kind === "metric" &&
		metricType !== undefined &&
		metricType !== null
		? { ...draft, source: { ...draft.source, metricType } }
		: draft
}

/** `move`: the expanded form follows its draft. */
const move = (model: Model, index: number, delta: -1 | 1): Return => {
	const target = index + delta
	const moved = model.drafts[index]
	if (moved === undefined || target < 0 || target >= model.drafts.length) return { model }
	const without = model.drafts.filter((_, i) => i !== index)
	const drafts = [...without.slice(0, target), moved, ...without.slice(target)]
	const current = model.editingIndex
	return {
		model: {
			...model,
			drafts,
			editingIndex: current === index ? target : current === target ? index : current,
		},
	}
}

const remove = (model: Model, index: number): Return => {
	const current = model.editingIndex
	return {
		model: {
			...model,
			drafts: model.drafts.filter((_, i) => i !== index),
			editingIndex:
				current === null ? null : current === index ? null : current > index ? current - 1 : current,
		},
	}
}

export const hasErrors = (model: Model): boolean =>
	model.drafts.some((draft, index) => draftError(draft, index, model.drafts) !== null)

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: inner }) => {
			const next = Dialog.update(model.dialog, inner)
			return {
				model: { ...model, dialog: next.model },
				commands: Command.mapMessages(next.commands ?? [], wrapDialog),
			}
		},
		GotFieldMessage: ({ field, message: inner }) => fieldStep(model, field, inner),
		GotTypeSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				"typeSelect",
				inner,
				(m) => Message.GotTypeSelectMessage({ message: m }),
				applyType,
			),
		GotSourceSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				"sourceSelect",
				inner,
				(m) => Message.GotSourceSelectMessage({ message: m }),
				applySource,
			),
		GotMetricTypeSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				"metricTypeSelect",
				inner,
				(m) => Message.GotMetricTypeSelectMessage({ message: m }),
				applyMetricType,
			),
		ToggledIncludeAll: () => ({
			model: {
				...model,
				drafts: withDraft(model, (draft) => {
					const { includeAll, ...rest } = draft
					return includeAll === true ? rest : { ...rest, includeAll: true }
				}),
			},
		}),
		ClickedMove: ({ index, delta }) => move(model, index, delta),
		ClickedEdit: ({ index }) => ({
			model: formFor(model, model.drafts, model.editingIndex === index ? null : index),
		}),
		ClickedDelete: ({ index }) => remove(model, index),
		ClickedAdd: () => ({ model: formFor(model, [...model.drafts, newVariable()], model.drafts.length) }),
		SubmittedForm: () => {
			if (hasErrors(model)) return { model }
			const closed = Dialog.close(model.dialog)
			return {
				model: { ...model, dialog: closed.model },
				commands: Command.mapMessages(closed.commands ?? [], wrapDialog),
				outMessage: OutMessage.SavedVariables({ variables: model.drafts }),
			}
		},
	})
