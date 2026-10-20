import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { field, type FieldIds, fieldLabel, input, type FieldState } from "../../../ui/field"

// `<Field><FieldLabel htmlFor><Input id /></Field>` with the value in the Model: Base UI marks the
// field filled while it has text.

export const fieldIds = (id: string): FieldIds => ({ control: id, label: `${id}-label`, error: `${id}-error` })

export const stateFor = (value: string, isInvalid = false): FieldState => ({
	isInvalid,
	isDirty: false,
	isFilled: value.length > 0,
	isFocused: false,
	isTouched: false,
})

export const textField = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		id: string
		label: string
		value: string
		onInput: (value: string) => M
		type?: string
		placeholder?: string
		autoComplete?: string
		isDisabled?: boolean
		isInvalid?: boolean
		after?: ReadonlyArray<Html>
		attributes?: ReadonlyArray<Attribute<M>>
	}>,
): Html => {
	const state = stateFor(options.value, options.isInvalid ?? false)
	const ids = fieldIds(options.id)
	return field(h, { state }, [
		fieldLabel(h, { ids, state }, options.label),
		input(h, {
			ids,
			state,
			attributes: [
				...(options.type === undefined ? [] : [h.Type(options.type)]),
				...(options.autoComplete === undefined ? [] : [h.Autocomplete(options.autoComplete)]),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				h.Value(options.value),
				h.OnInput(options.onInput),
				...((options.isDisabled ?? false) ? [h.Disabled(true)] : []),
				...(options.attributes ?? []),
			],
		}),
		...(options.after ?? []),
	])
}
