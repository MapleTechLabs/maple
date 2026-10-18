import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import { icon } from "@maple/web-foldkit/ui/icon"
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
} from "@maple/web-foldkit/ui/sidebar"
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

/** `AppSidebar`; `linkQuery` is the context every section link carries (range, service filter). */
export const appSidebar = (h: HtmlBuilder<Message>, model: Model, linkQuery: URLSearchParams): Html => {
	const active = activeSection(model.route)
	const state = model.isSidebarOpen ? "expanded" : "collapsed"
	return sidebarDesktop(h, state, [
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
	])
}
