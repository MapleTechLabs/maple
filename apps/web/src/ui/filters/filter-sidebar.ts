import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isSameFailure, type LoadFailure } from "../../data/load-failure"
import { button } from "../button"
import { separator } from "../display"
import { errorState } from "../error-state"
import { eyebrow } from "../eyebrow"
import { scrollArea } from "../scroll-area"
import { skeleton } from "../skeleton"

// Port of packages/ui/src/components/filters/filter-sidebar.tsx, plus its error state.

/**
 * `FilterSidebarFrame`: dims while a refetch runs over the facets it shows. `isIdle` marks a rail
 * with nothing to offer, so the inline rail (`filterRail`) gives its width back to the content.
 */
export const filterSidebarFrame = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isWaiting?: boolean; isIdle?: boolean; className?: string }>,
	children: ReadonlyArray<Html>,
): Html => {
	const isWaiting = options.isWaiting ?? false
	return h.div(
		[
			h.Class(cn("flex h-full w-full flex-col", refreshingClass(isWaiting), options.className)),
			...(isWaiting ? [h.AriaBusy(true)] : []),
			...(options.isIdle === true ? [h.DataAttribute("rail-idle", "")] : []),
		],
		children,
	)
}

/** `FilterSidebarHeader`; `onClear` shows "Clear all" when a filter is set. */
export const filterSidebarHeader = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title?: string; onClear?: M }> = {},
): Html =>
	h.div(
		[h.Class("flex h-8 items-center justify-between py-2")],
		[
			eyebrow(h, { as: "h3", variant: "label", className: "font-semibold text-foreground" }, [
				options.title ?? "Filters",
			]),
			...(options.onClear === undefined
				? []
				: [
						button(
							h,
							{
								variant: "link",
								size: "xs",
								className: "text-muted-foreground hover:text-foreground",
								attributes: [h.OnClick(options.onClear)],
							},
							["Clear all"],
						),
					]),
		],
	)

/** `FilterSidebarBody`: separator, the scrolling section list and its bottom fade. */
export const filterSidebarBody = <M>(
	h: HtmlBuilder<M>,
	idPrefix: string,
	children: ReadonlyArray<Html>,
): Html[] => [
	separator(h, "horizontal", "my-2"),
	h.div(
		[h.Class("relative min-h-0 flex-1")],
		[
			scrollArea(h, { className: "h-full", idPrefix }, [
				h.div([h.Class("space-y-2 pr-4 pb-6")], children),
			]),
			h.div(
				[
					h.AriaHidden(true),
					h.Class(
						"pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent",
					),
				],
				[],
			),
		],
	),
]

const OPTION_WIDTHS = ["w-[58%]", "w-[72%]", "w-[44%]", "w-[64%]", "w-[50%]"]
const LABEL_WIDTHS = ["w-14", "w-20", "w-16", "w-12"]

/** `FilterSidebarLoading`: shaped like the loaded rail so nothing jumps in. */
export const filterSidebarLoading = <M>(h: HtmlBuilder<M>, sectionCount = 3): Html =>
	filterSidebarFrame(h, {}, [
		h.div(
			[h.AriaBusy(true), h.Class("contents")],
			[
				h.div([h.Class("flex h-8 items-center py-2")], [skeleton(h, "h-2.5 w-12")]),
				separator(h, "horizontal", "my-2"),
				h.div(
					[h.Class("space-y-2 pr-4")],
					Array.from({ length: sectionCount }, (_, section) =>
						h.div(
							[h.Class("pb-3")],
							[
								h.div(
									[h.Class("flex h-8 items-center")],
									[skeleton(h, cn("h-2", LABEL_WIDTHS[section % LABEL_WIDTHS.length]))],
								),
								h.div(
									[h.Class("space-y-2")],
									Array.from({ length: section === 0 ? 2 : 4 }, (_, row) =>
										h.div(
											[h.Class("flex h-4 items-center gap-2")],
											[
												skeleton(h, "size-3.5 shrink-0 rounded-sm"),
												skeleton(
													h,
													cn(
														"h-2.5",
														OPTION_WIDTHS[(section + row) % OPTION_WIDTHS.length],
													),
												),
												skeleton(h, "ml-auto h-2.5 w-5 shrink-0"),
											],
										),
									),
								),
							],
						),
					),
				),
			],
		),
	])

/** `FilterSidebarEmpty`: nothing to filter and no filter set. */
export const filterSidebarEmpty = <M>(h: HtmlBuilder<M>): Html =>
	filterSidebarFrame(h, { isIdle: true }, [
		filterSidebarHeader(h),
		separator(h, "horizontal", "my-2"),
		h.div(
			[h.Class("space-y-1 py-2 pr-4")],
			[
				h.p([h.Class("font-prose text-xs font-medium text-foreground")], ["Nothing to filter yet"]),
				h.p(
					[h.Class("font-prose text-xs leading-relaxed text-muted-foreground")],
					["Filters fill in from the values in your data once it arrives."],
				),
			],
		),
	])

/**
 * The filter sidebar's failure state. One quiet line when the main panel shows the same failure
 * (`mainFailure`); otherwise the rail is the only place it shows, so it keeps the full message.
 */
export const filterSidebarError = <M>(
	h: HtmlBuilder<M>,
	failure: LoadFailure,
	onRetry?: M,
	mainFailure?: LoadFailure,
): Html => {
	// The main panel shows the same failure, so the inline rail steps aside.
	const isEchoed = mainFailure !== undefined && isSameFailure(mainFailure, failure)
	return filterSidebarFrame(h, { isIdle: isEchoed }, [
		filterSidebarHeader(h),
		separator(h, "horizontal", "my-2"),
		isEchoed
			? errorState(h, {
					failure,
					onRetry,
					variant: "quiet",
					title: "Filters unavailable",
					// The main panel shows the same failure with its own Try again.
					hidesRetryButton: true,
					className: "py-2 pr-4",
				})
			: errorState(h, { failure, onRetry, variant: "inline" }),
	])
}
