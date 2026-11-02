import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// `SelectableRow`: a bespoke row's frame (a `div`, or a link with `href`) with `listRow`'s selection
// lane and tint; a clickable one is a `pressable` with `selectedLane`. `className` owns the layout.

export type SelectableRowOptions<M> = Readonly<{
	isSelected: boolean
	/** The row is a link to this URL. */
	href?: string
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

export const selectableRow = <M>(
	h: HtmlBuilder<M>,
	options: SelectableRowOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const attributes = [
		h.Class(cn(rowSelectedClass(options.isSelected), options.className)),
		h.DataAttribute("slot", "selectable-row"),
		...(options.attributes ?? []),
	]
	return options.href === undefined
		? h.div(attributes, children)
		: h.a([...attributes, h.Href(options.href)], children)
}
