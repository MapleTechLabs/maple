import type { Html, HtmlBuilder } from "foldkit/html"

// `SectionHeading` (apps/web/src/components/common/section-heading.tsx), title variant: the title
// with an optional muted hint, and right-aligned actions.

export const sectionHeading = <M>(
	h: HtmlBuilder<M>,
	title: string,
	options: Readonly<{ hint?: string; actions?: Html }> = {},
): Html => {
	const heading = h.div(
		[h.Class("flex items-baseline gap-2.5")],
		[
			h.h2([h.Class("text-sm font-medium text-foreground")], [title]),
			...(options.hint === undefined
				? []
				: [h.span([h.Class("text-xs text-muted-foreground")], [options.hint])]),
		],
	)
	return options.actions === undefined
		? heading
		: h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-x-3 gap-y-2")],
				[heading, options.actions],
			)
}
