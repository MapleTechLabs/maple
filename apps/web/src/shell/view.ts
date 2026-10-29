import { pageLayoutStyles } from "@maple/ui/styles/ui/page-layout"
import {
	sidebarMobileHeaderStyles,
	sidebarMobileInnerStyles,
	sidebarMobileStyles,
} from "@maple/ui/styles/ui/sidebar"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Submodel } from "foldkit"
import { alert, alertAction, alertDescription, alertTitle } from "../ui/alert"
import { button } from "../ui/button"
import { menuPopup } from "../ui/dropdown-menu"
import { icon } from "../ui/icon"
import { leftSheet } from "../ui/sheet"
import { sidebarContent, sidebarDesktop, sidebarInset, sidebarWrapper } from "../ui/sidebar"
import * as Tooltip from "../ui/tooltip"
import { placementOf, popupIdOf, triggerIdOf } from "./menus"
import { billingBanners } from "./billing-banners"
import * as SupportChannelView from "./support-channel-view"
import { Message } from "./message"
import type { Model, ShellClerk } from "./model"
import { MeasureSidebarOverflow, PositionMenu } from "./mounts"
import { isMenuKey } from "./update"
import { menuContent } from "./view-menus"
import { navGroupSections, pinnedGroup, shellNavGroups } from "./view-nav"
import { NO_TIP, type RailTip, shellSidebarFooter, shellSidebarHeader } from "./view-sidebar"
import { type BreadcrumbEntry, hidesTopbarConnect, topbar } from "./view-topbar"
import { splitPageRails } from "./page-rails"
import { filterSheet, filterSheetTrigger, rightSheet, rightSheetTrigger } from "./view-page-sheets"
import { FLAGGED_HREFS } from "./palette/entries"
import { paletteView } from "./palette/view"
import { shortcutsDialogView } from "./palette/shortcuts-view"
import { paletteContextOf } from "./update-palette"

export type { BreadcrumbEntry } from "./view-topbar"

/** `AppSidebar`'s three regions, shared by the desktop rail and the mobile sheet. */
const sidebarRegions = (
	h: HtmlBuilder<Message>,
	model: Model,
	currentPath: string,
	clerk: ShellClerk | null,
	tip: RailTip = NO_TIP,
): ReadonlyArray<Html> => [
	shellSidebarHeader(h, model, clerk, tip),
	sidebarContent(
		h,
		[...navGroupSections(h, model, currentPath, tip, clerk), ...pinnedGroup(h, model, currentPath)],
		[h.OnMount(MeasureSidebarOverflow())],
	),
	shellSidebarFooter(h, model, currentPath, clerk, tip),
]

const RAIL_TIP_PREFIX = "shell-rail-tip-"

/** The rows that carry a rail tooltip: Search, the nav rows this org is shown, the footer links. */
const railTipTitles = (clerk: ShellClerk | null): ReadonlyArray<string> => [
	"Search",
	...shellNavGroups(clerk).flatMap((group) => group.items.map((item) => item.title)),
	"Sources",
	"Settings",
]

/** The desktop rail; collapsed, its rows share one Tooltip naming the row (`tooltip={title}`). */
const desktopSidebar = (
	h: HtmlBuilder<Message>,
	model: Model,
	currentPath: string,
	clerk: ShellClerk | null,
): Html => {
	const isInstant = model.isSidebarToggleInstant
	if (model.isSidebarOpen)
		return sidebarDesktop(
			h,
			"expanded",
			sidebarRegions(h, model, currentPath, clerk),
			undefined,
			isInstant,
		)
	return h.submodel({
		slotId: "shell-rail-tooltip",
		model: model.railTooltip,
		view: Tooltip.view,
		viewInputs: {
			toView: ({ trigger, portal }) =>
				sidebarDesktop(
					h,
					"collapsed",
					[
						...sidebarRegions(h, model, currentPath, clerk, (title) =>
							trigger(`${RAIL_TIP_PREFIX}${title}`),
						),
						...(portal === null ? [] : [portal]),
					],
					undefined,
					isInstant,
				),
			toContent: (triggerId) => [triggerId.slice(RAIL_TIP_PREFIX.length)],
			triggerIds: railTipTitles(clerk).map((title) => `${RAIL_TIP_PREFIX}${title}`),
		},
		toParentMessage: (message) => Message.GotRailTooltipMessage({ message }),
	})
}

