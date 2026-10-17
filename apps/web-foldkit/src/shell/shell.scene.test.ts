import * as Animation from "@foldkit/ui/animation"
import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import {
	Command,
	click,
	Subscription,
	expect,
	expectHandled,
	expectOutMessage,
	given,
	hover,
	keydown,
	Mount,
	role,
	scene,
	selector,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, test } from "vitest"
import { FocusElement, SaveNamespace, SaveSidebarState, SaveTheme } from "./command"
import { LoadNamespaces } from "./data"
import { Menu, Message, OutMessage } from "./message"
import { init, type Model } from "./model"
import { PositionMenu } from "./mounts"
import { update } from "./update"
import * as Tooltip from "../ui/tooltip"
import { CheckDeployedCommit, ReloadPage } from "./version"
import { frameView, menuLayerView, sheetLayerView } from "./view"

const flags = { isMobile: false, theme: "dark", pinnedNamespaces: {}, dashboardFavorites: [] } as const

const signedIn = (overrides: Partial<Model> = {}): Model => ({
	...init(flags),
	maybeOrgId: Option.some("org_parity"),
	...overrides,
})

/** The shell as the root embeds it: the frame, then the sheet and menu layers. */
const shellAt = (currentPath: string) => {
	const frame = withViewInputs(frameView, {
		currentPath,
		breadcrumbs: [{ label: "Overview" }],
		page: () => [],
	})()
	const sheet = withViewInputs(sheetLayerView, { currentPath })()
	const menu = withViewInputs(menuLayerView, { currentPath })()
	return (model: Model, h: HtmlBuilder<Message>) =>
		h.div([], [frame(model, h), sheet(model, h), menu(model, h)])
}

const view = shellAt("/")

const sidebar = selector('[data-slot="sidebar"]')
const toggle = role("button", { name: "Toggle sidebar" })

const position = (menu: Menu) =>
	Message.MeasuredMenuPopup({
		menu,
		position: {
			side: "top",
			align: "start",
			x: 8,
			y: 722,
			availableWidth: 1430,
			availableHeight: 851,
			anchorWidth: 203,
			anchorHeight: 32,
			transformOrigin: "0% calc(100% + 4px)",
			anchor: { x: 8, y: 860, width: 203, height: 32 },
		},
	})
// TESTS

describe("sidebar collapse", () => {
	test("the trigger folds the rail to icons, saves the cookie, and turns sections into menus", () => {
		scene(
			{ update, view },
			given(signedIn()),
			expect(sidebar).toHaveAttr("data-state", "expanded"),
			expect(role("link", { name: "Explore" })).toExist(),
			click(toggle),
			Command.expectExact(SaveSidebarState({ isOpen: false })),
			Command.resolve(SaveSidebarState, Message.CompletedSaveSidebarState()),
			expect(sidebar).toHaveAttr("data-state", "collapsed"),
			expect(sidebar).toHaveAttr("data-collapsible", "icon"),
			expect(role("button", { name: "Explore" })).toHaveAttr("aria-haspopup", "menu"),
			click(toggle),
			Command.resolve(SaveSidebarState, Message.CompletedSaveSidebarState()),
			expect(sidebar).toHaveAttr("data-state", "expanded"),
		)
	})

	test("on the collapsed rail a row shows its title as a tooltip after the open delay", () => {
		const settings = role("link", { name: "Settings" })
		scene(
			{ update, view },
			given(signedIn({ isSidebarOpen: false })),
			hover(settings),
			Command.resolve(Tooltip.WaitOpenDelay, Tooltip.Message.ElapsedOpenDelay({ generation: 1 })),
			Mount.resolve(Tooltip.MountTooltip, Tooltip.Message.CompletedMountTooltip()),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			expect(settings).toHaveAttr("data-popup-open", ""),
			expect(selector('[data-slot="tooltip-popup"]')).toHaveText("Settings"),
		)
	})

	test("below md the trigger opens the nav as a sheet, and the backdrop closes it", () => {
		scene(
			{ update, view },
			given(signedIn({ isMobile: true })),
			expect(sidebar).toBeAbsent(),
			click(toggle),
			Command.expectNone(),
			expect(role("dialog", { name: "Sidebar" })).toExist(),
			click(selector('[data-slot="sheet-backdrop"]')),
			expect(role("dialog", { name: "Sidebar" })).toBeAbsent(),
		)
	})
})

