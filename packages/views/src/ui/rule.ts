import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// Hairline rules: a `strip` (a band inside a panel or list, ruled off from its neighbours), a
// `dividedList` (a bordered box with a rule between its items) and a `fillRule`.

type Children = ReadonlyArray<Html | string>

export type StripKind = "head" | "foot" | "block" | "row" | "hoverRow" | "skeletonRow"

const STRIP = {
	/** A list's head band: its column labels, or a note above its rows. */
	head: "border-b px-4 py-2",
	/** A panel's foot band: a toggle or a "load more" under its rows. */
	foot: "border-t px-4 py-2.5",
	/** A padded block ruled off above on the subtle hairline (a card's second section, a footer). */
	block: "border-t border-border-subtle p-4",
	/** A list row on the subtle hairline, the last one unruled. */
	row: "border-b border-border-subtle px-4 py-2.5 last:border-0",
	/** A taller `row` that tints on hover and press. */
	hoverRow:
		"border-b border-border-subtle px-4 py-3 last:border-0 hover:bg-surface-sunken active:bg-surface-sunken",
	/** A 44px loading row of a list, the last one unruled. */
	skeletonRow: "h-11 border-b px-4 last:border-b-0",
} as const satisfies Record<StripKind, string>

/** The classes of a strip, for an element the kit doesn't render (an `hstack`, a table head). */
export const stripClass = (kind: StripKind, className?: string): string => cn(STRIP[kind], className)

/** A strip as a `div`. */
export const strip = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ kind: StripKind; className?: string; attributes?: ReadonlyArray<Attribute<M>> }>,
	children: Children,
): Html => h.div([h.Class(stripClass(options.kind, options.className)), ...(options.attributes ?? [])], children)

/** A rounded bordered list with a rule between its items (`ul`, `dl` or `div`). */
export const dividedList = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ as: "ul" | "dl" | "div"; attributes?: ReadonlyArray<Attribute<M>> }>,
	children: Children,
): Html => {
	const attributes = [...(options.attributes ?? []), h.Class("divide-y rounded-md border")]
	switch (options.as) {
		case "ul":
			return h.ul(attributes, children)
		case "dl":
			return h.dl(attributes, children)
		case "div":
			return h.div(attributes, children)
	}
}

/** A decorative hairline that fills the rest of a row, after a label or a heading. */
export const fillRule = <M>(h: HtmlBuilder<M>): Html => h.span([h.AriaHidden(true), h.Class("h-px grow bg-border")], [])