export type FrameInputs = Readonly<{
	currentPath: string
	/** Clerk mode: the user, orgs and customer the sidebar and banners read. */
	clerk?: ShellClerk | null
	breadcrumbs: ReadonlyArray<BreadcrumbEntry>
	/** `PageLayout.Body` itself (`page/kit/dashboard-page.ts`): the page's filters, content and right rail. */
	page: () => Html
	/** `DashboardPage`'s `topbarActions`, after the shell's own buttons. */
	topbarActions: () => Html
}>

const supportChannelDialog = (h: HtmlBuilder<Message>, model: Model, clerk: ShellClerk): Html =>
	h.submodel({
		slotId: "shell-support-channel",
		model: model.supportChannel,
		view: SupportChannelView.view,
		viewInputs: { email: Option.flatMapNullishOr(clerk.maybeUser, (user) => user.email) },
		toParentMessage: (message) => Message.GotSupportChannelMessage({ message }),
	})

/** `AppUpdateBanner`: not dismissible, a stale bundle may not read what the new build writes. */
const appUpdateBanner = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("px-4 pt-3")],
		[
			alert(h, {}, [
				icon(h, "ArrowRotateClockwiseIcon", { size: 16 }),
				alertTitle(h, ["Maple was updated"]),
				alertDescription(h, ["Reload to use the latest version."]),
				alertAction(h, [
					button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedReload())] }, ["Reload"]),
				]),
			]),
		],
	)

/** `DashboardLayout.Root` + `Breadcrumbs` + `Body`: sidebar, inset, skip link, top bar, page body. */
export const frameView = Submodel.defineView<Model, Message, FrameInputs>((model, inputs, h) => {
	const page = model.isFilterCollapsed
		? splitPageRails(inputs.page())
		: { body: inputs.page(), maybeFilters: Option.none(), maybeRight: Option.none() }
	const railTriggers = [
		...(Option.isSome(page.maybeFilters) ? [filterSheetTrigger(h, model)] : []),
		...(Option.isSome(page.maybeRight) ? [rightSheetTrigger(h, model)] : []),
	]
	const railSheets = [
		...Option.toArray(Option.map(page.maybeFilters, (rail) => filterSheet(h, model, rail))),
		...Option.toArray(Option.map(page.maybeRight, (rail) => rightSheet(h, model, rail))),
	]
	return sidebarWrapper(
		h,
		[
			...(model.isMobile ? [] : [desktopSidebar(h, model, inputs.currentPath, inputs.clerk ?? null)]),
			sidebarInset(h, [
				h.a(
					[
						h.Class(
							"sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground",
						),
						h.Href("#main-content"),
					],
					["Skip to main content"],
				),
				h.div(
					[h.Class(pageLayoutStyles), h.DataAttribute("slot", "page-layout")],
					[
						topbar(
							h,
							model,
							inputs.breadcrumbs,
							inputs.topbarActions(),
							railTriggers,
							!hidesTopbarConnect(inputs.currentPath),
						),
						...(model.isAppOutdated ? [appUpdateBanner(h)] : []),
						...(inputs.clerk === undefined || inputs.clerk === null
							? []
							: billingBanners(
									h,
									Option.fromNullishOr(inputs.clerk.customer),
									model.isQuotaApproachingDismissed,
								)),
						page.body,
					],
				),
				// The rails' sheets below `lg` (each portal moves itself to <body> while open).
				...railSheets,
				// Clerk: the Support menu's shared Slack channel dialog (its portal moves to <body>).
				...(inputs.clerk === undefined || inputs.clerk === null
					? []
					: [supportChannelDialog(h, model, inputs.clerk)]),
			]),
		],
		// A modal sheet hides the page behind it from assistive tech, like Base UI's `aria-hidden` root.
		model.isMobile && model.isMobileNavOpen ? [h.AriaHidden(true)] : [],
	)
})