describe("menus", () => {
	test("the user menu opens over its trigger and Escape hands focus back to it", () => {
		scene(
			{ update, view },
			given(signedIn()),
			click(role("button", { name: /Root$/ })),
			expect(role("button", { name: /Root$/ })).toHaveAttr("aria-expanded", "true"),
			expect(role("menu")).toExist(),
			Mount.expectExact(PositionMenu),
			Mount.resolve(PositionMenu, position(Menu.User())),
			expect(selector('[data-slot="dropdown-menu-content"]')).toHaveAttr("data-side", "top"),
			expect(role("menuitem", { name: "Log out" })).toExist(),
			keydown(role("menu"), "Escape"),
			expectHandled(),
			Command.expectExact(FocusElement({ id: "shell-user-menu" })),
			Command.resolve(FocusElement, Message.CompletedFocusElement()),
			expect(role("menu")).toBeAbsent(),
			Mount.expectEnded(PositionMenu),
		)
	})

	test("the dark mode switch flips the theme without closing the menu", () => {
		scene(
			{ update, view },
			given(signedIn()),
			click(role("button", { name: /Root$/ })),
			Mount.resolve(PositionMenu, position(Menu.User())),
			expect(role("switch", { name: "Toggle dark mode" })).toBeChecked(),
			click(role("switch", { name: "Toggle dark mode" })),
			Command.expectExact(SaveTheme({ theme: "light" })),
			Command.resolve(SaveTheme, Message.CompletedSaveTheme()),
			expect(role("switch", { name: "Toggle dark mode" })).not.toBeChecked(),
			expect(role("menu")).toExist(),
		)
	})
})
// ORG SWITCHER

describe("org switcher", () => {
	test("opening loads the namespaces once; picking one pins it for this org and reports it", () => {
		scene(
			{ update, view },
			given(signedIn()),
			click(role("button", { name: /Self Hosted/ })),
			Command.expectExact(LoadNamespaces()),
			Mount.resolve(PositionMenu, position(Menu.Org())),
			expect(text(/Loading namespaces/)).toExist(),
			Command.resolve(
				LoadNamespaces,
				Message.SucceededLoadNamespaces({ namespaces: ["checkout", "shop"] }),
			),
			expect(role("menuitem", { name: "All namespaces" })).toExist(),
			click(role("menuitem", { name: "shop" })),
			expectOutMessage(OutMessage.ChangedGlobalNamespace({ maybeNamespace: Option.some("shop") })),
			Command.expectExact(SaveNamespace({ orgId: "org_parity", maybeNamespace: Option.some("shop") })),
			Command.resolve(SaveNamespace, Message.CompletedSaveNamespace()),
			expect(role("menu")).toBeAbsent(),
			Mount.expectEnded(PositionMenu),
			expect(role("button", { name: /^Self Hosted\s*shop$/ })).toExist(),
			click(role("button", { name: /^Self Hosted\s*shop$/ })),
			Command.expectNone(),
			Mount.resolve(PositionMenu, position(Menu.Org())),
			click(role("menuitem", { name: "All namespaces" })),
			Command.resolve(SaveNamespace, Message.CompletedSaveNamespace()),
			Mount.expectEnded(PositionMenu),
			expect(role("button", { name: "Self Hosted" })).toExist(),
		)
	})
})

describe("app update banner", () => {
	test("a newer deployed build shows the reload banner; Reload reloads the tab", () => {
		scene(
			{ update, view },
			given(signedIn()),
			expect(role("alert")).toBeAbsent(),
			Subscription.emit(Message.BecameTabVisible()),
			Command.resolve(
				CheckDeployedCommit,
				Message.CheckedDeployedCommit({ maybeCommit: Option.none() }),
			),
			expect(role("alert")).toBeAbsent(),
			Subscription.emit(Message.ElapsedVersionPollInterval()),
			Command.resolve(
				CheckDeployedCommit,
				Message.CheckedDeployedCommit({ maybeCommit: Option.some("f00dfeed") }),
			),
			expect(role("alert")).toContainText("Maple was updated"),
			click(role("button", { name: "Reload" })),
			Command.expectExact(ReloadPage()),
			Command.resolve(ReloadPage, Message.CompletedReloadPage()),
		)
	})
})

describe("infrastructure section", () => {
	test("on an infra page only the sources the org reports or connected are listed", () => {
		scene(
			{ update, view: shellAt("/infra") },
			given(
				signedIn({
					infraPresence: { _tag: "Success", data: ["hosts"] },
					integrations: { cloudflare: true, railway: false, planetscale: false, gcp: false },
				}),
			),
			expect(role("link", { name: "Hosts" })).toExist(),
			expect(role("link", { name: "Cloudflare" })).toExist(),
			expect(role("link", { name: "Kubernetes" })).toBeAbsent(),
			expect(role("link", { name: "Railway" })).toBeAbsent(),
		)
	})
})
