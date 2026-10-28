import { cn } from "@maple/ui/lib/utils"
import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import { MAPLE_REGION_LABELS } from "@maple/domain/organization-regions"
import { initialsFrom } from "@maple/ui/lib/initials"
import { hasMultipleRegions } from "../lib/region"
import { Option, Record } from "effect"
import { AsyncData } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { warmAvatarTone } from "../ui/avatar-tone"
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
import type { Model, ShellClerk } from "./model"
import * as ClerkOrgSwitcherView from "./clerk-org-switcher-view"
import { orgAvatar } from "./clerk-org-switcher-view"

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

/** `SearchRow`: the ⌘K entry, the palette's only discoverable way in. */
const searchRow = (h: HtmlBuilder<Message>, tip: RailTip): Html =>
	sidebarMenu(h, undefined, [
		sidebarMenuItem(h, undefined, [
			sidebarMenuButton(
				h,
				{
					className:
						"border border-sidebar-border bg-background text-muted-foreground hover:bg-background hover:text-foreground",
					hasTooltip: true,
					attributes: [...tip("Search"), h.OnClick(Message.ClickedSearch())],
				},
				[
					icon(h, "MagnifierIcon", { size: 16 }),
					h.span([h.Class("flex-1 text-left")], ["Search"]),
					kbd(h, "group-data-[collapsible=icon]:hidden", ["⌘K"]),
				],
			),
		]),
	])

/** `ClerkOrgSwitcher`: the active org's avatar, name and pin, opening the Clerk org menu. */
const clerkOrgSwitcher = (h: HtmlBuilder<Message>, model: Model, clerk: ShellClerk): Html => {
	const orgName = Option.match(clerk.maybeOrganization, {
		onNone: () => "Select Organization",
		onSome: (organization) => organization.name,
	})
	// Named on the subtitle line, where it cannot squeeze the org name.
	const regionSuffix = Option.match(clerk.maybeOrganization, {
		onNone: () => "",
		onSome: (organization) =>
			hasMultipleRegions ? ` · ${MAPLE_REGION_LABELS[organization.homeRegion].short}` : "",
	})
	const pinned = pinnedNamespaceOf(model)
	return h.submodel({
		slotId: "shell-clerk-org-switcher",
		model: model.clerkOrgMenu,
		view: ClerkOrgSwitcherView.view,
		viewInputs: {
			memberships: clerk.memberships,
			activeOrgId: Option.map(clerk.maybeOrganization, (organization) => organization.id),
			side: "right",
			align: "start",
			namespaceScope: {
				pinned,
				observed: AsyncData.getOrElse(model.namespaces, (): ReadonlyArray<string> => []),
				isLoading: AsyncData.isIdle(model.namespaces) || AsyncData.isLoading(model.namespaces),
			},
			toView: ({ trigger, withTrigger }) =>
				sidebarMenu(h, undefined, [
					sidebarMenuItem(
						h,
						undefined,
						withTrigger(
							sidebarMenuButton(
								h,
								{
									size: "lg",
									className: OPEN_STATE,
									slot: "dropdown-menu-trigger",
									attributes: trigger,
								},
								[
									orgAvatar(
										h,
										orgName,
										undefined,
										Option.match(clerk.maybeOrganization, {
											onNone: () => "",
											onSome: (org) => org.imageUrl,
										}),
									),
									h.div(
										[h.Class("grid flex-1 text-left text-sm leading-tight")],
										[
											h.span(
												[h.Class("truncate font-medium"), h.Title(orgName)],
												[orgName],
											),
											Option.match(pinned, {
												onNone: () =>
													h.span(
														[h.Class("truncate text-xs text-muted-foreground")],
														regionSuffix === ""
															? ["Organization"]
															: ["Organization", regionSuffix],
													),
												onSome: (namespace) =>
													h.span(
														[h.Class("truncate text-xs")],
														[
															h.span(
																[h.Class("font-medium text-primary")],
																[namespace],
															),
															h.span(
																[h.Class("text-muted-foreground")],
																[regionSuffix],
															),
														],
													),
											}),
										],
									),
									icon(h, "ChevronExpandYIcon", { size: 16, className: "ml-auto" }),
								],
							),
						),
					),
				]),
		},
		toParentMessage: (message) => Message.GotClerkOrgMenuMessage({ message }),
	})
}

