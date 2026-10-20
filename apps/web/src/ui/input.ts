import { cn } from "@maple/ui/lib/utils"
import {
	inputControlChromeStyles,
	inputControlLayoutStyles,
	inputLgStyles,
	inputSearchStyles,
	inputSmStyles,
	inputStyles,
} from "@maple/ui/styles/ui/input"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** Base UI's field state, which it mirrors as data attributes on every field part. */
export type FieldState = Readonly<{
	isInvalid: boolean
	isDirty: boolean
	isFilled: boolean
	isFocused: boolean
	isTouched: boolean
}>

export const fieldStateAttributes = <Message>(
	h: HtmlBuilder<Message>,
	state: FieldState,
): ReadonlyArray<Attribute<Message>> => [
	...(state.isDirty ? [h.DataAttribute("dirty", "")] : []),
	...(state.isFilled ? [h.DataAttribute("filled", "")] : []),
	...(state.isFocused ? [h.DataAttribute("focused", "")] : []),
	...(state.isInvalid ? [h.DataAttribute("invalid", "")] : []),
	...(state.isTouched ? [h.DataAttribute("touched", "")] : []),
]

export type InputSize = "sm" | "default" | "lg"

/** The inner `<input>` classes, shared with Combobox/Autocomplete (`<Input nativeInput>`). */
export const inputControlClassName = (size: InputSize, type?: string, controlClassName?: string): string =>
	cn(
		inputStyles,
		size === "sm" && inputSmStyles,
		size === "lg" && inputLgStyles,
		type === "search" && inputSearchStyles,
		controlClassName,
	)

export type InputOptions<Message> = Readonly<{
	/** Base UI's `useId` (`base-ui-_r_N_`), or the field control id. */
	id: string
	size?: InputSize
	type?: string
	className?: string
	controlClassName?: string
	isUnstyled?: boolean
	isDisabled?: boolean
	/** Set by a surrounding Field; mirrored as data attributes on the input. */
	fieldState?: FieldState
	attributes?: ReadonlyArray<Attribute<Message>>
}>

/** `<Input>` from @maple/ui: the `input-control` span around Base UI's input. */
export const input = <Message>(h: HtmlBuilder<Message>, options: InputOptions<Message>): Html => {
	const size = options.size ?? "default"
	const isDisabled = options.isDisabled ?? false
	return h.span(
		[
			h.Class(
				cn(
					inputControlLayoutStyles,
					!(options.isUnstyled ?? false) && inputControlChromeStyles,
					options.className,
				),
			),
			h.DataAttribute("size", size),
			h.DataAttribute("slot", "input-control"),
		],
		[
			h.input([
				h.Id(options.id),
				h.DataAttribute("slot", "input"),
				...(options.type === undefined ? [] : [h.Type(options.type)]),
				...(options.attributes ?? []),
				h.Class(inputControlClassName(size, options.type, options.controlClassName)),
				...(isDisabled ? [h.DataAttribute("disabled", ""), h.Disabled(true)] : []),
				...(options.fieldState === undefined ? [] : fieldStateAttributes(h, options.fieldState)),
			]),
		],
	)
}
