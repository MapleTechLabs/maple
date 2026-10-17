import { cn } from "@maple/ui/lib/utils"
import { buttonLoadingIndicatorStyles, buttonVariants } from "@maple/ui/styles/ui/button"
import { spinnerStyles } from "@maple/ui/styles/ui/spinner"
import type { VariantProps } from "class-variance-authority"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { loaderIcon } from "./icons"

export type ButtonOptions<Message> = VariantProps<typeof buttonVariants> &
	Readonly<{
		className?: string
		type?: "button" | "submit"
		isLoading?: boolean
		isDisabled?: boolean
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
			h.DataAttribute("slot", "button"),
			...(isLoading || (options.isDisabled ?? false) ? [h.Disabled(true)] : []),
			...(options.attributes ?? []),
		],
		[
			...children,
			...(isLoading
				? [
						loaderIcon(h, cn(spinnerStyles, buttonLoadingIndicatorStyles), [
							h.AriaHidden(true),
							h.AriaLabel("Loading"),
							h.Role("status"),
							h.DataAttribute("slot", "button-loading-indicator"),
						]),
					]
				: []),
		],
	)
}
