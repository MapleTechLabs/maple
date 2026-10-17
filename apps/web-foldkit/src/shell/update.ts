import { Option, Record } from "effect"
import { AsyncData, type Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { Resources } from "../platform/resources"
import {
	FocusElement,
	FocusSiblingMenuItem,
	LogOut,
	SaveNamespace,
	SaveSidebarState,
	SaveTheme,
} from "./command"
import {
	LoadCloudflareStatus,
	LoadDashboards,
	LoadGcpStatus,
	LoadInfraPresence,
	LoadNamespaces,
	LoadPlanetscaleStatus,
	LoadRailwayStatus,
	LoadTenant,
} from "./data"
import { isSameMenu, popupIdOf, triggerIdOf } from "./menus"
import { BUILT_COMMIT, CheckDeployedCommit, ReloadPage } from "./version"
import { Menu, Message, OutMessage } from "./message"
import { DashboardsData, InfraPresenceData, type Model, NamespacesData, TenantData } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const closeMenu = (model: Model): Model => modifyFields(model, { openMenu: () => Option.none() })

const openMenuOf = (model: Model): Option.Option<Menu> => Option.map(model.openMenu, ({ menu }) => menu)

// ENTRY POINTS

/**
 * A shell route rendered for a signed-in org: the boot requests legacy's sidebar and root fire,
 * once per org. A later org change (Clerk) reloads the page in legacy, so a new org reboots here.
 */
export const enter =
	(orgId: string) =>
	(model: Model): UpdateReturn => {
		if (Option.contains(model.maybeOrgId, orgId)) return { model }
		return {
			model: modifyFields(model, {
				maybeOrgId: () => Option.some(orgId),
				tenant: () => TenantData.Loading(),
				infraPresence: () => InfraPresenceData.Loading(),
				dashboards: () => DashboardsData.Loading(),
			}),
			commands: [
				LoadTenant(),
				LoadInfraPresence(),
				LoadCloudflareStatus(),
				LoadPlanetscaleStatus(),
				LoadRailwayStatus(),
				LoadGcpStatus(),
				LoadDashboards({ orgId }),
			],
		}
	}

/** Navigation remounts the page in legacy, which closes every menu and the mobile sheet. */
export const routeChanged = (model: Model): UpdateReturn => ({
	model: modifyFields(closeMenu(model), { isMobileNavOpen: () => false }),
})

const toggleSidebar = (model: Model): UpdateReturn =>
	model.isMobile
		? { model: modifyFields(model, { isMobileNavOpen: (isOpen) => !isOpen }) }
		: {
				model: modifyFields(model, { isSidebarOpen: (isOpen) => !isOpen }),
				commands: [SaveSidebarState({ isOpen: !model.isSidebarOpen })],
			}

const clickedMenuTrigger = (model: Model, menu: Menu): UpdateReturn => {
	if (Option.exists(openMenuOf(model), (open) => isSameMenu(open, menu))) return { model: closeMenu(model) }
	const opened = modifyFields(model, {
		openMenu: () => Option.some({ menu, maybePosition: Option.none() }),
	})
	const needsNamespaces = menu._tag === "Org" && AsyncData.isIdle(model.namespaces)
	return needsNamespaces
		? {
				model: modifyFields(opened, { namespaces: () => NamespacesData.Loading() }),
				commands: [LoadNamespaces()],
			}
		: { model: opened }
}
// MENU KEYS

/** Escape closes and refocuses the trigger, arrows walk the items (Base UI `Menu`). */
const pressedMenuKey = (model: Model, key: string): UpdateReturn =>
	Option.match(openMenuOf(model), {
		onNone: () => ({ model }),
		onSome: (menu) => {
			if (key === "Escape")
				return { model: closeMenu(model), commands: [FocusElement({ id: triggerIdOf(menu) })] }
			if (key === "ArrowDown" || key === "ArrowUp")
				return {
					model,
					commands: [
						FocusSiblingMenuItem({
							popupId: popupIdOf(menu),
							step: key === "ArrowDown" ? 1 : -1,
						}),
					],
				}
			return { model }
		},
	})

/** Keys the popup handles, so the view can prevent their default scrolling. */
export const isMenuKey = (key: string): boolean => ["Escape", "ArrowDown", "ArrowUp"].includes(key)

const clickedNamespace = (model: Model, maybeNamespace: Option.Option<string>): UpdateReturn =>
	Option.match(model.maybeOrgId, {
		onNone: () => ({ model: closeMenu(model) }),
		onSome: (orgId) => ({
			model: modifyFields(closeMenu(model), {
				pinnedNamespaces: (pinned) =>
					Option.match(maybeNamespace, {
						onNone: () => Record.remove(pinned, orgId),
						onSome: (namespace) => Record.set(pinned, orgId, namespace),
					}),
			}),
			commands: [SaveNamespace({ orgId, maybeNamespace })],
			outMessage: OutMessage.ChangedGlobalNamespace({ maybeNamespace }),
		}),
	})
// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedSidebarTrigger: () => toggleSidebar(model),
		PressedSidebarShortcut: () => toggleSidebar(model),
		ChangedViewport: ({ isMobile }) => ({
			model: modifyFields(closeMenu(model), { isMobile: () => isMobile, isMobileNavOpen: () => false }),
		}),
		DismissedMobileNav: () => ({ model: modifyFields(model, { isMobileNavOpen: () => false }) }),
		ClickedMenuTrigger: ({ menu }) => clickedMenuTrigger(model, menu),
		DismissedMenu: () => ({ model: closeMenu(model) }),
		MeasuredMenuPopup: ({ menu, position }) => ({
			model: modifyFields(model, {
				openMenu: Option.map((open) =>
					isSameMenu(open.menu, menu)
						? { menu: open.menu, maybePosition: Option.some(position) }
						: open,
				),
			}),
		}),
		PressedMenuKey: ({ key }) => pressedMenuKey(model, key),
		HoveredMenuItem: ({ itemId }) => ({ model, commands: [FocusElement({ id: itemId })] }),
		ClickedMenuAction: () => ({ model: closeMenu(model) }),
		ClickedThemeSwitch: () => {
			const theme = model.theme === "dark" ? "light" : "dark"
			return { model: modifyFields(model, { theme: () => theme }), commands: [SaveTheme({ theme })] }
		},
		ClickedNamespace: ({ maybeNamespace }) => clickedNamespace(model, maybeNamespace),
		ClickedLogOut: () => ({ model: closeMenu(model), commands: [LogOut()] }),
		CompletedFocusElement: () => ({ model }),
		CompletedSaveTheme: () => ({ model }),
		CompletedSaveNamespace: () => ({ model }),
		CompletedSaveSidebarState: () => ({ model }),
		CompletedLogOut: () => ({ model }),
		ElapsedVersionPollInterval: () => ({ model, commands: [CheckDeployedCommit()] }),
		BecameTabVisible: () => ({ model, commands: [CheckDeployedCommit()] }),
		CheckedDeployedCommit: ({ maybeCommit }) => ({
			model: modifyFields(model, {
				isAppOutdated: (isOutdated) =>
					isOutdated || Option.exists(maybeCommit, (commit) => commit !== BUILT_COMMIT),
			}),
		}),
		ClickedReload: () => ({ model, commands: [ReloadPage()] }),
		CompletedReloadPage: () => ({ model }),
		SucceededLoadTenant: ({ orgId }) => ({
			model: modifyFields(model, { tenant: () => TenantData.Success({ data: orgId }) }),
		}),
		FailedLoadTenant: () => ({
			model: modifyFields(model, { tenant: () => TenantData.Failure({ error: "Failed" }) }),
		}),
		SucceededLoadInfraPresence: ({ surfaces }) => ({
			model: modifyFields(model, {
				infraPresence: () => InfraPresenceData.Success({ data: surfaces }),
			}),
		}),
		FailedLoadInfraPresence: () => ({
			model: modifyFields(model, {
				infraPresence: () => InfraPresenceData.Failure({ error: "Failed" }),
			}),
		}),
		SucceededLoadIntegration: ({ integration, isConnected }) => ({
			model: modifyFields(model, {
				integrations: (current) => ({ ...current, [integration]: isConnected }),
			}),
		}),
		FailedLoadIntegration: ({ integration }) => ({
			model: modifyFields(model, { integrations: (current) => ({ ...current, [integration]: false }) }),
		}),
		// A result for an org the shell has left is dropped.
		SucceededLoadDashboards: ({ orgId, dashboards }) =>
			Option.contains(model.maybeOrgId, orgId)
				? {
						model: modifyFields(model, {
							dashboards: () => DashboardsData.Success({ data: dashboards }),
						}),
					}
				: { model },
		FailedLoadDashboards: ({ orgId }) =>
			Option.contains(model.maybeOrgId, orgId)
				? {
						model: modifyFields(model, {
							dashboards: () => DashboardsData.Failure({ error: "Failed" }),
						}),
					}
				: { model },
		SucceededLoadNamespaces: ({ namespaces }) => ({
			model: modifyFields(model, { namespaces: () => NamespacesData.Success({ data: namespaces }) }),
		}),
		FailedLoadNamespaces: () => ({
			model: modifyFields(model, { namespaces: () => NamespacesData.Failure({ error: "Failed" }) }),
		}),
	})
