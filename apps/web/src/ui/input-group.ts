import { cn } from "@maple/ui/lib/utils"
import {
	inputGroupAddonVariants,
	inputGroupStyles,
	inputGroupTextStyles,
} from "@maple/ui/styles/ui/input-group"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, type ButtonOptions } from "./button"
import { input, type InputOptions } from "./input"

/** `<InputGroup>`: one bordered control holding addons and an unstyled input. */
export const inputGroup = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			h.Class(cn(inputGroupStyles, options.className)),
			h.DataAttribute("slot", "input-group"),
			h.Role("group"),
		],
		children,
	)

export type InputGroupAlign = "inline-start" | "inline-end" | "block-start" | "block-end"

/**
 * `<InputGroupAddon>`. A mousedown on the addon does not focus the input: the addon is decorative
 * text or icons and a button.
 */
export const inputGroupAddon = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ align?: InputGroupAlign; className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const align = options.align ?? "inline-start"
	return h.div(
		[
			h.Class(cn(inputGroupAddonVariants({ align }), options.className)),
			h.DataAttribute("align", align),
			h.DataAttribute("slot", "input-group-addon"),
		],
		children,
	)
}

export const inputGroupText = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html => h.span([h.Class(cn(inputGroupTextStyles, options.className))], children)

/** `<InputGroupButton>`: a ghost `xs` Button by default. */
export const inputGroupButton = <Message>(
	h: HtmlBuilder<Message>,
	options: ButtonOptions<Message>,
	children: ReadonlyArray<Html | string>,
): Html =>
	button(
		h,
		{
			...options,
			size: options.size ?? "xs",
			variant: options.variant ?? "ghost",
			slot: "input-group-button",
		},
		children,
	)

/** `<InputGroupInput>`: an unstyled Input. */
export const inputGroupInput = <Message>(h: HtmlBuilder<Message>, options: InputOptions<Message>): Html =>
	input(h, {
		...options,
		isUnstyled: true,
		// A value wider than the middle segment ends in an ellipsis instead of a clipped glyph.
		controlClassName: cn("text-ellipsis", options.controlClassName),
	})
