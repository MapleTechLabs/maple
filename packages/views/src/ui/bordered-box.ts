import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

export interface BorderedBoxOptions {
	/** `hidden` clips the children to the rounded corners; `x-auto` scrolls a wide table sideways. */
	readonly overflow: "hidden" | "x-auto"
	/** The card fill under the children. */
	readonly card?: boolean
	readonly className?: string
}

/** The classes of a bordered box, for an element the kit doesn't render. */
export const borderedBoxClass = (options: BorderedBoxOptions): string =>
	cn(
		"rounded-md border",
		options.overflow === "hidden" ? "overflow-hidden" : "overflow-x-auto",
		options.card === true && "bg-card",
		options.className,
	)

/** A rounded bordered box around a list, table or band, without a panel's header or padding. */
export const borderedBox = <M>(
	h: HtmlBuilder<M>,
	options: BorderedBoxOptions & {
		readonly as?: "div" | "section"
		readonly attributes?: ReadonlyArray<Attribute<M>>
	},
	children: ReadonlyArray<Html | string>,
): Html => {
	const attributes = [...(options.attributes ?? []), h.Class(borderedBoxClass(options))]
	return options.as === "section" ? h.section(attributes, children) : h.div(attributes, children)
}
