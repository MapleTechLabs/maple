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
import { placementOf, popupIdOf, triggerIdOf } from "./menus"
import { Message } from "./message"
import type { Model } from "./model"
import { PositionMenu } from "./mounts"
import { isMenuKey } from "./update"
import { menuContent } from "./view-menus"
import { navGroupSections, pinnedGroup } from "./view-nav"
import { shellSidebarFooter, shellSidebarHeader, userAvatar } from "./view-sidebar"
import { type BreadcrumbEntry, topbar } from "./view-topbar"

export type { BreadcrumbEntry } from "./view-topbar"

/** `AppSidebar`'s three regions, shared by the desktop rail and the mobile sheet. */
const sidebarRegions = (h: HtmlBuilder<Message>, model: Model, currentPath: string): ReadonlyArray<Html> => [
	shellSidebarHeader(h, model),
	sidebarContent(h, [...navGroupSections(h, model, currentPath), ...pinnedGroup(h, model, currentPath)]),
	shellSidebarFooter(h, model, currentPath, userAvatar(h, "RT")),
]

export type FrameInputs = Readonly<{
	currentPath: string
	breadcrumbs: ReadonlyArray<BreadcrumbEntry>
	/** `PageLayout.Body` itself (`page/kit/dashboard-page.ts`): the page's filters, content and right rail. */
	page: () => Html
}>

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
export const frameView = Submodel.defineView<Model, Message, FrameInputs>((model, inputs, h) =>
	sidebarWrapper(
		h,
		[
			...(model.isMobile
				? []
				: [
						sidebarDesktop(
							h,
							model.isSidebarOpen ? "expanded" : "collapsed",
							sidebarRegions(h, model, inputs.currentPath),
						),
					]),
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
						topbar(h, model, inputs.breadcrumbs),
						...(model.isAppOutdated ? [appUpdateBanner(h)] : []),
						inputs.page(),
					],
				),
			]),
		],
		// A modal sheet hides the page behind it from assistive tech, like Base UI's `aria-hidden` root.
		model.isMobile && model.isMobileNavOpen ? [h.AriaHidden(true)] : [],
	),
)

const mobileNav = (h: HtmlBuilder<Message>, model: Model, currentPath: string): Html =>
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
		[h.div([h.Class(sidebarMobileInnerStyles)], sidebarRegions(h, model, currentPath))],
	)
// OVERLAYS

const openMenuPopup = (h: HtmlBuilder<Message>, model: Model, currentPath: string): ReadonlyArray<Html> =>
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
					menuContent(h, model, menu, currentPath),
				),
			]
		},
	})

export type OverlayInputs = Readonly<{ currentPath: string }>

/** Base UI's sheet portal for the mobile nav, after the frame in the app root. */
export const sheetLayerView = Submodel.defineView<Model, Message, OverlayInputs>((model, inputs, h) =>
	model.isMobile && model.isMobileNavOpen ? mobileNav(h, model, inputs.currentPath) : null,
)

/** Base UI's menu portal for the open menu, last in the app root. */
export const menuLayerView = Submodel.defineView<Model, Message, OverlayInputs>(
	(model, inputs, h) => openMenuPopup(h, model, inputs.currentPath)[0] ?? null,
)
