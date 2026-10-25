import { icon } from "@maple/web/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"

/** The lockup: `maple` in the display face, `local` in mono. */
export const localLockup = <M>(h: HtmlBuilder<M>): Html =>
	h.span(
		[h.Class("flex shrink-0 items-center gap-1.5")],
		[
			icon(h, "MapleMark", { size: 16, className: "shrink-0 text-primary" }),
			h.span(
				[h.Class("font-display text-sm font-semibold tracking-[-0.01em] group-data-[collapsible=icon]:hidden")],
				["maple"],
			),
			h.span(
				[
					h.Class(
						"font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground group-data-[collapsible=icon]:hidden",
					),
				],
				["local"],
			),
		],
	)
