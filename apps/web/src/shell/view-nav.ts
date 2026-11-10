import { isClerkAuthEnabled } from "../platform/auth-mode"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr, String as Str } from "effect"
import type { InfraSurfaceLiteral } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, iconColor } from "@maple/views/ui/icon"
import {
	sidebarGroup,
	sidebarGroupContent,
	sidebarGroupLabel,
	sidebarGroupToggle,
	sidebarMenu,
	sidebarMenuBadge,
	sidebarMenuButton,
	sidebarMenuItem,
	sidebarMenuSub,
	sidebarMenuSubButton,
	sidebarMenuSubItem,
} from "@maple/views/ui/sidebar"
import type { PinnedDashboardRow } from "./dashboards-shape"
import { Menu, Message } from "./message"
import { type Model, type ShellClerk, shellProbe, shellSurfaces } from "./model"
import {
	isNavItemActive,
	matchSubItem,
	type NavGroup,
	type NavFlags,
	type NavItem,
	type NavSubItem,
	type NavSurface,
	navGroups,
	navPreview,
	partitionSubItems,
} from "./nav"
import { GROUP_LABEL, NO_TIP, navBadge, type RailTip, triggerFor } from "./view-sidebar"
import { typography } from "@maple/views/ui/typography"

/**
 * Self-hosted turns every rollout on; a Clerk org reads its public
 * metadata, and fails closed (no flagged rows) until Clerk has an org.
 */
export const shellNavGroups = (clerk: ShellClerk | null = null): ReadonlyArray<NavGroup> => {
	const flag = (name: keyof NavFlags) =>
		!isClerkAuthEnabled ||
		(clerk !== null && Option.exists(clerk.maybeOrganization, (organization) => organization.flags[name]))
	return navGroups({
		releases: flag("releases"),
		securityAudit: flag("securityAudit"),
		statusPages: flag("statusPages"),
	})
}

/** The last-hour probe's answer; `null` while it is first in flight or after it failed. */
export const presenceOf = (model: Model): ReadonlyArray<InfraSurfaceLiteral> | null => {
	const probe = shellProbe(model)
	return probe === "failed" ? null : probe
}

const NO_SURFACES: ReadonlySet<NavSurface> = new Set()

/**
 * The surfaces the nav filters by: every one when the probe failed, none of the optional ones
 * while the answer is pending, so rows only ever appear once.
 */
export const surfacesOf = (model: Model): ReadonlySet<NavSurface> | null => {
	const surfaces = shellSurfaces(model)
	switch (surfaces._tag) {
		case "Pending":
			return NO_SURFACES
		case "Every":
			return null
		case "Only":
			return surfaces.surfaces
	}
}

const activeSubHrefOf = (subItems: ReadonlyArray<NavSubItem>, currentPath: string): string | undefined =>
	Arr.reduce<NavSubItem, { href: string; length: number } | undefined>(subItems, undefined, (best, sub) => {
		const matched = matchSubItem(currentPath, sub)
		return matched !== undefined && (best === undefined || matched.length > best.length)
			? { href: sub.href, length: matched.length }
			: best
	})?.href

const collapsedSectionRow = (h: HtmlBuilder<Message>, model: Model, item: NavItem, isActive: boolean): Html =>
	sidebarMenuItem(h, undefined, [
		sidebarMenuButton(
			h,
			{
				rail: "active",
				isActive,
				slot: "dropdown-menu-trigger",
				attributes: triggerFor(h, model, Menu.NavSection({ title: item.title })),
			},
			[icon(h, item.icon, { size: 18 }), h.span([], [item.title])],
		),
	])

/** The live count a sub-item shows, when it has one and it is above zero (an org change clears it). */
const subCountOf = (model: Model, sub: NavSubItem): number | undefined =>
	sub.count === "alertsInbox" && model.alertsInboxCount !== null && model.alertsInboxCount > 0
		? model.alertsInboxCount
		: undefined

