import { cn } from "@maple/ui/lib/utils"
import {
	listRowBodyStyles,
	listRowLeadingStyles,
	listRowMetaStyles,
	listRowTitleStyles,
	listRowTrailingStyles,
	listRowVariants,
	rowSelectedClass,
} from "@maple/ui/styles/ui/list-row"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/list-row.tsx: icon + title + meta + trailing row.

type Child = Html | string

export interface ListRowOptions {
	readonly density?: "compact" | "default"
	/** Hairline between rows (the last row drops it). */
	readonly divided?: boolean
	readonly selected?: boolean
	readonly leading?: Child
	readonly title: Child
	/** Secondary line under the title. */
	readonly meta?: Child
	/** One child, or several (a fragment) laid out by the trailing slot. */
	readonly trailing?: Child | ReadonlyArray<Child>
	readonly className?: string
	/** `render={<Link />}`: the row is a link to this URL. */
	readonly href?: string
	/** `render={<li />}`: the row is a list item. */
	readonly as?: "li"
}

/** `render={<button type="button" onClick />}`: the row is a button dispatching `onClick`. */
export interface ListRowButtonOptions<M> extends ListRowOptions {
	readonly onClick: M
}

const leadingSlot = <M>(h: HtmlBuilder<M>, leading: Child): Html =>
	h.span([h.Class(listRowLeadingStyles), h.DataAttribute("slot", "list-row-leading")], [leading])

const trailingSlot = <M>(h: HtmlBuilder<M>, trailing: Child | ReadonlyArray<Child>): Html =>
	h.span(
		[h.Class(listRowTrailingStyles), h.DataAttribute("slot", "list-row-trailing")],
		typeof trailing === "string" || !Array.isArray(trailing) ? [trailing] : trailing,
	)

/** One class attribute per row (S4: rows are repeated). */
export const listRow = <M>(
	h: HtmlBuilder<M>,
	options: ListRowOptions | ListRowButtonOptions<M>,
	extra: ReadonlyArray<Attribute<M>> = [],
): Html => {
	const attributes = [
		...(options.selected === true ? [h.AriaCurrent("true"), h.DataAttribute("selected", "")] : []),
		h.Attribute(
			"class",
			cn(
				listRowVariants({ density: options.density, divided: options.divided ?? false }),
				options.selected !== undefined && rowSelectedClass(options.selected),
				options.className,
			),
		),
		h.DataAttribute("slot", "list-row"),
	]
	const children = [
		...(options.leading === undefined ? [] : [leadingSlot(h, options.leading)]),
		h.span(
			[h.Attribute("class", listRowBodyStyles)],
			[
				h.span(
					[h.Attribute("class", listRowTitleStyles), h.DataAttribute("slot", "list-row-title")],
					[options.title],
				),
				...(options.meta === undefined
					? []
					: [
							h.span(
								[
									h.Attribute("class", listRowMetaStyles),
									h.DataAttribute("slot", "list-row-meta"),
								],
								[options.meta],
							),
						]),
			],
		),
		...(options.trailing === undefined ? [] : [trailingSlot(h, options.trailing)]),
	]
	if ("onClick" in options)
		return h.button([...attributes, ...extra, h.Type("button"), h.OnClick(options.onClick)], children)
	return options.href !== undefined
		? h.a([h.Href(options.href), ...attributes, ...extra], children)
		: options.as === "li"
			? h.li([...attributes, ...extra], children)
			: h.div([...attributes, ...extra], children)
}
