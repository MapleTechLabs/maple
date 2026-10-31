import { TONE_TEXT } from "@maple/ui/lib/tone"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Autocomplete from "../../../ui/autocomplete"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { field, fieldDescription, type FieldIds, fieldLabel, input, type FieldState } from "../../../ui/field"
import * as Field from "../../../ui/field"
import { formDialog } from "../../../ui/form-dialog"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { panel } from "../../../ui/panel"
import * as SelectView from "../../../ui/select-view"
import {
	isFormValid,
	type KeyField,
	Message,
	type Model,
	operationOf,
	type SelectField,
	sourceContextOf,
} from "./mapping-dialog"

type H = HtmlBuilder<Message>

const IDLE: FieldState = { isInvalid: false, isDirty: false, isFilled: false, isFocused: false, isTouched: false }
const FILLED: FieldState = { ...IDLE, isFilled: true }

const ids = (name: string, hasDescription = false): FieldIds => {
	const base = { control: `mapping-${name}`, label: `mapping-${name}-label`, error: `mapping-${name}-error` }
	return hasDescription ? { ...base, description: `mapping-${name}-description` } : base
}

const CONTEXT_OPTIONS = [
	{ value: "span", label: "Span attribute", icon: "BracketsCurlyIcon" },
	{ value: "resource", label: "Resource attribute", icon: "CubeIcon" },
] as const
const OPERATION_OPTIONS = [
	{ value: "copy", label: "Copy", lead: ["Copy "], note: "(keep source key)", icon: "CopyIcon", tone: TONE_TEXT.info },
	{ value: "move", label: "Move", lead: ["Move", " "], note: "(remove source key)", icon: "ArrowRightFromLineIcon", tone: TONE_TEXT.warn },
] as const

const selectField = (
	h: H,
	model: Model,
	options: Readonly<{
		field: SelectField
		label: string
		entries: ReadonlyArray<SelectView.SelectOption>
		renderValue: (value: string) => ReadonlyArray<Html | string>
		renderItem: (option: SelectView.SelectOption) => ReadonlyArray<Html | string>
		after?: ReadonlyArray<Html>
	}>,
): Html =>
	h.submodel({
		slotId: `mapping-${options.field}-select`,
		model: model[options.field],
		view: SelectView.view,
		toParentMessage: (message) => Message.GotSelectMessage({ field: options.field, message }),
		viewInputs: {
			entries: options.entries.map((item): SelectView.SelectEntry => ({ _tag: "Item", item })),
			className: "w-full",
			ariaLabel: options.label,
			renderValue: options.renderValue,
			renderItem: options.renderItem,
			toView: (parts) =>
				field(h, { state: FILLED }, [
					fieldLabel(h, { ids: ids(options.field), state: FILLED }, options.label),
					...parts,
					...(options.after ?? []),
				]),
		},
	})

const keyField = (h: H, model: Model, name: KeyField, label: string, placeholder: string, keys: ReadonlyArray<string>): Html =>
	h.submodel({
		slotId: `mapping-${name}`,
		model: model[name],
		view: Autocomplete.view,
		toParentMessage: (message) => Message.GotKeyMessage({ field: name, message }),
		viewInputs: {
			items: keys,
			ariaLabel: label,
			placeholder,
			emptyText: "No matching attributes. Press Enter to use as typed",
			hasStartAddon: false,
			hasClear: true,
			toView: ({ field: control, rest }) =>
				field(h, { state: IDLE }, [fieldLabel(h, { ids: ids(name), state: IDLE }, label), control, ...rest]),
		},
	})

const contextRow = (h: H, value: string) => {
	const option = CONTEXT_OPTIONS.find((entry) => entry.value === value) ?? CONTEXT_OPTIONS[0]
	return [
		h.span(
			[h.Class("flex items-center gap-2")],
			[icon(h, option.icon, { className: "text-muted-foreground" }), option.label],
		),
	]
}

