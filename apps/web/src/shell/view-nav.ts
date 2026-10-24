import { isClerkAuthEnabled } from "../lib/services/common/auth-mode"
import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import { Option } from "effect"
import type { InfraSurfaceLiteral } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, iconColor } from "../ui/icon"
import {
	sidebarGroup,
	sidebarGroupContent,
	sidebarGroupLabel,
	sidebarMenu,
	sidebarMenuButton,
	sidebarMenuItem,
	sidebarMenuSub,
	sidebarMenuSubButton,
	sidebarMenuSubItem,
} from "../ui/sidebar"
import type { PinnedDashboardRow } from "./dashboards-shape"
import { Menu, Message } from "./message"
import { type Model, type ShellClerk, shellProbe, shellSurfaces } from "./model"
import {
	isNavItemActive,
	matchSubItem,
	type NavGroup,
	type NavItem,
	type NavSubItem,
	type NavSurface,
	navGroups,
	navPreview,
	partitionSubItems,
} from "./nav"
import { ACTIVE_RAIL, GROUP_LABEL, NO_TIP, navBadge, type RailTip, triggerFor } from "./view-sidebar"

/**
 * `useOrganizationFeatureFlags`: self-hosted turns every rollout on; a Clerk org reads its public
 * metadata, and fails closed (no flagged rows) until Clerk has an org.
 */
export const shellNavGroups = (clerk: ShellClerk | null = null): ReadonlyArray<NavGroup> =>
	navGroups({
		releases:
			!isClerkAuthEnabled ||
			(clerk !== null && Option.exists(clerk.maybeOrganization, (organization) => organization.flags.releases)),
	})

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
	return surfaces._tag === "Every" ? null : surfaces._tag === "Only" ? surfaces.surfaces : NO_SURFACES
}

const activeSubHrefOf = (subItems: ReadonlyArray<NavSubItem>, currentPath: string): string | undefined =>
	subItems.reduce<{ href: string; length: number } | undefined>((best, sub) => {
		const matched = matchSubItem(currentPath, sub)
		return matched !== undefined && (best === undefined || matched.length > best.length)
			? { href: sub.href, length: matched.length }
			: best
	}, undefined)?.href
// ROWS

const collapsedSectionRow = (h: HtmlBuilder<Message>, model: Model, item: NavItem, isActive: boolean): Html =>
	sidebarMenuItem(h, undefined, [
		sidebarMenuButton(
			h,
			{
				className: ACTIVE_RAIL,
				isActive,
				slot: "dropdown-menu-trigger",
				attributes: triggerFor(h, model, Menu.NavSection({ title: item.title })),
			},
			[icon(h, item.icon, { size: 18 }), h.span([], [item.title])],
		),
	])

const subList = (h: HtmlBuilder<Message>, subItems: ReadonlyArray<NavSubItem>, currentPath: string): Html => {
	const activeSubHref = activeSubHrefOf(subItems, currentPath)
	return sidebarMenuSub(
		h,
		"mx-0 ms-4 translate-x-0 gap-0 border-l-0 px-0 py-0",
		subItems.map((sub) =>
			sidebarMenuSubItem(
				h,
				sub.href === activeSubHref
					? "border-sidebar-primary border-l-2 ps-2.5"
					: "border-sidebar-border border-l-2 ps-2.5",
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
				],
			),
		),
	)
}

/** `NavRow`: a link, a section with its children while active, or on the collapsed rail a menu. */
const navRow = (
	h: HtmlBuilder<Message>,
	model: Model,
	item: NavItem,
	currentPath: string,
	tip: RailTip,
): Html => {
	const isActive = isNavItemActive(currentPath, item)
	const isCollapsed = !model.isSidebarOpen && !model.isMobile
	const subItems =
		item.subItems === undefined
			? undefined
			: partitionSubItems(item.subItems, surfacesOf(model), currentPath).shown
	if (isCollapsed && subItems !== undefined && subItems.length > 0)
		return collapsedSectionRow(h, model, item, isActive)
	const isOpen = subItems !== undefined && subItems.length > 0 && isActive
	const preview = isOpen || subItems === undefined ? undefined : navPreview(item, subItems)
	return sidebarMenuItem(h, undefined, [
		sidebarMenuButton(
			h,
			{
				className: isOpen ? ROW_LANE : ACTIVE_RAIL,
				isActive,
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
									...preview.glyphs.flatMap((sub) =>
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
										? [h.span([h.Class("ms-0.5 text-2xs tabular-nums")], [`+${preview.overflow}`])]
										: []),
								],
							),
						]),
			],
		),
		...(item.badge === undefined ? [] : [navBadge(h, item.badge)]),
		...(subItems !== undefined && isActive ? [subList(h, subItems, currentPath)] : []),
	])
}

const MAX_PINNED = 5

/** `PinnedGroup`: starred dashboards (device-local favorites), capped, hidden on the collapsed rail. */
export const pinnedGroup = (
	h: HtmlBuilder<Message>,
	model: Model,
	currentPath: string,
): ReadonlyArray<Html> => {
	const dashboards: ReadonlyArray<PinnedDashboardRow> = AsyncData.getOrElse(
		model.dashboards,
		(): ReadonlyArray<PinnedDashboardRow> => [],
	)
	const pinned = dashboards.filter((dashboard) => model.dashboardFavorites.includes(dashboard.id))
	const visible = pinned.slice(0, MAX_PINNED)
	if (!AsyncData.isSuccess(model.dashboards) || visible.length === 0) return []
	const overflow = pinned.length - visible.length
	const activeDashboardId = currentPath.match(/^\/dashboards\/([^/]+)/)?.[1]
	return [
		sidebarGroup(h, "group-data-[collapsible=icon]:hidden", [
			sidebarGroupLabel(h, GROUP_LABEL, [
				h.span([h.Class("flex-1")], ["Pinned dashboards"]),
				h.span([h.Class("font-normal tabular-nums")], [String(pinned.length)]),
			]),
			sidebarGroupContent(h, [
				sidebarMenu(h, undefined, [
					...visible.map((dashboard) =>
						sidebarMenuItem(h, undefined, [
							sidebarMenuButton(
								h,
								{
									size: "sm",
									className: ACTIVE_RAIL,
									isActive: activeDashboardId === dashboard.id,
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
											className: `${ACTIVE_RAIL} text-muted-foreground`,
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

export const navGroupSections = (
	h: HtmlBuilder<Message>,
	model: Model,
	currentPath: string,
	tip: RailTip = NO_TIP,
	clerk: ShellClerk | null = null,
): ReadonlyArray<Html> =>
	shellNavGroups(clerk).map((group) =>
		sidebarGroup(h, undefined, [
			...(group.label === undefined ? [] : [sidebarGroupLabel(h, GROUP_LABEL, [group.label])]),
			sidebarGroupContent(h, [
				sidebarMenu(
					h,
					undefined,
					group.items.map((item) => navRow(h, model, item, currentPath, tip)),
				),
			]),
		]),
	)
