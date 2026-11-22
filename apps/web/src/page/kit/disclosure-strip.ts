import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"

// A panel's last band that opens on a long block of monospace text.

/**
 * A ruled band at a panel's foot, closed by default, that opens on a long monospace block (a
 * prompt, a stack trace). The browser keeps the open state, so the page's Model holds none.
 */
export const disclosureStrip = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ label: Html | string; text: string }>,
): Html =>
	h.details(
		[h.Class("group/disclosure border-t")],
		[
			h.summary(
				[
					h.Class(
						"flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-xs text-muted-foreground select-none hover:text-foreground active:text-foreground [&::-webkit-details-marker]:hidden",
					),
				],
				[
					icon(h, "ChevronRightIcon", {
						size: 12,
						className: "transition-transform group-open/disclosure:rotate-90",
					}),
					options.label,
				],
			),
			h.pre(
				[
					h.Class(
						"max-h-72 overflow-auto border-t bg-surface-sunken px-4 pt-3 pb-8 [mask-image:linear-gradient(to_bottom,black_80%,transparent)] font-mono text-xs leading-5 whitespace-pre-wrap break-words text-foreground-soft",
					),
				],
				[options.text],
			),
		],
	)
