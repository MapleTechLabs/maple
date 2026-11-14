import { cn } from "@maple/ui/lib/utils"
import { ROW_FOCUSED_CLASS, rowFocusAttributes } from "@maple/views/ui/row-focus"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/**
 * One `<li>` of a bordered grid list (the alerts inbox, rules and resolved lists), padded, tinted on
 * hover and press, positioned so a stretched row link covers it. `isFocused` marks the list
 * page's keyboard-focused row.
 */
export const gridListRow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		key: string
		grid: string
		isFocused?: boolean
		attributes?: ReadonlyArray<Attribute<M>>
	}>,
	children: ReadonlyArray<Html>,
): Html =>
	h.li(
		[
			h.Key(options.key),
			h.Class(
				cn(
					options.grid,
					ROW_FOCUSED_CLASS,
					"relative px-4 py-3 hover:bg-surface-sunken active:bg-surface-sunken",
				),
			),
			...rowFocusAttributes(h, options.isFocused),
			...(options.attributes ?? []),
		],
		children,
	)
