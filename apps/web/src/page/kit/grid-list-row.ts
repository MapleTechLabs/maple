import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/**
 * `GridListRow`: one `<li>` of a bordered grid list (the alerts inbox, rules and resolved lists), padded,
 * tinted on hover and press, positioned so a stretched row link covers it.
 */
export const gridListRow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ key: string; grid: string; attributes?: ReadonlyArray<Attribute<M>> }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.li(
		[
			h.Key(options.key),
			h.Class(cn(options.grid, "relative px-4 py-3 hover:bg-surface-sunken active:bg-surface-sunken")),
			...(options.attributes ?? []),
		],
		children,
	)
