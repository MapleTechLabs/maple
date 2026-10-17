import { cn } from "@maple/ui/lib/utils"
import {
	textareaControlChromeStyles,
	textareaControlLayoutStyles,
	textareaLgStyles,
	textareaSmStyles,
	textareaStyles,
} from "@maple/ui/styles/ui/textarea"
import type { Html, HtmlBuilder, TextareaAttribute } from "foldkit/html"

export type TextareaOptions<Message> = Readonly<{
	/** Base UI's `useId` on the field control. */
	id: string
	size?: "sm" | "default" | "lg"
	className?: string
	controlClassName?: string
	isUnstyled?: boolean
	isDisabled?: boolean
	/** The initial text (`defaultValue`); the textarea stays uncontrolled. */
	defaultValue?: string
	attributes?: ReadonlyArray<TextareaAttribute<Message>>
}>

/** `<Textarea>` from @maple/ui: the `textarea-control` span around Base UI's field control. */
export const textarea = <Message>(h: HtmlBuilder<Message>, options: TextareaOptions<Message>): Html => {
	const size = options.size ?? "default"
	const isDisabled = options.isDisabled ?? false
	return h.span(
		[
			h.Class(
				cn(
					textareaControlLayoutStyles,
					!(options.isUnstyled ?? false) && textareaControlChromeStyles,
					options.className,
				),
			),
			h.DataAttribute("size", size),
			h.DataAttribute("slot", "textarea-control"),
		],
		[
			h.textarea([
				h.Id(options.id),
				...(options.attributes ?? []),
				h.Class(
					cn(
						textareaStyles,
						size === "sm" && textareaSmStyles,
						size === "lg" && textareaLgStyles,
						options.controlClassName,
					),
				),
				h.DataAttribute("slot", "textarea"),
				...(isDisabled ? [h.DataAttribute("disabled", ""), h.Disabled(true)] : []),
				...(options.defaultValue === undefined ? [] : [h.Value(options.defaultValue)]),
			]),
		],
	)
}