const preview = (h: H, model: Model): ReadonlyArray<Html> => {
	const source = model.sourceKey.inputValue.trim()
	const target = model.targetKey.inputValue.trim()
	if (source.length === 0 || target.length === 0) return []
	const operation = OPERATION_OPTIONS.find((entry) => entry.value === operationOf(model)) ?? OPERATION_OPTIONS[0]
	return [
		panel(h, { tone: "muted", className: "px-3 py-2.5" }, [
			eyebrow(h, { as: "div", className: "mb-1.5" }, ["Preview"]),
			h.div(
				[h.Class("flex flex-wrap items-center gap-1.5 text-sm")],
				[
					inlineCode(h, { variant: "plain" }, [source]),
					icon(h, "ArrowRightIcon", { size: 12, className: "text-muted-foreground shrink-0" }),
					inlineCode(h, { variant: "plain", className: "text-foreground" }, [target]),
					badge(h, { variant: operation.value === "copy" ? "info" : "warn", className: "ml-1 gap-1" }, [
						icon(h, operation.icon, { size: 12 }),
						operation.label,
					]),
				],
			),
		]),
	]
}

export const view = Submodel.defineView<Model, Message, Readonly<{ slotId: string }>>((model, inputs, h) => {
	const scope = sourceContextOf(model)
	const sourceKeys = AsyncData.getOrElse(scope === "span" ? model.spanKeys : model.resourceKeys, () => [])
	const spanKeys = AsyncData.getOrElse(model.spanKeys, () => [])
	const nameState = Field.stateOf(model.name, false)
	return formDialog(h, {
		slotId: inputs.slotId,
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		title: model.editing === null ? "Add attribute mapping" : "Edit attribute mapping",
		description:
			"The value at the source key is written to the target span attribute. An existing target key is never overwritten.",
		onSubmit: Message.ClickedSave(),
		submitLabel: model.editing === null ? "Add mapping" : "Save changes",
		isPending: model.isSaving,
		isSubmitDisabled: !isFormValid(model),
		fields: [
			field(h, { state: nameState }, [
				fieldLabel(h, { ids: ids("name"), state: nameState }, "Name"),
				input(h, {
					ids: ids("name"),
					state: nameState,
					attributes: [
						h.Placeholder("e.g. Normalize HTTP status code"),
						...Field.controlAttributes(h, model.name, (message) => Message.GotNameMessage({ message })),
					],
				}),
			]),
			selectField(h, model, {
				field: "sourceContext",
				label: "Source context",
				entries: CONTEXT_OPTIONS,
				renderValue: (value) => contextRow(h, value),
				renderItem: (option) => contextRow(h, option.value),
			}),
			keyField(h, model, "sourceKey", "Source key", "e.g. http.status_code", sourceKeys),
			keyField(h, model, "targetKey", "Target span attribute key", "e.g. http.response.status_code", spanKeys),
			selectField(h, model, {
				field: "operation",
				label: "Operation",
				entries: OPERATION_OPTIONS,
				renderValue: (value) => {
					const option = OPERATION_OPTIONS.find((entry) => entry.value === value) ?? OPERATION_OPTIONS[0]
					return [h.span([h.Class("flex items-center gap-2")], [icon(h, option.icon, { className: option.tone }), option.label])]
				},
				renderItem: (item) => {
					const option = OPERATION_OPTIONS.find((entry) => entry.value === item.value) ?? OPERATION_OPTIONS[0]
					return [
						h.span(
							[h.Class("flex items-center gap-2")],
							[
								icon(h, option.icon, { className: option.tone }),
								h.span([], [...option.lead, h.span([h.Class("text-muted-foreground")], [option.note])]),
							],
						),
					]
				},
				after:
					scope === "resource" && operationOf(model) === "move"
						? [
								fieldDescription(
									h,
									{ ids: ids("operation", true), state: FILLED },
									"Move behaves as Copy for resource attributes: a resource attribute is shared across every span in a batch and is never deleted.",
								),
							]
						: [],
			}),
			...preview(h, model),
		],
	})
})
