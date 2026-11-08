import type { Html, HtmlBuilder } from "foldkit/html"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel, type FieldState, input } from "@maple/views/ui/field"
import { type DraftField, Message } from "./model"

// One labelled text input of the connect form, with its hint and error.

type H = HtmlBuilder<Message>

export const ids = (name: string): FieldIds => ({
	control: `data-source-${name}`,
	label: `data-source-${name}-label`,
	error: `data-source-${name}-error`,
	description: `data-source-${name}-description`,
})

export const stateOf = (value: string, error: string | undefined): FieldState => ({
	isInvalid: error !== undefined,
	isDirty: false,
	isFilled: value !== "",
	isFocused: false,
	isTouched: false,
})

export type TextFieldOptions = Readonly<{
	name: DraftField
	label: string
	value: string
	error: string | undefined
	description?: string
	placeholder?: string
	type?: string
	isDisabled: boolean
}>

export const textField = (h: H, options: TextFieldOptions): Html => {
	const state = stateOf(options.value, options.error)
	const fieldIds = ids(options.name)
	return field(h, { state }, [
		fieldLabel(h, { ids: fieldIds, state }, options.label),
		input(h, {
			ids: fieldIds,
			state,
			isDisabled: options.isDisabled,
			attributes: [
				h.Value(options.value),
				...(options.type === undefined ? [] : [h.Type(options.type)]),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				h.OnInput((value) => Message.ChangedField({ field: options.name, value })),
			],
		}),
		...(options.description === undefined ? [] : [fieldDescription(h, { ids: fieldIds, state }, options.description)]),
		...(options.error === undefined ? [] : [fieldError(h, { ids: fieldIds, state }, options.error)]),
	])
}

