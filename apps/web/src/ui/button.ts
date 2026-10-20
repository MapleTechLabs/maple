import { cn } from "@maple/ui/lib/utils"
import { buttonLoadingIndicatorStyles, buttonVariants } from "@maple/ui/styles/ui/button"
import { spinnerStyles } from "@maple/ui/styles/ui/spinner"
import type { VariantProps } from "class-variance-authority"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"

export type ButtonOptions<Message> = VariantProps<typeof buttonVariants> &
	Readonly<{
		className?: string
		type?: "button" | "submit"
		isLoading?: boolean
		isDisabled?: boolean
		/** `data-slot`; wrappers (IconButton, TooltipTrigger) override Button's own. */
		slot?: string
		attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
	}>

/** `<Button>`: the same class composition, attributes and loading spinner as @maple/ui. */
export const button = <Message>(
	h: HtmlBuilder<Message>,
	options: ButtonOptions<Message>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const isLoading = options.isLoading ?? false
	return h.button(
		[
			h.Type(options.type ?? "button"),
			h.Class(
				cn(
					buttonVariants({
						className: options.className,
						size: options.size,
						variant: options.variant,
					}),
				),
			),
			...(isLoading ? [h.AriaDisabled(true), h.DataAttribute("loading", "")] : []),
			h.DataAttribute("slot", options.slot ?? "button"),
			...(isLoading || (options.isDisabled ?? false) ? [h.Disabled(true)] : []),
			...(options.attributes ?? []),
		],
		[
			...children,
			...(isLoading
				? [
						icon(h, "LoaderIcon", {
							className: cn(spinnerStyles, buttonLoadingIndicatorStyles),
							attributes: [
								h.AriaHidden(true),
								h.AriaLabel("Loading"),
								h.Role("status"),
								h.DataAttribute("slot", "button-loading-indicator"),
							],
						}),
					]
				: []),
		],
	)
}

/** `<Button render={<Link to=... />}>`: the button classes on an anchor, which the router follows. */
export const linkButton = <Message>(
	h: HtmlBuilder<Message>,
	options: Omit<ButtonOptions<Message>, "type" | "isLoading" | "isDisabled"> & Readonly<{ href: string }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.a(
		[
			h.Class(
				cn(
					buttonVariants({
						className: options.className,
						size: options.size,
						variant: options.variant,
					}),
				),
			),
			h.DataAttribute("slot", options.slot ?? "button"),
			h.Href(options.href),
			...(options.attributes ?? []),
		],
		children,
	)
