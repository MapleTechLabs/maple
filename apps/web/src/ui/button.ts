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

type Variant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>
type Size = NonNullable<VariantProps<typeof buttonVariants>["size"]>

// Local deltas on the shared variants: links read as links, and the small sizes keep a visible
// gap between the icon and its label.
const variantOverride = (variant: Variant): string | undefined =>
	variant === "link" ? "text-primary" : undefined

// Every variant dims to the same 50% when disabled; a loading button stays solid so its spinner shows.
const STATE_CLASSES = "disabled:opacity-50 data-loading:disabled:opacity-100"

const sizeOverride = (size: Size): string | undefined =>
	size === "sm" ? "gap-2" : size === "xs" ? "gap-1.5" : undefined

const buttonClasses = (options: VariantProps<typeof buttonVariants> & Readonly<{ className?: string }>) =>
	cn(
		buttonVariants({ size: options.size, variant: options.variant }),
		STATE_CLASSES,
		variantOverride(options.variant ?? "default"),
		sizeOverride(options.size ?? "default"),
		options.className,
	)

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
			h.Class(buttonClasses(options)),
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
							className: cn(spinnerStyles, buttonLoadingIndicatorStyles, "opacity-100"),
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
			h.Class(buttonClasses(options)),
			h.DataAttribute("slot", options.slot ?? "button"),
			h.Href(options.href),
			...(options.attributes ?? []),
		],
		children,
	)
