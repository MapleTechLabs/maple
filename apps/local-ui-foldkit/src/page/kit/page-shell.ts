import { button } from "@maple/web-foldkit/ui/button"
import { icon } from "@maple/web-foldkit/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"

// apps/local-ui/src/components/page-shell.tsx: filter rail beside a toolbar over the scrolling
// content. Below `md` the rail moves behind a Filters button.
// TODO(drawer): the Filters button's Sheet (mobile) is not ported; the button is drawn inert.

export type PageShellOptions<M> = Readonly<{
	sidebar: Html
	toolbar: Html
	/** Shown on the small-screen Filters button, so hidden filters are never invisible. */
	activeFilterCount?: number
	onOpenFilters?: M
}>

export const pageShell = <M>(h: HtmlBuilder<M>, options: PageShellOptions<M>, children: ReadonlyArray<Html>): Html => {
	const count = options.activeFilterCount ?? 0
	return h.div(
		[h.Class("flex h-full min-h-0")],
		[
			h.aside([h.Class("hidden h-full border-r py-1 md:block")], [options.sidebar]),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col")],
				[
					h.div(
						[h.Class("flex items-center border-b px-4 py-2 md:hidden")],
						[
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									className: "gap-1.5",
									attributes: options.onOpenFilters === undefined ? [] : [h.OnClick(options.onOpenFilters)],
								},
								[
									icon(h, "FilterIcon"),
									"Filters",
									...(count > 0
										? [h.span([h.Class("rounded-sm bg-primary/15 px-1 text-[10px] tabular-nums text-primary")], [String(count)])]
										: []),
								],
							),
						],
					),
					options.toolbar,
					h.div([h.Class("min-h-0 flex-1 overflow-auto")], children),
				],
			),
		],
	)
}
