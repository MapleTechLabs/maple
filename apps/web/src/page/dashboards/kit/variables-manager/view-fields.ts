import type { Html, HtmlBuilder } from "foldkit/html"
import * as Field from "../../../../ui/field"
import {
	field,
	fieldDescription,
	type FieldIds,
	fieldError,
	fieldLabel,
	type FieldState,
} from "../../../../ui/field"
import { input } from "../../../../ui/input"
import * as SelectView from "../../../../ui/select-view"
import type * as Select from "../../../../ui/select"
import { textarea } from "../../../../ui/textarea"
import { type FormField, Message, type Model } from "./model"

// The `<Field className="items-stretch gap-1.5">` cells of `VariableForm`.

type H = HtmlBuilder<Message>

export const FIELD_CLASS = "items-stretch gap-1.5"
const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}

export const idsOf = (model: Model, name: string, withDescription = false): FieldIds => {
	const base = `${model.dialog.id}-${name}`
	const ids = { control: base, label: `${base}-label`, error: `${base}-error` }
	return withDescription ? { ...ids, description: `${base}-description` } : ids
}

export type TextFieldOptions = Readonly<{
	field: FormField
	label: string
	placeholder: string
	isInvalid?: boolean
	/** Shown under the input: the field error, else the description. */
	error?: string | null
	description?: ReadonlyArray<Html | string> | null
	isTextarea?: boolean
	autoFocus?: boolean
}>

export const textField = (h: H, model: Model, options: TextFieldOptions): Html => {
	const fieldModel = model[options.field]
	const isInvalid = options.isInvalid ?? false
	// Only the input is invalid (`aria-invalid`); the Base UI field root is not.
	const state = Field.stateOf(fieldModel, false)
	const hasDescription =
		options.error === null && options.description !== undefined && options.description !== null
	const ids = idsOf(model, options.field, hasDescription)
	const wrap = (message: Field.Message) => Message.GotFieldMessage({ field: options.field, message })
	const control =
		options.isTextarea === true
			? textarea(h, {
					id: ids.control,
					className: "min-h-16 text-xs",
					attributes: [
						h.Placeholder(options.placeholder),
						h.Value(fieldModel.value),
						h.OnInput((value) => wrap(Field.Message.ChangedValue({ value }))),
						h.OnFocus(wrap(Field.Message.FocusedControl())),
						h.OnBlur(wrap(Field.Message.BlurredControl())),
						h.AriaLabelledBy(ids.label),
					],
				})
			: input(h, {
					id: ids.control,
					size: "sm",
					fieldState: state,
					attributes: [
						h.Placeholder(options.placeholder),
						...Field.controlAttributes(h, fieldModel, wrap),
						h.AriaLabelledBy(ids.label),
						...(options.error !== undefined && options.error !== null
							? [h.AriaDescribedBy(ids.error)]
							: ids.description === undefined
								? []
								: [h.AriaDescribedBy(ids.description)]),
						...(isInvalid ? [h.AriaInvalid(true)] : []),
						...(options.autoFocus === true ? [h.Autofocus(true)] : []),
					],
				})
	const after =
		options.error !== undefined && options.error !== null
			? [fieldError(h, { ids, state, className: "text-2xs" }, options.error)]
			: hasDescription && options.description !== undefined && options.description !== null
				? [fieldDescription(h, { ids, state, className: "text-2xs" }, options.description)]
				: []
	return field(h, { className: FIELD_CLASS, state }, [
		fieldLabel(h, { ids, state, className: "text-xs" }, options.label),
		control,
		...after,
	])
}

export const selectField = (
	h: H,
	model: Model,
	options: Readonly<{
		key: "typeSelect" | "sourceSelect" | "metricTypeSelect"
		label: string
		entries: ReadonlyArray<SelectView.SelectEntry>
		wrap: (message: Select.Message) => Message
	}>,
): Html => {
	const ids = idsOf(model, options.key)
	return h.submodel({
		slotId: `${model.dialog.id}-${options.key}`,
		model: model[options.key],
		view: SelectView.view,
		toParentMessage: options.wrap,
		viewInputs: {
			entries: options.entries,
			size: "sm",
			labelledBy: ids.label,
			toView: (parts) =>
				field(h, { className: FIELD_CLASS, state: IDLE }, [
					fieldLabel(h, { ids, state: IDLE, className: "text-xs" }, options.label),
					...parts,
				]),
		},
	})
}

export const itemsOf = (
	items: ReadonlyArray<SelectView.SelectOption>,
): ReadonlyArray<SelectView.SelectEntry> => items.map((item) => ({ _tag: "Item", item }))
