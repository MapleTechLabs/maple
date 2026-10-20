import { CATEGORY_LABELS } from "../../../components/code-review/code-review-format"
import type { Html, HtmlBuilder, TextareaAttribute } from "foldkit/html"
import * as Checkbox from "../../../ui/checkbox"
import { type FieldIds, type FieldState, field, fieldDescription, fieldLabel } from "../../../ui/field"
import { input } from "../../../ui/input"
import * as Switch from "../../../ui/switch"
import { textarea } from "../../../ui/textarea"
import { Message, type Model, parentCategories, type TextField } from "./form"
import { ALL_CATEGORIES } from "./state"

// The form's text fields and lenses (`ReviewRulesForm`).

type H = HtmlBuilder<Message>

export const idsOf = (model: Model, name: string): FieldIds => ({
	control: `${model.id}-${name}`,
	label: `${model.id}-${name}-label`,
	error: `${model.id}-${name}-error`,
	description: `${model.id}-${name}-description`,
})

/** Base UI's field state for a text control: dirty against what it was built with. */
export const textState = (model: Model, name: TextField): FieldState => ({
	isInvalid: false,
	isDirty: model.state[name] !== model.saved[name],
	isFilled: model.state[name] !== "",
	isFocused: model.focused === name,
	isTouched: model.touched.includes(name),
})

/** Field state of a select or switch: filled while it holds a value. */
export const valueState = (isFilled: boolean): FieldState => ({
	isInvalid: false,
	isDirty: false,
	isFilled,
	isFocused: false,
	isTouched: false,
})

/** `fieldStateAttributes` typed for a textarea (no `InnerHTML`). */
const textareaStateAttributes = (h: H, state: FieldState): ReadonlyArray<TextareaAttribute<Message>> => [
	...(state.isDirty ? [h.DataAttribute("dirty", "")] : []),
	...(state.isFilled ? [h.DataAttribute("filled", "")] : []),
	...(state.isFocused ? [h.DataAttribute("focused", "")] : []),
	...(state.isTouched ? [h.DataAttribute("touched", "")] : []),
]

const textHandlers = (h: H, name: TextField) => [
	h.OnInput((value) => Message.ChangedText({ field: name, value })),
	h.OnFocus(Message.FocusedText({ field: name })),
	h.OnBlur(Message.BlurredText({ field: name })),
]

export type TextFieldOptions = Readonly<{
	name: TextField
	slug: string
	label: string
	placeholder: string
	controlClassName: string
	maxLength?: number
	description: ReadonlyArray<Html | string>
}>

/** A `<Field>` with a small `<Textarea>`. */
export const textareaField = (h: H, model: Model, options: TextFieldOptions): Html => {
	const ids = idsOf(model, options.slug)
	const state = textState(model, options.name)
	return field(h, { className: "items-stretch", state }, [
		fieldLabel(h, { ids, state }, options.label),
		textarea(h, {
			id: ids.control,
			size: "sm",
			controlClassName: options.controlClassName,
			isDisabled: model.isSaving,
			attributes: [
				h.AriaDescribedBy(ids.description ?? ""),
				h.AriaLabelledBy(ids.label),
				...textareaStateAttributes(h, state),
				...(options.maxLength === undefined
					? []
					: [h.Attribute("maxlength", String(options.maxLength))]),
				h.Placeholder(options.placeholder),
				h.Value(model.state[options.name]),
				...textHandlers(h, options.name),
			],
		}),
		fieldDescription(h, { ids, state }, options.description),
	])
}

export type NumberFieldOptions = Readonly<{
	name: TextField
	slug: string
	label: string
	max: number
	placeholder: string
	description: ReadonlyArray<Html | string>
}>

/** A `<Field>` with a numeric `<Input>`. */
export const numberField = (h: H, model: Model, options: NumberFieldOptions): Html => {
	const ids = idsOf(model, options.slug)
	const state = textState(model, options.name)
	return field(h, { className: "items-stretch", state }, [
		fieldLabel(h, { ids, state }, options.label),
		input(h, {
			id: ids.control,
			type: "number",
			fieldState: state,
			isDisabled: model.isSaving,
			attributes: [
				h.AriaDescribedBy(ids.description ?? ""),
				h.AriaLabelledBy(ids.label),
				h.Attribute("inputmode", "numeric"),
				h.Attribute("max", String(options.max)),
				h.Attribute("min", "1"),
				h.Placeholder(options.placeholder),
				h.Attribute("step", "1"),
				h.Value(model.state[options.name]),
				...textHandlers(h, options.name),
			],
		}),
		fieldDescription(h, { ids, state }, options.description),
	])
}

/** The lenses: a checkbox per category, or the organization's while the switch inherits them. */
export const lenses = (h: H, model: Model): Html => {
	const isInherited = model.state.categories === null
	const current = model.state.categories ?? parentCategories(model)
	const isRepository = model.mode === "repository"
	return h.fieldset(
		[h.Class("flex flex-col gap-2")],
		[
			h.legend(
				[h.Class("mb-2 flex w-full items-center justify-between gap-3 text-sm font-medium")],
				[
					"Lenses",
					...(isRepository
						? [
								h.label(
									[
										h.Class(
											"flex items-center gap-2 text-xs font-normal text-muted-foreground",
										),
										h.Id(`${model.id}-inherit-lenses-label`),
									],
									[
										"Use the organization's",
										...Switch.switchControl(h, {
											id: `${model.id}-inherit-lenses`,
											inputId: `${model.id}-inherit-lenses-input`,
											isChecked: isInherited,
											isDisabled: model.isSaving,
											labelledBy: `${model.id}-inherit-lenses-label`,
											onToggle: Message.ToggledInheritCategories(),
										}),
									],
								),
							]
						: []),
				],
			),
			h.div(
				[h.Class("grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3")],
				ALL_CATEGORIES.map((category) => {
					const inputId = `${model.id}-lens-${category}`
					return h.label(
						[
							h.Key(category),
							h.Class("flex items-center gap-2 text-sm has-disabled:text-muted-foreground"),
							h.Id(Checkbox.labelId(inputId)),
						],
						[
							...Checkbox.view(h, {
								model: { isChecked: current.includes(category) },
								toParentMessage: () => Message.ToggledCategory({ category }),
								id: `${inputId}-root`,
								inputId,
								isDisabled: isInherited || model.isSaving,
							}),
							CATEGORY_LABELS[category],
						],
					)
				}),
			),
			h.p([h.Class("text-xs text-muted-foreground")], ["Issues are only filed under checked lenses."]),
		],
	)
}
