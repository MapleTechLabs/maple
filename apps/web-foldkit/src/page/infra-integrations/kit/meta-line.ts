import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// `MetaLine` (apps/web/src/components/infra/primitives/meta-line.tsx): the secondary identity line,
// separators between present items only, one truncated line.

export type MetaItem = Html | string | null | undefined

export const metaLine = <M>(
	h: HtmlBuilder<M>,
	items: ReadonlyArray<MetaItem>,
	options: Readonly<{ title?: string; className?: string }> = {},
): Html | null => {
	const present = items.filter(
		(item): item is Html | string => item !== null && item !== undefined && item !== "",
	)
	if (present.length === 0) return null
	const strings = present.filter((item): item is string => typeof item === "string")
	const title = options.title ?? (strings.length === present.length ? strings.join(" · ") : undefined)
	return h.div(
		[
			h.Class(
				cn(
					"mt-1 flex min-w-0 items-center gap-x-2 truncate font-mono text-2xs text-muted-foreground/80",
					options.className,
				),
			),
			...(title === undefined ? [] : [h.Title(title)]),
		],
		present.map((item, index) =>
			h.span(
				[h.Class("flex shrink-0 items-center gap-x-2")],
				[
					...(index > 0 ? [h.span([h.Class("text-foreground/20")], ["·"])] : []),
					typeof item === "string" ? h.span([h.Class("max-w-[28ch] truncate")], [item]) : item,
				],
			),
		),
	)
}
