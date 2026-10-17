import { cn } from "@maple/ui/lib/utils"
import { fieldErrorStyles, fieldLabelStyles, fieldStyles } from "@maple/ui/styles/ui/field"
import { inputControlChromeStyles, inputControlLayoutStyles, inputStyles } from "@maple/ui/styles/ui/input"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** Base UI's field state, which it mirrors as data attributes on every field part. */
export type FieldState = Readonly<{
	isInvalid: boolean
	isDirty: boolean
	isFilled: boolean
	isFocused: boolean
	isTouched: boolean
}>

const stateAttributes = <Message>(
	h: HtmlBuilder<Message>,
	state: FieldState,
): ReadonlyArray<Attribute<Message>> => [
	...(state.isDirty ? [h.DataAttribute("dirty", "")] : []),
	...(state.isFilled ? [h.DataAttribute("filled", "")] : []),
	...(state.isFocused ? [h.DataAttribute("focused", "")] : []),
	...(state.isInvalid ? [h.DataAttribute("invalid", "")] : []),
	...(state.isTouched ? [h.DataAttribute("touched", "")] : []),
]

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
			...stateAttributes(h, options.state),
		],
		children,
	)

export type FieldIds = Readonly<{ control: string; label: string; error: string }>

/** Base UI `Field.Label`, wired to the control by id. */
export const fieldLabel = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ ids: FieldIds; className?: string; state: FieldState }>,
	text: string,
): Html =>
	h.label(
		[
			h.Id(options.ids.label),
			h.For(options.ids.control),
			h.DataAttribute("slot", "field-label"),
			h.Class(cn(fieldLabelStyles, options.className)),
			...stateAttributes(h, options.state),
		],
		[text],
	)

/** `<Input>` inside a Base UI field: the control wrapper and the labelled native input. */
export const input = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ ids: FieldIds; state: FieldState; attributes: ReadonlyArray<Attribute<Message>> }>,
): Html =>
	h.span(
		[
			h.Class(cn(inputControlLayoutStyles, inputControlChromeStyles)),
			h.DataAttribute("size", "default"),
			h.DataAttribute("slot", "input-control"),
		],
		[
			h.input([
				h.Id(options.ids.control),
				h.DataAttribute("slot", "input"),
				...options.attributes,
				h.Class(cn(inputStyles)),
				h.AriaLabelledBy(options.ids.label),
				...(options.state.isInvalid
					? [h.AriaInvalid(true), h.AriaDescribedBy(options.ids.error)]
					: []),
				...stateAttributes(h, options.state),
			]),
		],
	)

/** Base UI `Field.Error` with `match`: always shown while rendered. */
export const fieldError = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ ids: FieldIds; className?: string; state: FieldState }>,
	text: string,
): Html =>
	h.div(
		[
			h.Id(options.ids.error),
			h.DataAttribute("slot", "field-error"),
			h.Role("alert"),
			h.Class(cn(fieldErrorStyles, options.className)),
			...stateAttributes(h, options.state),
		],
		[text],
	)
