import { cn } from "@maple/ui/lib/utils"
import {
	pageBodyStyles,
	pageContentStyles,
	pageFillStyles,
	pageFilterSidebarStyles,
	pageFilterSidebarWidthStyles,
	pageHeaderActionsStyles,
	pageHeaderStyles,
	pageHeaderTextStyles,
	pageRightSidebarStyles,
	pageRightSidebarWidthStyles,
	pageScrollAreaStyles,
	pageStickyAreaScrolledStyles,
	pageStickyAreaStyles,
} from "@maple/ui/styles/ui/page-layout"
import type { Html, HtmlBuilder } from "foldkit/html"

// The dashboard page below the shell's top bar:
// `PageLayout.Body` with its filter rail, content column, sticky header and scroll area.
// Below `lg` the shell lifts both rails out of the body into sheets (`shell/page-rails.ts`).

export type DashboardPageOptions = Readonly<{
	/** `DashboardLayout.Filters`'s children. */
	filters?: Html
	filtersWidth?: string
	/** `DashboardLayout.Header`'s `titleContent`. */
	titleContent?: Html | undefined
	/** The header's right side: `headerActions` and the time controls, already composed. */
	actions?: Html
	/** `DashboardLayout.Tabs`'s children: page tabs pinned under the header. */
	tabs?: Html
	scrollClassName?: string
	/** `DashboardLayout.Scroll`'s `width`: a centred capped column (`page-column`). */
	width?: PageWidth
	/** `DashboardLayout.Scroll`'s `gap` between the body's top-level blocks. */
	gap?: PageGap
	/** `header`:replaces the composed header (a page with its own title block). */
	header?: Html
	/** `DashboardLayout.RightPanel`: inline at `lg` and up, a sheet below it (the shell lifts it). */
	rightPanel?: Html
	rightPanelWidth?: string
	/** `DashboardPage`'s `sticky`: pinned under the header and tabs (a chart, a toolbar, a banner). */
	sticky?: Html
	/** `DashboardPage fill`: the body owns its scrolling (`DashboardLayout.Fill`, not `Scroll`). */
	fill?: boolean
	/** A scroller below has left the top: the sticky area raises its shadow. */
	isScrolled?: boolean
}>

/** `PageLayout.Body`. */
export const pageBody = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class(pageBodyStyles), h.DataAttribute("slot", "page-body")], children)

/** `PageLayout.FilterSidebar` as the inline rail (lg and up). */
export const filterRail = <M>(h: HtmlBuilder<M>, child: Html, width?: string): Html =>
	h.aside(
		[
			h.DataAttribute("slot", "page-filter-sidebar"),
			h.Class(cn(pageFilterSidebarStyles, width ?? pageFilterSidebarWidthStyles)),
		],
		[child],
	)

/** `PageLayout.Content`. */
export const pageContent = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.main(
		[h.Id("main-content"), h.DataAttribute("slot", "page-content"), h.Class(pageContentStyles)],
		children,
	)

/** `PageLayout.Header` + `HeaderActions`. */
export const pageHeader = <M>(h: HtmlBuilder<M>, titleContent: Html | undefined, actions: Html | undefined): Html =>
	h.div(
		[h.DataAttribute("slot", "page-header"), h.Class(pageHeaderStyles)],
		[
			h.div([h.Class(pageHeaderTextStyles)], titleContent === undefined ? [] : [titleContent]),
			...(actions === undefined
				? []
				: [
						h.div(
							[
								h.DataAttribute("slot", "page-header-actions"),
								h.Class(pageHeaderActionsStyles),
							],
							[actions],
						),
					]),
		],
	)

/** `PageLayout.StickyArea`; the page reports the scrolled shadow. */
const stickyArea = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>, isScrolled = false): Html =>
	h.div(
		[
			h.DataAttribute("slot", "page-sticky-area"),
			h.Class(cn(pageStickyAreaStyles, isScrolled && pageStickyAreaScrolledStyles)),
		],
		children,
	)

/** `PageLayout.Fill`. */
const fillArea = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.DataAttribute("slot", "page-fill"), h.Class(pageFillStyles)], children)

const PAGE_WIDTH = { full: null, reading: "mx-auto max-w-4xl", narrow: "mx-auto max-w-3xl" } as const
const PAGE_GAP = { none: null, sm: "gap-3", md: "gap-4", lg: "gap-6" } as const
export type PageWidth = keyof typeof PAGE_WIDTH
export type PageGap = keyof typeof PAGE_GAP

/** `DashboardLayout.Scroll`: the scroll area, with a `page-column` unless the width is full. */
const scrollArea = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	className?: string,
	width: PageWidth = "full",
	gap: PageGap = "none",
): Html =>
	width === "full"
		? h.div(
				[
					h.DataAttribute("slot", "page-scroll-area"),
					h.Class(cn(pageScrollAreaStyles, PAGE_GAP[gap], className)),
				],
				children,
			)
		: h.div(
				[h.DataAttribute("slot", "page-scroll-area"), h.Class(cn(pageScrollAreaStyles, className))],
				[
					h.div(
						[
							h.DataAttribute("slot", "page-column"),
							h.Class(cn("flex w-full flex-col", PAGE_WIDTH[width], PAGE_GAP[gap])),
						],
						children,
					),
				],
			)

/** The common page: optional filter rail, then the content column with header and scroll area. */
export const dashboardPage = <M>(
	h: HtmlBuilder<M>,
	options: DashboardPageOptions,
	children: ReadonlyArray<Html>,
): Html => {
	const hasHeader = options.titleContent !== undefined || options.actions !== undefined
	const header =
		options.header ?? (hasHeader ? pageHeader(h, options.titleContent, options.actions) : undefined)
	const sticky = [
		...(header === undefined ? [] : [header]),
		...(options.tabs === undefined
			? []
			: [h.div([h.DataAttribute("slot", "page-tabs"), h.Class("min-w-0")], [options.tabs])]),
		...(options.sticky === undefined || options.sticky === null ? [] : [options.sticky]),
	]
	return pageBody(h, [
		...(options.filters === undefined ? [] : [filterRail(h, options.filters, options.filtersWidth)]),
		pageContent(h, [
			...(sticky.length > 0 ? [stickyArea(h, sticky, options.isScrolled)] : []),
			options.fill === true ? fillArea(h, children) : scrollArea(h, children, options.scrollClassName, options.width, options.gap),
		]),
		...(options.rightPanel === undefined
			? []
			: [
					h.aside(
						[
							h.DataAttribute("slot", "page-right-sidebar"),
							h.Class(
								cn(
									pageRightSidebarStyles,
									options.rightPanelWidth ?? pageRightSidebarWidthStyles,
								),
							),
						],
						[options.rightPanel],
					),
				]),
	])
}
