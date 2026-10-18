import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Option, Record } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import * as Tooltip from "../ui/tooltip"
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
	LoadGcpStatus,
	LoadInfraPresence,
	LoadNamespaces,
	LoadPlanetscaleStatus,
	LoadRailwayStatus,
	LoadTenant,
} from "./data"
import { DismissQuotaBanner, OpenCustomerPortal } from "./billing-banners"
import * as ClerkOrgSwitcher from "./clerk-org-switcher"
import * as Checklist from "./onboarding-checklist"
import * as SupportChannel from "./support-channel"
import { isSameMenu, popupIdOf, triggerIdOf } from "./menus"
import { BUILT_COMMIT, CheckDeployedCommit, ReloadPage } from "./version"
import { Menu, Message, OutMessage } from "./message"
import {
	DashboardsData,
	InfraPresenceData,
	initRailTooltip,
	type Model,
	NamespacesData,
	TenantData,
} from "./model"

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
				// Clerk: the reward pill (`OnboardingChecklistButton`) and who is looking at it.
				...(isClerkAuthEnabled ? [toChecklist(Checklist.LoadChecklist()), toChecklist(Checklist.LoadViewer())] : []),
			],
		}
	}

const toChecklist = Command.mapMessage((message: Checklist.Message) => Message.GotChecklistMessage({ message }))

const supportChannelStep = (model: Model, step: ReturnType<typeof SupportChannel.update>): UpdateReturn => ({
	model: modifyFields(model, { supportChannel: () => step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotSupportChannelMessage({ message })),
})

/** The reward pill's countdown runs while the checklist is in progress. */
export const isChecklistCounting = (model: Model): boolean => Checklist.isCounting(model.checklist)

export const checklistTicked = (nowMs: number): Message =>
	Message.GotChecklistMessage({ message: Checklist.Message.TickedClock({ nowMs }) })

/**
 * A signed-in route outside the shell (`/cli-login`, `/quick-start`): legacy's root still mounts
 * `GlobalChatSheet`, whose org lookup is the only request of the shell's that it sends.
 */
export const enterBare = (model: Model): UpdateReturn =>
	AsyncData.isIdle(model.tenant)
		? { model: modifyFields(model, { tenant: () => TenantData.Loading() }), commands: [LoadTenant()] }
		: { model }

/** Navigation remounts the page in legacy, which closes every menu and the mobile sheet. */
export const routeChanged = (model: Model): UpdateReturn => ({
	model: modifyFields(closeMenu(model), { isMobileNavOpen: () => false }),
	// Every checklist step is done on another page: a navigation re-reads it (`onResolved`).
	commands: isClerkAuthEnabled && model.checklist.checklist !== null ? [toChecklist(Checklist.LoadChecklist())] : [],
})

const toggleSidebar = (model: Model): UpdateReturn =>
	model.isMobile
		? { model: modifyFields(model, { isMobileNavOpen: (isOpen) => !isOpen }) }
		: {
				// A tooltip left open on the rail would reappear on the next collapse.
				model: modifyFields(model, {
					isSidebarOpen: (isOpen) => !isOpen,
					railTooltip: () => initRailTooltip(),
				}),
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
/** The Clerk switcher: a pick goes to the root, a namespace pins, its submenu reads the list. */
const clerkOrgMenu = (model: Model, message: ClerkOrgSwitcher.Message): UpdateReturn => {
	const next = ClerkOrgSwitcher.update(model.clerkOrgMenu, message)
	const stepped: UpdateReturn = {
		model: modifyFields(model, { clerkOrgMenu: () => next.model }),
		commands: Command.mapMessages(next.commands ?? [], (child) => Message.GotClerkOrgMenuMessage({ message: child })),
	}
	const out = next.outMessage
	if (out === undefined) return stepped
	return ClerkOrgSwitcher.OutMessage.match<UpdateReturn>(out, {
		SelectedOrganization: ({ orgId }) =>
			Option.contains(model.maybeOrgId, orgId)
				? stepped
				: { ...stepped, outMessage: OutMessage.RequestedOrganizationSwitch({ orgId }) },
		SelectedNamespace: ({ maybeNamespace }) => {
			const pinned = clickedNamespace(stepped.model, maybeNamespace)
			return { ...pinned, commands: [...(stepped.commands ?? []), ...(pinned.commands ?? [])] }
		},
		OpenedNamespaces: () =>
			AsyncData.isIdle(model.namespaces)
				? {
						model: modifyFields(stepped.model, { namespaces: () => NamespacesData.Loading() }),
						commands: [...(stepped.commands ?? []), LoadNamespaces()],
					}
				: stepped,
	})
}

// UPDATE

export const update =(model: Model, message: Message): UpdateReturn =>
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
		// Clerk signs out through the root (`useClerk().signOut()`); self-hosted clears its token.
		ClickedLogOut: () =>
			isClerkAuthEnabled
				? { model: closeMenu(model), outMessage: OutMessage.RequestedSignOut() }
				: { model: closeMenu(model), commands: [LogOut()] },
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
		ChangedDashboardFavorites: ({ favorites }) => ({
			model: modifyFields(model, { dashboardFavorites: () => favorites }),
		}),
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
		GotRailTooltipMessage: ({ message: child }) => {
			const next = Tooltip.update(model.railTooltip, child)
			return {
				model: { ...model, railTooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotRailTooltipMessage({ message }),
				),
			}
		},
		GotClerkOrgMenuMessage: ({ message: child }) => clerkOrgMenu(model, child),
		GotSupportChannelMessage: ({ message: child }) =>
			supportChannelStep(model, SupportChannel.update(model.supportChannel, child)),
		ClickedSupportChannel: () => supportChannelStep(closeMenu(model), SupportChannel.open(model.supportChannel)),
		GotChecklistMessage: ({ message: child }) => {
			const next = Checklist.update(model.checklist, child)
			return {
				model: modifyFields(model, { checklist: () => next.model }),
				commands: (next.commands ?? []).map(toChecklist),
			}
		},
		ClickedUpdatePaymentMethod: () => ({ model, commands: [OpenCustomerPortal()] }),
		// The portal mutation's reactivity keys re-read the customer.
		CompletedOpenCustomerPortal: () => ({ model, outMessage: OutMessage.RequestedCustomerRefresh() }),
		FailedOpenCustomerPortal: ({ message: title }) => ({
			model,
			outMessage: OutMessage.RequestedErrorToast({ title }),
		}),
		ClickedDismissQuotaBanner: () => ({
			model: modifyFields(model, { isQuotaApproachingDismissed: () => true }),
			commands: [DismissQuotaBanner()],
		}),
		CompletedDismissQuotaBanner: () => ({ model }),
		FailedLoadNamespaces: () => ({
			model: modifyFields(model, { namespaces: () => NamespacesData.Failure({ error: "Failed" }) }),
		}),
	})
