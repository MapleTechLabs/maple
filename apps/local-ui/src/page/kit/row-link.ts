import { cn } from "@maple/ui/lib/utils"
import { tableRow } from "@maple/web/ui/table"
import type { Html, HtmlBuilder } from "foldkit/html"

// A row that navigates is a real link, its first cell's
// anchor stretched over the row (keyboard focus, cmd-click and "copy link" for free).

export const linkRow = <M>(
	h: HtmlBuilder<M>,
	className: string | undefined,
	children: ReadonlyArray<Html>,
): Html =>
	tableRow(
		h,
		children,
		cn(
			"relative cursor-pointer focus-within:bg-muted/50 has-[a[data-row-link]:focus-visible]:outline-2 has-[a[data-row-link]:focus-visible]:-outline-offset-2 has-[a[data-row-link]:focus-visible]:outline-ring",
			className,
		),
	)

/** The row's anchor. Put it in the first cell; its `::after` covers the row. */
export const rowLink = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ href: string; label?: string; className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.a(
		[
			h.Href(options.href),
			...(options.label === undefined ? [] : [h.AriaLabel(options.label)]),
			h.DataAttribute("row-link", ""),
			h.Class(cn("outline-none after:absolute after:inset-0 after:content-['']", options.className)),
		],
		children,
	)
