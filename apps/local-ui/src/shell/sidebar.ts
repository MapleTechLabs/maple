import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
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
	sidebarMobile,
	sidebarRail,
	sidebarTrigger,
} from "@maple/views/ui/sidebar"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message"
import type { Model } from "../model"
import { hrefFor } from "../route"
import { connectButton } from "./connect"
import { ingestStatus } from "./ingest-status"
import { localLockup } from "./lockup"
import { activeSection, NAV_GROUPS } from "./nav"
import { Array as Arr } from "effect"

/** `AppSidebar`'s children, shared by the desktop rail and the mobile sheet. */
const sidebarRegions = (
	h: HtmlBuilder<Message>,
	model: Model,
	linkQuery: URLSearchParams,
): ReadonlyArray<Html> => {
	const active = activeSection(model.route)
	const state = model.isSidebarOpen ? "expanded" : "collapsed"
	return [
		sidebarHeader(
			h,
			[localLockup(h)],
			"h-12 flex-row items-center px-4 group-data-[collapsible=icon]:px-2",
		),
		sidebarContent(
			h,
			Arr.map(NAV_GROUPS, (group) =>
				sidebarGroup(h, undefined, [
					sidebarGroupLabel(h, "h-6 text-muted-foreground", [group.label]),
					sidebarGroupContent(h, [
						sidebarMenu(
							h,
							undefined,
							Arr.map(group.items, (item) =>
								sidebarMenuItem(h, undefined, [
									sidebarMenuButton(
										h,
										{
											rail: "active",
											isActive: active === item.section,
											href: hrefFor(`/${item.section}`, linkQuery),
											hasTooltip: true,
											attributes:
												active === item.section ? [h.AriaCurrent("page")] : [],
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
			hstack(h, { gap: "1", className: "group-data-[collapsible=icon]:flex-col" }, [
				connectButton(h, model),
				sidebarTrigger(h, {
					state,
					className: "hidden size-8 md:inline-flex",
					attributes: [h.OnClick(Message.ClickedToggleSidebar())],
				}),
			]),
		]),
		sidebarRail(h, Message.ClickedToggleSidebar()),
	]
}

/** `AppSidebar` above `md`; `linkQuery` is the context every section link carries (range, service filter). */
export const appSidebar = (h: HtmlBuilder<Message>, model: Model, linkQuery: URLSearchParams): Html =>
	sidebarDesktop(h, model.isSidebarOpen ? "expanded" : "collapsed", sidebarRegions(h, model, linkQuery))

/** `<Sidebar>` below `md`: the same children in the kit's left sheet. */
export const mobileSidebar = (h: HtmlBuilder<Message>, model: Model, linkQuery: URLSearchParams): Html =>
	sidebarMobile(
		h,
		{ id: "local-mobile-sidebar", onDismiss: Message.DismissedMobileNav() },
		sidebarRegions(h, model, linkQuery),
	)
