import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import { sidebarMobileHeaderStyles, sidebarMobileInnerStyles, sidebarMobileStyles } from "@maple/ui/styles/ui/sidebar"
import { icon } from "@maple/web/ui/icon"
import { leftSheet } from "@maple/web/ui/sheet"
import {
	sidebarContent,
	sidebarDesktop,
	sidebarFooter,
	sidebarGroup,
	sidebarGroupContent,
	sidebarGroupLabel,
	sidebarHeader,
	sidebarMenu,
	sidebarMenuButton,
	sidebarMenuItem,
	sidebarRail,
	sidebarTrigger,
} from "@maple/web/ui/sidebar"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message"
import type { Model } from "../model"
import { hrefFor } from "../route"
import { connectButton } from "./connect"
import { ingestStatus } from "./ingest-status"
import { localLockup } from "./lockup"
import { activeSection, NAV_GROUPS } from "./nav"

/** Same selected-row rail as apps/web's sidebar: a 2px lane only the active row paints. */
const ACTIVE_RAIL = `${ROW_LANE} data-[active=true]:rounded-l-none data-[active=true]:before:bg-sidebar-primary data-[active=true]:text-sidebar-primary`

/** `AppSidebar`'s children, shared by the desktop rail and the mobile sheet. */
const sidebarRegions = (h: HtmlBuilder<Message>, model: Model, linkQuery: URLSearchParams): ReadonlyArray<Html> => {
	const active = activeSection(model.route)
	const state = model.isSidebarOpen ? "expanded" : "collapsed"
	return [
		sidebarHeader(h, [localLockup(h)], "h-12 flex-row items-center px-4 group-data-[collapsible=icon]:px-2"),
		sidebarContent(
			h,
			NAV_GROUPS.map((group) =>
				sidebarGroup(h, undefined, [
					sidebarGroupLabel(h, "h-6 text-muted-foreground", [group.label]),
					sidebarGroupContent(h, [
						sidebarMenu(
							h,
							undefined,
							group.items.map((item) =>
								sidebarMenuItem(h, undefined, [
									sidebarMenuButton(
										h,
										{
											className: ACTIVE_RAIL,
											isActive: active === item.section,
											href: hrefFor(`/${item.section}`, linkQuery),
											hasTooltip: true,
											attributes: active === item.section ? [h.AriaCurrent("page")] : [],
										},
										[icon(h, item.icon, { size: 18 }), h.span([], [item.label])],
									),
								]),
							),
						),
					]),
				]),
			),
		),
		sidebarFooter(h, [
			ingestStatus(h, model.maybeServer, model.env.port),
			h.div(
				[h.Class("flex items-center gap-1 group-data-[collapsible=icon]:flex-col")],
				[
					connectButton(h, model),
					sidebarTrigger(h, {
						state,
						className: "hidden size-8 md:inline-flex",
						attributes: [h.OnClick(Message.ClickedToggleSidebar())],
					}),
				],
			),
		]),
		sidebarRail(h, Message.ClickedToggleSidebar()),
	]
}

/** `AppSidebar` above `md`; `linkQuery` is the context every section link carries (range, service filter). */
export const appSidebar = (h: HtmlBuilder<Message>, model: Model, linkQuery: URLSearchParams): Html =>
	sidebarDesktop(h, model.isSidebarOpen ? "expanded" : "collapsed", sidebarRegions(h, model, linkQuery))

/** `<Sidebar>` below `md`: the same children in `SheetPopup side="left"` (packages/ui sidebar.tsx). */
export const mobileSidebar = (h: HtmlBuilder<Message>, model: Model, linkQuery: URLSearchParams): Html =>
	leftSheet(
		h,
		{
			id: "local-mobile-sidebar",
			className: sidebarMobileStyles,
			title: "Sidebar",
			description: "Displays the mobile sidebar.",
			headerClassName: sidebarMobileHeaderStyles,
			slot: "sidebar",
			popupAttributes: [
				h.DataAttribute("mobile", "true"),
				h.DataAttribute("sidebar", "sidebar"),
				h.Style({ "--nested-dialogs": "0", "--sidebar-width": "18rem" }),
			],
			onDismiss: Message.DismissedMobileNav(),
		},
		[h.div([h.Class(sidebarMobileInnerStyles)], sidebarRegions(h, model, linkQuery))],
	)