export const shellSidebarHeader = (
	h: HtmlBuilder<Message>,
	model: Model,
	clerk: ShellClerk | null,
	tip: RailTip = NO_TIP,
): Html =>
	sidebarHeader(h, [
		clerk === null ? orgSwitcher(h, model) : clerkOrgSwitcher(h, model, clerk),
		searchRow(h, tip),
	])
// FOOTER

const footerNavRow = (
	h: HtmlBuilder<Message>,
	currentPath: string,
	options: Readonly<{
		href: string
		title: string
		icon: "ConnectionIcon" | "GearIcon"
		alsoActive?: string
	}>,
	tip: RailTip,
): Html =>
	sidebarMenuItem(h, undefined, [
		sidebarMenuButton(
			h,
			{
				className: ACTIVE_RAIL,
				isActive: [
					options.href,
					...(options.alsoActive === undefined ? [] : [options.alsoActive]),
				].some((path) => currentPath === path || currentPath.startsWith(`${path}/`)),
				link: { href: options.href, currentPath },
				hasTooltip: true,
				attributes: tip(options.title),
			},
			[icon(h, options.icon, { size: 18 }), h.span([], [options.title])],
		),
	])

/** The user avatar: the Clerk image over the initials on a warm tile keyed by the name. */
export const userAvatar = (
	h: HtmlBuilder<Message>,
	initials: string,
	className?: string,
	image?: Readonly<{ url: string; label: string }>,
): Html =>
	avatarFallback(
		h,
		{
			className: cn("bg-muted", className ?? "size-6 rounded-md text-3xs"),
			fallbackClassName: cn("rounded-[inherit] font-medium", warmAvatarTone(image?.label ?? initials)),
			imageUrl: image?.url,
			imageLabel: image?.label,
		},
		initials,
	)

/** `GuestMenu`'s trigger and `SupportMenu`'s, side by side in the account cluster. */
/** `UserMenu`'s name: Clerk's full name, else the email, else "User"; self-hosted is "Root". */
export const userNameOf = (clerk: ShellClerk | null): string =>
	clerk === null
		? "Root"
		: Option.match(clerk.maybeUser, {
				onNone: () => "User",
				onSome: (user) => user.fullName ?? user.email ?? "User",
			})

const initialsOf = (clerk: ShellClerk | null): string =>
	clerk === null ? "RT" : initialsFrom(userNameOf(clerk))

/** `user.imageUrl`, empty without a Clerk user. */
export const userImageOf = (clerk: ShellClerk | null): string =>
	clerk === null ? "" : Option.match(clerk.maybeUser, { onNone: () => "", onSome: (user) => user.imageUrl })

const footerCluster = (h: HtmlBuilder<Message>, model: Model, avatar: Html, name: string): Html =>
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
								[name],
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
	clerk: ShellClerk | null,
	tip: RailTip = NO_TIP,
): Html =>
	sidebarFooter(h, [
		// The pinned footer's edge: a hairline and shadow while nav rows sit hidden below it.
		h.div(
			[
				h.AriaHidden(true),
				h.Class(
					"pointer-events-none -mx-2 -mt-2 -mb-2 h-px transition-[background-color,box-shadow] [[data-overflow-y-end]+[data-slot=sidebar-footer]>&]:bg-sidebar-border [[data-overflow-y-end]+[data-slot=sidebar-footer]>&]:shadow-[0_-6px_12px_rgb(0_0_0/0.35)]",
				),
			],
			[],
		),
		sidebarMenu(h, undefined, [
			footerNavRow(h, currentPath, { href: "/sources", title: "Sources", icon: "ConnectionIcon" }, tip),
			// `/integrations` renders inside the settings rail, so Settings owns it.
			footerNavRow(
				h,
				currentPath,
				{ href: "/settings", title: "Settings", icon: "GearIcon", alsoActive: "/integrations" },
				tip,
			),
		]),
		h.div(
			[h.Class("-mx-2 border-sidebar-border border-t px-2 pt-2")],
			[
				footerCluster(
					h,
					model,
					userAvatar(h, initialsOf(clerk), undefined, {
						url: userImageOf(clerk),
						label: userNameOf(clerk),
					}),
					userNameOf(clerk),
				),
			],
		),
	])

/** `Code Review`'s "Beta" tag. */
export const navBadge = (h: HtmlBuilder<Message>, label: string): Html =>
	sidebarMenuBadge(h, [
		badge(
			h,
			{
				className: "border border-border bg-transparent font-medium text-muted-foreground",
				variant: "tag",
			},
			[label],
		),
	])
