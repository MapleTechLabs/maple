import { cn } from "@maple/ui/lib/utils"
import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import { Option, Record } from "effect"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { avatarFallback, badge, kbd } from "../ui/display"
import { menuTriggerAttributes } from "../ui/dropdown-menu"
import { icon } from "../ui/icon"
import {
	sidebarFooter,
	sidebarHeader,
	sidebarMenu,
	sidebarMenuBadge,
	sidebarMenuButton,
	sidebarMenuItem,
} from "../ui/sidebar"
import { isSameMenu, triggerIdOf } from "./menus"
import { Menu, Message } from "./message"
import type { Model } from "./model"

// apps/web/src/components/dashboard/app-sidebar.tsx and org-switcher.tsx.

/** The selected row's rail: a 2px lane every row reserves, painted only when active. */
export const ACTIVE_RAIL = `${ROW_LANE} data-[active=true]:rounded-l-none data-[active=true]:before:bg-sidebar-primary data-[active=true]:text-sidebar-primary`

export const GROUP_LABEL = "h-6 text-muted-foreground"

const COLLAPSED_AVATAR_ROW = "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-1!"

const OPEN_STATE = "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"

/** The collapsed rail's tooltip trigger for a row titled `title` (`SidebarMenuButton tooltip`). */
export type RailTip = (title: string) => ReadonlyArray<ChildAttribute>

/** The expanded rail and the mobile sheet hide the tooltips. */
export const NO_TIP: RailTip = () => []

export const isMenuOpen = (model: Model, menu: Menu): boolean =>
	Option.exists(model.openMenu, (open) => isSameMenu(open.menu, menu))

export const triggerFor = (h: HtmlBuilder<Message>, model: Model, menu: Menu) =>
	menuTriggerAttributes(h, {
		id: triggerIdOf(menu),
		isOpen: isMenuOpen(model, menu),
		onToggle: Message.ClickedMenuTrigger({ menu }),
	})

/** The active org's pinned `service.namespace`, or none for "All namespaces". */
export const pinnedNamespaceOf = (model: Model): Option.Option<string> =>
	Option.flatMap(model.maybeOrgId, (orgId) => Record.get(model.pinnedNamespaces, orgId))

/** `SelfHostedOrgSwitcher`'s trigger: the server tile, "Self Hosted" and the pinned namespace. */
const orgSwitcher = (h: HtmlBuilder<Message>, model: Model): Html =>
	sidebarMenu(h, undefined, [
		sidebarMenuItem(h, undefined, [
			sidebarMenuButton(
				h,
				{
					size: "lg",
					className: OPEN_STATE,
					slot: "dropdown-menu-trigger",
					attributes: triggerFor(h, model, Menu.Org()),
				},
				[
					h.div(
						[
							h.Class(
								"flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
							),
						],
						[icon(h, "ServerIcon", { size: 16 })],
					),
					h.div(
						[h.Class("grid flex-1 text-left text-sm leading-tight")],
						[
							h.span([h.Class("truncate font-medium")], ["Self Hosted"]),
							...Option.match(pinnedNamespaceOf(model), {
								onNone: () => [],
								onSome: (namespace) => [
									h.span(
										[h.Class("truncate text-xs font-medium text-primary")],
										[namespace],
									),
								],
							}),
						],
					),
					icon(h, "ChevronExpandYIcon", { size: 16, className: "ml-auto" }),
				],
			),
		]),
	])

/** `SearchRow`: the ⌘K entry (the palette itself is not ported yet). */
const searchRow = (h: HtmlBuilder<Message>, tip: RailTip): Html =>
	sidebarMenu(h, undefined, [
		sidebarMenuItem(h, undefined, [
			sidebarMenuButton(
				h,
				{
					className:
						"border border-sidebar-border bg-background text-muted-foreground hover:bg-background hover:text-foreground",
					hasTooltip: true,
					attributes: tip("Search"),
				},
				[
					icon(h, "MagnifierIcon", { size: 16 }),
					h.span([h.Class("flex-1 text-left")], ["Search"]),
					kbd(h, "group-data-[collapsible=icon]:hidden", ["⌘K"]),
				],
			),
		]),
	])