const subList = (
	h: HtmlBuilder<Message>,
	model: Model,
	subItems: ReadonlyArray<NavSubItem>,
	currentPath: string,
): Html => {
	const activeSubHref = activeSubHrefOf(subItems, currentPath)
	return sidebarMenuSub(
		h,
		"mx-0 ms-4 translate-x-0 gap-0 border-l-0 px-0 py-0",
		Arr.map(subItems, (sub, index) => {
			const count = subCountOf(model, sub)
			return sidebarMenuSubItem(
				h,
				cn(
					"border-l-2 ps-2.5",
					sub.href === activeSubHref ? "border-sidebar-primary" : "border-sidebar-border",
					// A 4px gap, not a rule, sets a group of rows apart.
					sub.startsGroup === true && index > 0 && "mt-1",
				),
				[
					sidebarMenuSubButton(
						h,
						{
							className:
								"translate-x-0 data-[active=true]:text-sidebar-primary [&>svg]:text-current",
							isActive: sub.href === activeSubHref,
							link: { href: sub.href, currentPath },
						},
						[
							...(sub.icon === undefined
								? []
								: [
										icon(h, sub.icon, {
											className: "size-3.5",
											...iconColor(sub.iconColor),
										}),
									]),
							h.span([], [sub.title]),
						],
					),
					...(count === undefined
						? []
						: [
								sidebarMenuBadge(
									h,
									[
										typography(
											h,
											{ size: "xs", mono: true, numeric: true, tone: "error" },
											[String(count)],
										),
									],
									"top-1/2 -translate-y-1/2",
								),
							]),
				],
			)
		}),
	)
}

/**
 * `NavRow`: a link, a section with its children while active, or on the collapsed rail a menu. In a
 * folded group the current section keeps its row and, of its children, the current one alone.
 */
const navRow = (
	h: HtmlBuilder<Message>,
	model: Model,
	item: NavItem,
	currentPath: string,
	tip: RailTip,
	isGroupFolded = false,
): Html => {
	const isActive = isNavItemActive(currentPath, item)
	const isCollapsed = !model.isSidebarOpen && !model.isMobile
	const allSubItems =
		item.subItems === undefined
			? undefined
			: partitionSubItems(item.subItems, surfacesOf(model), currentPath).shown
	if (isCollapsed && allSubItems !== undefined && allSubItems.length > 0)
		return collapsedSectionRow(h, model, item, isActive)
	// A folded group keeps where you are: the section row and, under it, the current sub-item alone.
	const subItems =
		isGroupFolded && allSubItems !== undefined
			? Arr.filter(allSubItems, (sub) => sub.href === activeSubHrefOf(allSubItems, currentPath))
			: allSubItems
	const isOpen = subItems !== undefined && subItems.length > 0 && isActive
	// The tint belongs to the sub-item that is the current page, when one is.
	const hasActiveChild = isOpen && activeSubHrefOf(subItems, currentPath) !== undefined
	const preview = isOpen || allSubItems === undefined ? undefined : navPreview(item, allSubItems)
	return sidebarMenuItem(h, undefined, [
		sidebarMenuButton(
			h,
			{
				rail: isOpen ? "lane" : "active",
				isActive,
				hasActiveChild,
				link: { href: item.href, currentPath },
				hasTooltip: true,
				attributes: tip(item.title),
			},
			[
				icon(h, item.icon, { size: 18 }),
				h.span([h.Class("flex-1 truncate")], [item.title]),
				...(preview === undefined
					? []
					: [
							h.span(
								[
									h.Class(
										"flex shrink-0 items-center gap-0.5 text-muted-foreground group-data-[collapsible=icon]:hidden",
									),
								],
								[
									...Arr.flatMap(preview.glyphs, (sub) =>
										sub.icon === undefined
											? []
											: [
													icon(h, sub.icon, {
														className: "size-3",
														...iconColor(sub.iconColor),
													}),
												],
									),
									...(preview.overflow > 0
										? [
												h.span(
													[h.Class("ms-0.5 text-2xs tabular-nums")],
													[`+${preview.overflow}`],
												),
											]
										: []),
								],
							),
						]),
			],
		),
		...(item.badge === undefined ? [] : [navBadge(h, item.badge)]),
		...(subItems !== undefined && isActive && (subItems.length > 0 || !isGroupFolded)
			? [subList(h, model, subItems, currentPath)]
			: []),
	])
}

const MAX_PINNED = 5

