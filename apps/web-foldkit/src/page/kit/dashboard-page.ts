import { cn } from "@maple/ui/lib/utils"
import {
	pageBodyStyles,
	pageContentStyles,
	pageFilterSidebarStyles,
	pageFilterSidebarWidthStyles,
	pageHeaderActionsStyles,
	pageHeaderStyles,
	pageHeaderTextStyles,
	pageScrollAreaStyles,
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
	/** `DashboardLayout.Tabs`: page tabs pinned under the header. */
	tabs?: Html
	scrollClassName?: string
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

/** `PageLayout.StickyArea` (the scrolled shadow is not modelled yet). */
const stickyArea = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.DataAttribute("slot", "page-sticky-area"), h.Class(pageStickyAreaStyles)], children)

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
	const sticky = [
		...(hasHeader ? [pageHeader(h, options.titleContent, options.actions)] : []),
		...(options.tabs === undefined
			? []
			: [h.div([h.DataAttribute("slot", "page-tabs"), h.Class("min-w-0")], [options.tabs])]),
	]
	return pageBody(h, [
		...(options.filters === undefined ? [] : [filterRail(h, options.filters, options.filtersWidth)]),
		pageContent(h, [
			...(sticky.length > 0 ? [stickyArea(h, sticky)] : []),
			scrollArea(h, children, options.scrollClassName),
		]),
	])
}