const mobileNav = (
	h: HtmlBuilder<Message>,
	model: Model,
	currentPath: string,
	clerk: ShellClerk | null,
): Html =>
	leftSheet(
		h,
		{
			id: "shell-mobile-sidebar",
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
		[h.div([h.Class(sidebarMobileInnerStyles)], sidebarRegions(h, model, currentPath, clerk))],
	)
// OVERLAYS

const openMenuPopup = (
	h: HtmlBuilder<Message>,
	model: Model,
	currentPath: string,
	clerk: ShellClerk | null,
): ReadonlyArray<Html> =>
	Option.match(model.openMenu, {
		onNone: () => [],
		onSome: ({ menu, maybePosition }) => {
			const placement = placementOf(menu)
			const triggerId = triggerIdOf(menu)
			const popupId = popupIdOf(menu)
			return [
				menuPopup(
					h,
					{
						popupId,
						triggerId,
						side: placement.side,
						align: placement.align,
						className: placement.className,
						maybePosition,
						mount: h.OnMount(
							PositionMenu({
								menu,
								triggerId,
								popupId,
								side: placement.side,
								align: placement.align,
								sideOffset: placement.sideOffset,
							}),
						),
						onDismiss: Message.DismissedMenu(),
						onKeyDown: (key) =>
							isMenuKey(key) ? Option.some(Message.PressedMenuKey({ key })) : Option.none(),
					},
					menuContent(h, model, menu, currentPath, clerk),
				),
			]
		},
	})

export type OverlayInputs = Readonly<{ currentPath: string; clerk?: ShellClerk | null }>

/** Base UI's sheet portal for the mobile nav, after the frame in the app root. */
export const sheetLayerView = Submodel.defineView<Model, Message, OverlayInputs>((model, inputs, h) =>
	model.isMobile && model.isMobileNavOpen
		? mobileNav(h, model, inputs.currentPath, inputs.clerk ?? null)
		: null,
)

/** A box-less holder that always renders, so a portal moved to `<body>` is never an insertion point. */
const layer = (h: HtmlBuilder<Message>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Style({ display: "contents" })], children)

/** `CommandPalette`'s portal while it is mounted. */
export const paletteLayerView = Submodel.defineView<Model, Message, OverlayInputs>((model, inputs, h) =>
	layer(
		h,
		model.palette === null
			? []
			: [
					paletteView(
						h,
						model.palette,
						{
							context: paletteContextOf(model),
							visibleFlagged: shellNavGroups(inputs.clerk ?? null).flatMap((group) =>
								group.items.flatMap((item) =>
									FLAGGED_HREFS.has(item.href) ? [item.href] : [],
								),
							),
						},
						(message) => Message.GotPaletteMessage({ message }),
					),
				],
	),
)

/** `KeyboardShortcutsDialog`'s portal while it is mounted. */
export const shortcutsLayerView = Submodel.defineView<Model, Message, OverlayInputs>((model, _inputs, h) =>
	layer(
		h,
		model.shortcutsDialog === null
			? []
			: [
					shortcutsDialogView(
						h,
						model.shortcutsDialog,
						model.platform,
						(message) => Message.GotShortcutsDialogMessage({ message }),
						Message.MeasuredShortcutsPanel(),
					),
				],
	),
)

/** Base UI's menu portal for the open menu, last in the app root. */
export const menuLayerView = Submodel.defineView<Model, Message, OverlayInputs>(
	(model, inputs, h) => openMenuPopup(h, model, inputs.currentPath, inputs.clerk ?? null)[0] ?? null,
)