/** Starred dashboards (device-local favorites), capped, hidden on the collapsed rail. */
export const pinnedGroup = (
	h: HtmlBuilder<Message>,
	model: Model,
	currentPath: string,
): ReadonlyArray<Html> => {
	const dashboards: ReadonlyArray<PinnedDashboardRow> = AsyncData.getOrElse(
		model.dashboards,
		(): ReadonlyArray<PinnedDashboardRow> => [],
	)
	const pinned = Arr.filter(dashboards, (dashboard) => model.dashboardFavorites.includes(dashboard.id))
	const visible = pinned.slice(0, MAX_PINNED)
	if (!AsyncData.isSuccess(model.dashboards) || visible.length === 0) return []
	const overflow = pinned.length - visible.length
	const activeDashboardId = Option.flatMap(Str.match(/^\/dashboards\/([^/]+)/)(currentPath), (match) =>
		Option.fromUndefinedOr(match[1]),
	)
	return [
		sidebarGroup(h, "group-data-[collapsible=icon]:hidden", [
			sidebarGroupLabel(h, GROUP_LABEL, [
				h.span([h.Class("flex-1")], ["Pinned dashboards"]),
				typography(h, { weight: "normal", numeric: true }, [String(pinned.length)]),
			]),
			sidebarGroupContent(h, [
				sidebarMenu(h, undefined, [
					...Arr.map(visible, (dashboard) =>
						sidebarMenuItem(h, undefined, [
							sidebarMenuButton(
								h,
								{
									size: "sm",
									rail: "active",
									isActive: Option.contains(activeDashboardId, dashboard.id),
									link: {
										href: `/dashboards/${encodeURIComponent(dashboard.id)}`,
										currentPath,
									},
								},
								[
									icon(h, "GridSquareCirclePlusIcon", {
										className: "size-3.5 text-muted-foreground",
									}),
									h.span([h.Title(dashboard.name)], [dashboard.name]),
								],
							),
						]),
					),
					...(overflow > 0
						? [
								sidebarMenuItem(h, undefined, [
									sidebarMenuButton(
										h,
										{
											size: "sm",
											rail: "active",
											className: "text-muted-foreground",
											link: { href: "/dashboards", currentPath },
										},
										[
											h.span([h.Class("size-3.5 shrink-0")], []),
											h.span([], [`${overflow} more…`]),
										],
									),
								]),
							]
						: []),
				]),
			]),
		]),
	]
}

export type NavGroupFold = "unlabelled" | "rail" | "expanded" | "collapsed"

/**
 * How a group's rows show. The collapsed rail hides labels, so every row shows there; elsewhere a
 * labelled group folds to the current page's row (without its sub-items), if it holds it.
 */
export const navGroupFold = (model: Model, group: NavGroup): NavGroupFold => {
	if (group.label === undefined) return "unlabelled"
	if (!model.isSidebarOpen && !model.isMobile) return "rail"
	return model.collapsedNavGroups.includes(group.id) ? "collapsed" : "expanded"
}

const navGroupContentId = (group: NavGroup) => `shell-nav-group-${group.id}`

export const navGroupSections = (
	h: HtmlBuilder<Message>,
	model: Model,
	currentPath: string,
	tip: RailTip = NO_TIP,
	clerk: ShellClerk | null = null,
): ReadonlyArray<Html> =>
	Arr.map(shellNavGroups(clerk), (group) => {
		const fold = navGroupFold(model, group)
		const rows =
			fold === "collapsed"
				? Arr.filter(group.items, (item) => isNavItemActive(currentPath, item))
				: group.items
		return sidebarGroup(h, undefined, [
			...(group.label === undefined
				? []
				: fold === "rail"
					? // Hidden on the rail: a plain label keeps the spacing and is no tab stop.
						[sidebarGroupLabel(h, GROUP_LABEL, [group.label])]
					: [
							sidebarGroupToggle(h, {
								label: group.label,
								isExpanded: fold !== "collapsed",
								controlsId: navGroupContentId(group),
								onToggle: Message.ClickedNavGroup({ groupId: group.id }),
							}),
						]),
			sidebarGroupContent(
				h,
				rows.length === 0
					? []
					: [
							sidebarMenu(
								h,
								undefined,
								Arr.map(rows, (item) =>
									navRow(h, model, item, currentPath, tip, fold === "collapsed"),
								),
							),
						],
				[h.Id(navGroupContentId(group))],
			),
		])
	})
