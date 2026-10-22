import { button } from "@maple/web/ui/button"
import { triggerId } from "@maple/web/ui/dialog"
import { icon } from "@maple/web/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"

// The page shell: filter rail beside a toolbar over the scrolling
// content. Below `md` the rail moves behind a Filters button; the root draws the drawer.

/** The drawer's Dialog id; the root lifts the `page-filter-sidebar` rail into it while open. */
export const FILTER_DRAWER_ID = "local-filter-drawer"

export type PageShellOptions<M> = Readonly<{
	sidebar: Html
	toolbar: Html
	/** Shown on the small-screen Filters button, so hidden filters are never invisible. */
	activeFilterCount?: number
	/** The page's `ClickedOpenFilters`, answered with `RequestedFilterDrawer`. */
	onOpenFilters: M
}>

export const pageShell = <M>(
	h: HtmlBuilder<M>,
	options: PageShellOptions<M>,
	children: ReadonlyArray<Html>,
): Html => {
	const count = options.activeFilterCount ?? 0
	return h.div(
		[h.Class("flex h-full min-h-0"), h.DataAttribute("slot", "page-body")],
		[
			h.aside(
				[
					h.Class("hidden h-full border-r py-1 md:block"),
					h.DataAttribute("slot", "page-filter-sidebar"),
				],
				[options.sidebar],
			),
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
									// The drawer hands focus back here on close.
									attributes: [
										h.Id(triggerId(FILTER_DRAWER_ID)),
										h.OnClick(options.onOpenFilters),
									],
								},
								[
									icon(h, "FilterIcon"),
									"Filters",
									...(count > 0
										? [
												h.span(
													[
														h.Class(
															"rounded-sm bg-primary/15 px-1 text-[10px] tabular-nums text-primary",
														),
													],
													[String(count)],
												),
											]
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
