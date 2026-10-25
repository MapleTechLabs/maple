import { cn } from "@maple/ui/lib/utils"
import {
	itemActionsStyles,
	itemContentStyles,
	itemDescriptionStyles,
	itemGroupStyles,
	itemMediaVariants,
	itemTitleStyles,
	itemVariants,
} from "@maple/ui/styles/ui/item"
import type { VariantProps } from "class-variance-authority"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/item.tsx. `ItemSeparator` waits for the Separator port.

type Children = ReadonlyArray<Html | string>
type ItemVariant = NonNullable<VariantProps<typeof itemVariants>["variant"]>
type ItemSize = NonNullable<VariantProps<typeof itemVariants>["size"]>

export const itemGroup = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.div(
		[h.Role("list"), h.DataAttribute("slot", "item-group"), h.Class(cn(itemGroupStyles, className))],
		children,
	)

/** `Item`; Base UI's `useRender` state writes `data-slot`, `data-variant` and `data-size`. */
export const item = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly variant?: ItemVariant
		readonly size?: ItemSize
		readonly className?: string
		/** `render={<li />}`. */
		readonly tag?: "div" | "li"
	},
	children: Children,
): Html => {
	const variant = options.variant ?? "default"
	const size = options.size ?? "default"
	return h[options.tag ?? "div"](
		[
			h.Class(cn(itemVariants({ variant, size, className: options.className }))),
			h.DataAttribute("slot", "item"),
			h.DataAttribute("variant", variant),
			h.DataAttribute("size", size),
		],
		children,
	)
}

export const itemMedia = <M>(
	h: HtmlBuilder<M>,
	options: { readonly variant?: "default" | "icon" | "image"; readonly className?: string },
	children: Children,
): Html => {
	const variant = options.variant ?? "default"
	return h.div(
		[
			h.DataAttribute("slot", "item-media"),
			h.DataAttribute("variant", variant),
			h.Class(cn(itemMediaVariants({ variant, className: options.className }))),
		],
		children,
	)
}

const part =
	(styles: string, slot: string) =>
	<M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
		h.div([h.DataAttribute("slot", slot), h.Class(cn(styles, className))], children)

export const itemContent = part(itemContentStyles, "item-content")
export const itemTitle = part(itemTitleStyles, "item-title")
export const itemActions = part(itemActionsStyles, "item-actions")

/** `title`: the native tooltip a truncated description carries. */
export const itemDescription = <M>(
	h: HtmlBuilder<M>,
	children: Children,
	className?: string,
	title?: string,
): Html =>
	h.p(
		[
			h.DataAttribute("slot", "item-description"),
			h.Class(cn(itemDescriptionStyles, className)),
			...(title === undefined ? [] : [h.Title(title)]),
		],
		children,
	)
