import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `HStack` and `VStack`: a flex row (items centred by default) or column with its gap on the
// spacing scale, instead of a hand-written `flex items-center gap-2` string. `className` adds
// what the options don't cover (padding, borders, widths).

export type StackGap = "0" | "0.5" | "1" | "1.5" | "2" | "2.5" | "3" | "4" | "5" | "6" | "8"
export type StackAlign = "start" | "center" | "end" | "baseline" | "stretch"
export type StackJustify = "start" | "center" | "end" | "between"
export type StackElement = "div" | "span" | "section" | "header" | "footer" | "ul" | "li" | "nav"

const GAP = {
	"0": "gap-0",
	"0.5": "gap-0.5",
	"1": "gap-1",
	"1.5": "gap-1.5",
	"2": "gap-2",
	"2.5": "gap-2.5",
	"3": "gap-3",
	"4": "gap-4",
	"5": "gap-5",
	"6": "gap-6",
	"8": "gap-8",
} as const satisfies Record<StackGap, string>

const ALIGN = {
	start: "items-start",
	center: "items-center",
	end: "items-end",
	baseline: "items-baseline",
	stretch: "items-stretch",
} as const satisfies Record<StackAlign, string>

const JUSTIFY = {
	start: "justify-start",
	center: "justify-center",
	end: "justify-end",
	between: "justify-between",
} as const satisfies Record<StackJustify, string>

export type StackOptions<M> = Readonly<{
	gap?: StackGap
	align?: StackAlign
	justify?: StackJustify
	/** `flex-wrap` (rows only). */
	wrap?: boolean
	/** `min-w-0`, so a truncating child can shrink. */
	shrink?: boolean
	/** `flex-1`, to fill the parent's free space. */
	grow?: boolean
	/** `inline-flex` instead of `flex`. */
	inline?: boolean
	as?: StackElement
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

const stackClass = (direction: "row" | "col", options: Omit<StackOptions<never>, "as" | "attributes">) =>
	cn(
		(options.inline ?? false) ? "inline-flex" : "flex",
		direction === "col" && "flex-col",
		direction === "row" && ALIGN[options.align ?? "center"],
		direction === "col" && options.align !== undefined && ALIGN[options.align],
		options.justify === undefined ? undefined : JUSTIFY[options.justify],
		options.gap === undefined ? undefined : GAP[options.gap],
		(options.wrap ?? false) && "flex-wrap",
		(options.shrink ?? false) && "min-w-0",
		(options.grow ?? false) && "flex-1",
		options.className,
	)

const element = <M>(
	h: HtmlBuilder<M>,
	as: StackElement,
	attributes: ReadonlyArray<Attribute<M> | ChildAttribute>,
	children: ReadonlyArray<Html | string>,
): Html => {
	switch (as) {
		case "div":
			return h.div(attributes, children)
		case "span":
			return h.span(attributes, children)
		case "section":
			return h.section(attributes, children)
		case "header":
			return h.header(attributes, children)
		case "footer":
			return h.footer(attributes, children)
		case "ul":
			return h.ul(attributes, children)
		case "li":
			return h.li(attributes, children)
		case "nav":
			return h.nav(attributes, children)
	}
}

/** A flex row, items centred unless `align` says otherwise. */
export const hstack = <M>(
	h: HtmlBuilder<M>,
	options: StackOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html =>
	element(h, options.as ?? "div", [h.Class(stackClass("row", options)), ...(options.attributes ?? [])], children)

/** A flex column. */
export const vstack = <M>(
	h: HtmlBuilder<M>,
	options: StackOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html =>
	element(h, options.as ?? "div", [h.Class(stackClass("col", options)), ...(options.attributes ?? [])], children)
