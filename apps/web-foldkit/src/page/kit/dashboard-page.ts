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

// `DashboardPage` (apps/web/src/components/layout/dashboard-page.tsx) below the shell's top bar:
// `PageLayout.Body` with its filter rail, content column, sticky header and scroll area.
// TODO(lg): legacy moves the filter rail into a left sheet below `lg` (`useMediaQuery("max-lg")`).

export type DashboardPageOptions = Readonly<{
	/** `DashboardLayout.Filters`'s children. */
	filters?: Html
	filtersWidth?: string
	/** `DashboardLayout.Header`'s `titleContent`. */
	titleContent?: Html
	/** The header's right side: `headerActions` and the time controls, already composed. */
	actions?: Html
	scrollClassName?: string
	/** `header`: replaces the composed header (a page with its own title block). */
	header?: Html
	/** `DashboardLayout.Tabs`: page tabs pinned under the header. */
	tabs?: Html
	/** `DashboardLayout.RightPanel` as the inline rail (lg and up). TODO(lg): the sheet below lg. */
	rightPanel?: Html
	rightPanelWidth?: string
	/** `sticky`: pinned under the header (a chart, a toolbar). */
	sticky?: Html
	/** The body owns its scrolling (a virtualized list): `Fill` instead of `Scroll`. */
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
const pageHeader = <M>(h: HtmlBuilder<M>, titleContent: Html | undefined, actions: Html | undefined): Html =>
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

/** `PageLayout.ScrollArea` (`DashboardLayout.Scroll` with the default width and gap). */
const scrollArea = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>, className?: string): Html =>
	h.div(
		[h.DataAttribute("slot", "page-scroll-area"), h.Class(cn(pageScrollAreaStyles, className))],
		children,
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
		...(options.sticky === undefined ? [] : [options.sticky]),
	]
	return pageBody(h, [
		...(options.filters === undefined ? [] : [filterRail(h, options.filters, options.filtersWidth)]),
		pageContent(h, [
			...(sticky.length > 0 ? [stickyArea(h, sticky, options.isScrolled)] : []),
			options.fill === true ? fillArea(h, children) : scrollArea(h, children, options.scrollClassName),
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