export const shellSidebarHeader = (h: HtmlBuilder<Message>, model: Model, tip: RailTip = NO_TIP): Html =>
	sidebarHeader(h, [orgSwitcher(h, model), searchRow(h, tip)])
// FOOTER

const footerNavRow = (
	h: HtmlBuilder<Message>,
	currentPath: string,
	options: Readonly<{ href: string; title: string; icon: "GridIcon" | "GearIcon" }>,
	tip: RailTip,
): Html =>
	sidebarMenuItem(h, undefined, [
		sidebarMenuButton(
			h,
			{
				className: ACTIVE_RAIL,
				isActive: currentPath === options.href || currentPath.startsWith(`${options.href}/`),
				link: { href: options.href, currentPath },
				hasTooltip: true,
				attributes: tip(options.title),
			},
			[icon(h, options.icon, { size: 18 }), h.span([], [options.title])],
		),
	])

/** `UserAvatar` (dashboard/user-avatar.tsx) with no image: the initials fallback. */
export const userAvatar = (h: HtmlBuilder<Message>, initials: string, className?: string): Html =>
	avatarFallback(
		h,
		{
			className: cn("bg-muted", className ?? "size-6 rounded-md text-3xs"),
			fallbackClassName: "rounded-[inherit] font-medium text-muted-foreground",
		},
		initials,
	)

/** `GuestMenu`'s trigger and `SupportMenu`'s, side by side in the account cluster. */
const footerCluster = (h: HtmlBuilder<Message>, model: Model, avatar: Html): Html =>
	sidebarMenu(h, undefined, [
		sidebarMenuItem(h, "flex items-center gap-1 group-data-[collapsible=icon]:flex-col", [
			h.div(
				[
					h.Class(
						"min-w-0 flex-1 group-data-[collapsible=icon]:w-full group-data-[collapsible=icon]:flex-none",
					),
				],
				[
					sidebarMenuButton(
						h,
						{
							className: `${COLLAPSED_AVATAR_ROW} ${OPEN_STATE}`,
							hasTooltip: true,
							slot: "dropdown-menu-trigger",
							attributes: triggerFor(h, model, Menu.User()),
						},
						[
							avatar,
							h.span(
								[h.Class("truncate font-medium group-data-[collapsible=icon]:hidden")],
								["Root"],
							),
						],
					),
				],
			),
			sidebarMenuButton(
				h,
				{
					className: "size-8 w-8 shrink-0 justify-center p-0 group-data-[collapsible=icon]:w-full",
					hasTooltip: true,
					slot: "dropdown-menu-trigger",
					attributes: triggerFor(h, model, Menu.Support()),
				},
				[icon(h, "CircleQuestionIcon", { size: 16 }), h.span([h.Class("sr-only")], ["Support"])],
			),
		]),
	])

export const shellSidebarFooter = (
	h: HtmlBuilder<Message>,
	model: Model,
	currentPath: string,
	avatar: Html,
	tip: RailTip = NO_TIP,
): Html =>
	sidebarFooter(h, [
		sidebarMenu(h, undefined, [
			footerNavRow(
				h,
				currentPath,
				{ href: "/integrations", title: "Integrations", icon: "GridIcon" },
				tip,
			),
			footerNavRow(h, currentPath, { href: "/settings", title: "Settings", icon: "GearIcon" }, tip),
		]),
		h.div([h.Class("-mx-2 border-sidebar-border border-t px-2 pt-2")], [footerCluster(h, model, avatar)]),
	])

/** `Code Review`'s "Beta" tag. */
export const navBadge = (h: HtmlBuilder<Message>, label: string): Html =>
	sidebarMenuBadge(h, [
		badge(h, { className: "gap-0.5 bg-primary font-semibold text-primary-foreground", variant: "tag" }, [
			h.span([h.Class("badge-shiny")], [label]),
		]),
	])
