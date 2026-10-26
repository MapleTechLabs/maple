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
	type as typeInto,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect as expectVitest, test } from "vitest"
import { FocusElement, SaveInfraSurfaces, SaveNamespace, SaveSidebarState, SaveTheme } from "./command"
import {
	LoadAwsStatus,
	LoadCloudflareStatus,
	LoadGcpStatus,
	LoadInfraPresence,
	LoadNamespaces,
	LoadPlanetscaleStatus,
	LoadRailwayStatus,
	LoadSupabaseStatus,
} from "./data"
import { Menu, Message, OutMessage } from "./message"
import { DashboardsData, init, type Model, NamespacesData } from "./model"
import { MeasureSidebarOverflow, MountNamespaceSearch, PositionMenu } from "./mounts"
import { enter, update } from "./update"
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
		page: () => null,
		topbarActions: () => null,
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
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
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

	test("⌘B snaps the rail without its width transition, and a click animates again", () => {
		scene(
			{ update, view },
			given(signedIn()),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
			Subscription.emit(Message.PressedSidebarShortcut()),
			Command.expectExact(SaveSidebarState({ isOpen: false })),
			Command.resolve(SaveSidebarState, Message.CompletedSaveSidebarState()),
			expect(sidebar).toHaveAttr("data-state", "collapsed"),
			expect(sidebar).toHaveAttr("data-instant", ""),
			click(toggle),
			Command.resolve(SaveSidebarState, Message.CompletedSaveSidebarState()),
			expect(sidebar).toHaveAttr("data-state", "expanded"),
			expect(sidebar).not.toHaveAttr("data-instant"),
		)
	})

	test("on the collapsed rail a row shows its title as a tooltip after the open delay", () => {
		const settings = role("link", { name: "Settings" })
		scene(
			{ update, view },
			given(signedIn({ isSidebarOpen: false })),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
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

	test.each(["Releases", "Security"])(
		"the flagged %s row shows its tooltip on the collapsed rail",
		(title) => {
			const row = role("link", { name: title })
			scene(
				{ update, view },
				given(signedIn({ isSidebarOpen: false })),
				Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
				hover(row),
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
				expect(selector('[data-slot="tooltip-popup"]')).toHaveText(title),
			)
		},
	)

	test("below md the trigger opens the nav as a sheet, reading its data once, and the backdrop closes it", () => {
		const open = () => [
			click(toggle),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
			expect(role("dialog", { name: "Sidebar" })).toExist(),
		]
		const close = () => [
			click(selector('[data-slot="sheet-backdrop"]')),
			Mount.expectEnded(MeasureSidebarOverflow),
			expect(role("dialog", { name: "Sidebar" })).toBeAbsent(),
		]
		scene(
			{ update, view },
			given(signedIn({ isMobile: true })),
			expect(sidebar).toBeAbsent(),
			...open(),
			Command.expectExact(
				LoadInfraPresence,
				LoadCloudflareStatus,
				LoadPlanetscaleStatus,
				LoadRailwayStatus,
				LoadGcpStatus,
				LoadSupabaseStatus,
				LoadAwsStatus,
			),
			Command.resolveAll(
				[
					LoadInfraPresence,
					Message.SucceededLoadInfraPresence({ orgId: "org_parity", surfaces: [] }),
				],
				[
					LoadCloudflareStatus,
					Message.SucceededLoadIntegration({
						orgId: "org_parity",
						integration: "cloudflare",
						isConnected: false,
					}),
				],
				[
					LoadPlanetscaleStatus,
					Message.SucceededLoadIntegration({
						orgId: "org_parity",
						integration: "planetscale",
						isConnected: false,
					}),
				],
				[
					LoadRailwayStatus,
					Message.SucceededLoadIntegration({
						orgId: "org_parity",
						integration: "railway",
						isConnected: false,
					}),
				],
				[
					LoadGcpStatus,
					Message.SucceededLoadIntegration({
						orgId: "org_parity",
						integration: "gcp",
						isConnected: false,
					}),
				],
				[
					LoadSupabaseStatus,
					Message.SucceededLoadIntegration({
						orgId: "org_parity",
						integration: "supabase",
						isConnected: false,
					}),
				],
				[
					LoadAwsStatus,
					Message.SucceededLoadIntegration({
						orgId: "org_parity",
						integration: "aws",
						isConnected: false,
					}),
				],
			),
			Command.expectExact(SaveInfraSurfaces({ orgId: "org_parity", surfaces: [] })),
			Command.resolve(SaveInfraSurfaces, Message.CompletedSaveInfraSurfaces()),
			...close(),
			...open(),
			Command.expectNone(),
			...close(),
		)
	})

	test("below md a page's `useInfraSurfaces` sends the probe and statuses once, not the dashboards", () => {
		const mobile = enter("org_parity")(init({ ...flags, isMobile: true })).model
		const asked = update(mobile, Message.RequestedInfraSurfaces())
		expectVitest((asked.commands ?? []).map((command) => command.name)).toEqual([
			"LoadInfraPresence",
			"LoadCloudflareStatus",
			"LoadPlanetscaleStatus",
			"LoadRailwayStatus",
			"LoadGcpStatus",
			"LoadSupabaseStatus",
			"LoadAwsStatus",
		])
		expectVitest(asked.model.hasRequestedSidebarData).toBe(false)
		expectVitest(update(asked.model, Message.RequestedInfraSurfaces()).commands ?? []).toEqual([])
	})

	test("entering an org below md defers the sidebar's reads; on desktop they go with the tenant", () => {
		const mobile = enter("org_parity")(init({ ...flags, isMobile: true }))
		const desktop = enter("org_parity")(init(flags))
		expectVitest((mobile.commands ?? []).map((command) => command.name)).toEqual(["LoadTenant"])
		expectVitest(mobile.model.hasRequestedSidebarData).toBe(false)
		expectVitest((desktop.commands ?? []).map((command) => command.name)).toContain("LoadInfraPresence")
		expectVitest(desktop.model.hasRequestedSidebarData).toBe(true)
	})
})

describe("menus", () => {
	test("the user menu opens over its trigger and Escape hands focus back to it", () => {
		scene(
			{ update, view },
			given(signedIn()),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
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
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
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
	test("each opening re-reads the namespaces; picking one pins it for this org and reports it", () => {
		scene(
			{ update, view },
			given(signedIn()),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
			click(role("button", { name: /Self Hosted/ })),
			Command.expectExact(LoadNamespaces({ orgId: "org_parity" })),
			Mount.resolve(PositionMenu, position(Menu.Org())),
			expect(text(/Loading namespaces/)).toExist(),
			Command.resolve(
				LoadNamespaces,
				Message.SucceededLoadNamespaces({ orgId: "org_parity", namespaces: ["checkout", "shop"] }),
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
			Command.expectExact(LoadNamespaces({ orgId: "org_parity" })),
			Mount.resolve(PositionMenu, position(Menu.Org())),
			// The listed names stay up while the fresh window is read.
			expect(role("menuitem", { name: "shop" })).toExist(),
			Command.resolve(
				LoadNamespaces,
				Message.SucceededLoadNamespaces({ orgId: "org_parity", namespaces: ["checkout", "shop"] }),
			),
			click(role("menuitem", { name: "All namespaces" })),
			Command.resolve(SaveNamespace, Message.CompletedSaveNamespace()),
			Mount.expectEnded(PositionMenu),
			expect(role("button", { name: "Self Hosted" })).toExist(),
		)
	})
})

describe("namespace search", () => {
	const many = ["api", "billing", "checkout", "edge", "mail", "search", "shop", "web"]
	const openWith = (namespaces: ReadonlyArray<string>) => [
		given(signedIn({ namespaces: NamespacesData.Success({ data: namespaces }) })),
		Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
		click(role("button", { name: /Self Hosted/ })),
		Command.resolve(LoadNamespaces, Message.SucceededLoadNamespaces({ orgId: "org_parity", namespaces })),
		Mount.resolve(PositionMenu, position(Menu.Org())),
	]

	test("from eight namespaces a search row filters the list; no match says so", () => {
		const search = role("textbox")
		scene(
			{ update, view },
			...openWith(many),
			Mount.resolve(MountNamespaceSearch, Message.CompletedMountNamespaceSearch()),
			expect(search).toHaveAttr("placeholder", "Search namespaces…"),
			typeInto(search, "sh"),
			expect(role("menuitem", { name: "shop" })).toExist(),
			expect(role("menuitem", { name: "api" })).toBeAbsent(),
			expect(role("menuitem", { name: "All namespaces" })).toBeAbsent(),
			typeInto(search, "zzz"),
			expect(text("No namespaces match")).toExist(),
		)
	})

	test("below eight namespaces there is no search row", () => {
		scene(
			{ update, view },
			...openWith(many.slice(0, 7)),
			expect(role("textbox")).toBeAbsent(),
			expect(role("menuitem", { name: "All namespaces" })).toExist(),
		)
	})
})

describe("in-place org change", () => {
	test("entering another org on mobile drops the previous org's pinned dashboards", () => {
		const onA = {
			...signedIn({ maybeOrgId: Option.some("org_a"), isMobile: true }),
			dashboards: DashboardsData.Success({ data: [] }),
		}
		expectVitest(enter("org_b")(onA).model.dashboards._tag).toBe("Idle")
	})

	test("entering another org drops the previous org's namespaces and integrations and its late answers", () => {
		const onA = {
			...signedIn({ maybeOrgId: Option.some("org_a") }),
			namespaces: NamespacesData.Success({ data: ["a-only"] }),
			integrations: {
				cloudflare: true,
				railway: true,
				planetscale: false,
				gcp: false,
				supabase: false,
				aws: false,
			},
		}
		const onB = enter("org_b")(onA).model
		expectVitest(onB.namespaces._tag).toBe("Idle")
		expectVitest(onB.integrations).toEqual({
			cloudflare: null,
			railway: null,
			planetscale: null,
			gcp: null,
			supabase: null,
			aws: null,
		})
		const lateNamespaces = update(
			onB,
			Message.SucceededLoadNamespaces({ orgId: "org_a", namespaces: ["a-only"] }),
		)
		expectVitest(lateNamespaces.model.namespaces._tag).toBe("Idle")
		const lateStatus = update(
			onB,
			Message.SucceededLoadIntegration({
				orgId: "org_a",
				integration: "cloudflare",
				isConnected: true,
			}),
		)
		expectVitest(lateStatus.model.integrations.cloudflare).toBe(null)
		const ownStatus = update(
			onB,
			Message.SucceededLoadIntegration({ orgId: "org_b", integration: "railway", isConnected: true }),
		)
		expectVitest(ownStatus.model.integrations.railway).toBe(true)
	})
})

describe("app update banner", () => {
	test("a newer deployed build shows the reload banner; Reload reloads the tab", () => {
		scene(
			{ update, view },
			given(signedIn()),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
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

	test("a version check that finds the running build keeps the model, so nothing re-renders", () => {
		const model = signedIn()
		const checked = update(model, Message.CheckedDeployedCommit({ maybeCommit: Option.none() }))
		expectVitest(checked.model).toBe(model)
		const outdated = update(
			model,
			Message.CheckedDeployedCommit({ maybeCommit: Option.some("f00dfeed") }),
		)
		expectVitest(outdated.model.isAppOutdated).toBe(true)
	})
})

describe("infrastructure section", () => {
	test("on an infra page only the sources the org reports or connected are listed", () => {
		scene(
			{ update, view: shellAt("/infra") },
			given(
				signedIn({
					infraPresence: { _tag: "Success", data: ["hosts"] },
					integrations: {
						cloudflare: true,
						railway: false,
						planetscale: false,
						gcp: false,
						supabase: false,
						aws: false,
					},
				}),
			),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
			expect(role("link", { name: "Hosts" })).toExist(),
			expect(role("link", { name: "Cloudflare" })).toExist(),
			expect(role("link", { name: "Kubernetes" })).toBeAbsent(),
			expect(role("link", { name: "Railway" })).toBeAbsent(),
		)
	})

	const answered = (model: Model, cloudflare: boolean) =>
		[
			Message.SucceededLoadInfraPresence({ orgId: "org_parity", surfaces: ["hosts"] }),
			...(["railway", "planetscale", "gcp", "supabase", "aws"] as const).map((integration) =>
				Message.SucceededLoadIntegration({ orgId: "org_parity", integration, isConnected: false }),
			),
			Message.SucceededLoadIntegration({
				orgId: "org_parity",
				integration: "cloudflare",
				isConnected: cloudflare,
			}),
		].reduce<{ model: Model; commands: ReadonlyArray<{ readonly name: string }> }>(
			(acc, message) => {
				const next = update(acc.model, message)
				return { model: next.model, commands: [...acc.commands, ...(next.commands ?? [])] }
			},
			{ model, commands: [] },
		)

	test("a first visit lists no optional source until the probe and every status answered", () => {
		const probeOnly = update(
			signedIn(),
			Message.SucceededLoadInfraPresence({ orgId: "org_parity", surfaces: ["hosts"] }),
		).model
		scene(
			{ update, view: shellAt("/infra") },
			given(probeOnly),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
			expect(role("link", { name: "Hosts" })).toBeAbsent(),
			expect(role("link", { name: "Kubernetes" })).toBeAbsent(),
		)
		scene(
			{ update, view: shellAt("/infra") },
			given(answered(signedIn(), true).model),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
			expect(role("link", { name: "Hosts" })).toExist(),
			expect(role("link", { name: "Cloudflare" })).toExist(),
			expect(role("link", { name: "Kubernetes" })).toBeAbsent(),
		)
	})

	test("the surfaces remembered from the last visit lay the section out before anything answers", () => {
		scene(
			{ update, view: shellAt("/infra") },
			given(signedIn({ rememberedSurfaces: { org_parity: ["cloudflare", "hosts"] } })),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
			expect(role("link", { name: "Hosts" })).toExist(),
			expect(role("link", { name: "Cloudflare" })).toExist(),
			expect(role("link", { name: "Kubernetes" })).toBeAbsent(),
		)
	})

	test("the last integration status to answer tells the pages, once, even when the probe failed", () => {
		const settledBy = (model: Model, message: Message) => update(model, message).outMessage?._tag
		const probeFailed = update(signedIn(), Message.FailedLoadInfraPresence({ orgId: "org_parity" })).model
		expectVitest(
			settledBy(signedIn(), Message.SucceededLoadInfraPresence({ orgId: "org_parity", surfaces: [] })),
		).toBe(undefined)
		const answeredOnce = {
			...probeFailed,
			integrations: {
				cloudflare: true,
				railway: false,
				planetscale: false,
				gcp: false,
				supabase: false,
				aws: false,
			},
		}
		const oneLeft = { ...answeredOnce, integrations: { ...answeredOnce.integrations, aws: null } }
		expectVitest(
			settledBy(
				oneLeft,
				Message.SucceededLoadIntegration({
					orgId: "org_parity",
					integration: "aws",
					isConnected: false,
				}),
			),
		).toBe("SettledInfraSurfaces")
		expectVitest(
			settledBy(
				answeredOnce,
				Message.SucceededLoadIntegration({
					orgId: "org_parity",
					integration: "aws",
					isConnected: true,
				}),
			),
		).toBe(undefined)
		expectVitest(
			settledBy(
				oneLeft,
				Message.SucceededLoadIntegration({ orgId: "org_b", integration: "aws", isConnected: true }),
			),
		).toBe(undefined)
	})

	test("a late answer for an org the shell has left remembers nothing", () => {
		const onB = answered(signedIn({ maybeOrgId: Option.some("org_parity") }), true).model
		const late = update(
			onB,
			Message.SucceededLoadIntegration({ orgId: "org_a", integration: "aws", isConnected: true }),
		)
		expectVitest(late.model.rememberedSurfaces).toEqual({ org_parity: ["cloudflare", "hosts"] })
		expectVitest(late.commands ?? []).toEqual([])
	})

	test("a settled answer is remembered only when it differs from the remembered set", () => {
		const first = answered(signedIn(), true)
		expectVitest(first.model.rememberedSurfaces).toEqual({ org_parity: ["cloudflare", "hosts"] })
		expectVitest(first.commands.map(({ name }) => name)).toEqual(["SaveInfraSurfaces"])
		const same = answered(signedIn({ rememberedSurfaces: { org_parity: ["cloudflare", "hosts"] } }), true)
		expectVitest(same.commands).toEqual([])
		const dropped = answered(
			signedIn({ rememberedSurfaces: { org_parity: ["cloudflare", "hosts"] } }),
			false,
		)
		expectVitest(dropped.model.rememberedSurfaces).toEqual({ org_parity: ["hosts"] })
	})
})
