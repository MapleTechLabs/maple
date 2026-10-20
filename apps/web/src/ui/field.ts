import { cn } from "@maple/ui/lib/utils"
import {
	fieldDescriptionStyles,
	fieldErrorStyles,
	fieldLabelStyles,
	fieldStyles,
} from "@maple/ui/styles/ui/field"
import { Schema } from "effect"
import type { Update } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { type FieldState, fieldStateAttributes, input as inputControl } from "./input"

export type { FieldState } from "./input"

/**
 * An uncontrolled Base UI field's state (`defaultValue`): what it holds, whether it has focus
 * and whether it was ever blurred. `stateOf` derives the `data-*` state every part mirrors.
 */

// MODEL

export const Model = Schema.Struct({
	initialValue: Schema.String,
	value: Schema.String,
	isFocused: Schema.Boolean,
	isTouched: Schema.Boolean,
})
export type Model = typeof Model.Type

export const init = (value = ""): Model => ({
	initialValue: value,
	value,
	isFocused: false,
	isTouched: false,
})

export const stateOf = (model: Model, isInvalid: boolean): FieldState => ({
	isInvalid,
	isDirty: model.value !== model.initialValue,
	isFilled: model.value !== "",
	isFocused: model.isFocused,
	isTouched: model.isTouched,
})

// MESSAGE

export const Message = defineMessageUnion({
	ChangedValue: { value: Schema.String },
	FocusedControl: {},
	BlurredControl: {},
})
export type Message = typeof Message.Type

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ChangedValue: ({ value }) => ({ model: modifyFields(model, { value: () => value }) }),
		FocusedControl: () => ({ model: modifyFields(model, { isFocused: () => true }) }),
		BlurredControl: () => ({
			model: modifyFields(model, { isFocused: () => false, isTouched: () => true }),
		}),
	})

/** The value and focus handlers a field's control reports through. */
export const controlAttributes = <P>(
	h: HtmlBuilder<P>,
	model: Model,
	toParentMessage: (message: Message) => P,
): ReadonlyArray<Attribute<P>> => [
	h.Value(model.value),
	h.OnInput((value) => toParentMessage(Message.ChangedValue({ value }))),
	h.OnFocus(toParentMessage(Message.FocusedControl())),
	h.OnBlur(toParentMessage(Message.BlurredControl())),
]

// VIEW

/** Base UI `Field.Root`. */
export const field = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string; state: FieldState }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			h.DataAttribute("slot", "field"),
			h.Class(cn(fieldStyles, options.className)),
			...fieldStateAttributes(h, options.state),
		],
		children,
	)

/** Base UI `useId`s of a field's parts; `description` only when a `FieldDescription` renders. */
export type FieldIds = Readonly<{ control: string; label: string; error: string; description?: string }>

/** Base UI `Field.Label`, wired to the control by id. */
export const fieldLabel = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ ids: FieldIds; className?: string; state: FieldState }>,
	text: string | ReadonlyArray<Html | string>,
): Html =>
	h.label(
		[
			h.Id(options.ids.label),
			h.For(options.ids.control),
			h.DataAttribute("slot", "field-label"),
			h.Class(cn(fieldLabelStyles, options.className)),
			...fieldStateAttributes(h, options.state),
		],
		typeof text === "string" ? [text] : text,
	)

/** The ids Base UI lists in the control's `aria-describedby`: the description, then a shown error. */
const describedBy = (ids: FieldIds, state: FieldState): ReadonlyArray<string> => [
	...(ids.description === undefined ? [] : [ids.description]),
	...(state.isInvalid ? [ids.error] : []),
]

/** `<Input>` inside a Base UI field: the control wrapper and the labelled native input. */
export const input = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{
		ids: FieldIds
		state: FieldState
		attributes: ReadonlyArray<Attribute<Message>>
		/** `<Input className>`: on the control wrapper, as @maple/ui puts it. */
		className?: string
	}>,
): Html => {
	const described = describedBy(options.ids, options.state)
	return inputControl(h, {
		id: options.ids.control,
		fieldState: options.state,
		className: options.className,
		attributes: [
			...options.attributes,
			h.AriaLabelledBy(options.ids.label),
			...(options.state.isInvalid ? [h.AriaInvalid(true)] : []),
			...(described.length === 0 ? [] : [h.AriaDescribedBy(described.join(" "))]),
		],
	})
}

/** Base UI `Field.Description`. */
export const fieldDescription = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ ids: FieldIds; className?: string; state: FieldState }>,
	text: string | ReadonlyArray<Html | string>,
): Html =>
	h.p(
		[
			...(options.ids.description === undefined ? [] : [h.Id(options.ids.description)]),
			h.DataAttribute("slot", "field-description"),
			h.Class(cn(fieldDescriptionStyles, options.className)),
			...fieldStateAttributes(h, options.state),
		],
		typeof text === "string" ? [text] : text,
	)

/** Base UI `Field.Error` with `match`: always shown while rendered. Callers add `role="alert"`. */
export const fieldError = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{
		ids: FieldIds
		className?: string
		state: FieldState
		attributes?: ReadonlyArray<Attribute<Message>>
	}>,
	text: string | ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[
			h.Id(options.ids.error),
			h.DataAttribute("slot", "field-error"),
			...(options.attributes ?? []),
			h.Class(cn(fieldErrorStyles, options.className)),
			...fieldStateAttributes(h, options.state),
		],
		typeof text === "string" ? [text] : text,
	)
