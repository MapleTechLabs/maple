import { isClerkAuthEnabled } from "../lib/services/common/auth-mode"
import { Array, Equal, Option, Record, Struct } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import * as Dialog from "../ui/dialog"
import * as Tooltip from "../ui/tooltip"
import type { Resources } from "../platform/resources"
import { integrationsAnswered, PENDING_INTEGRATIONS, settledSurfaces } from "../data/infra-surfaces"
import {
	FocusElement,
	FocusSiblingMenuItem,
	FocusShortcutSearch,
	LogOut,
	SaveInfraSurfaces,
	SaveNamespace,
	SaveSidebarState,
	SaveTheme,
} from "./command"
import {
	LoadCloudflareStatus,
	LoadAwsStatus,
	LoadGcpStatus,
	LoadInfraPresence,
	LoadNamespaces,
	LoadPlanetscaleStatus,
	LoadRailwayStatus,
	LoadSupabaseStatus,
} from "./data"
import { DismissQuotaBanner, OpenCustomerPortal } from "./billing-banners"
import * as ClerkOrgSwitcher from "./clerk-org-switcher"
import * as Checklist from "./onboarding-checklist"
import * as ConnectPanel from "./connect-panel"
import * as SupportChannel from "./support-channel"
import { isSameMenu, popupIdOf, triggerIdOf } from "./menus"
import { BUILT_COMMIT, CheckDeployedCommit, ReloadPage } from "./version"
import { openPalette, openShortcuts, paletteStep, shortcutsDialogStep, toggleTheme } from "./update-palette"
import { Menu, Message, OutMessage } from "./message"
import {
	DashboardsData,
	InfraPresenceData,
	initFilterSheet,
	initRailTooltip,
	initRightSheet,
	type Model,
	NamespacesData,
	shellProbe,
} from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const closeMenu = (model: Model): Model => modifyFields(model, { openMenu: () => Option.none() })

const openMenuOf = (model: Model): Option.Option<Menu> => Option.map(model.openMenu, ({ menu }) => menu)

// ENTRY POINTS

/**
 * A shell route rendered for a signed-in org: the sidebar's and root's boot requests fire once
 * per org. A later org change (Clerk) reloads the page, so a new org reboots here.
 */
export const enter =
	(orgId: string) =>
	(model: Model): UpdateReturn => {
		if (Option.contains(model.maybeOrgId, orgId)) return { model }
		const entered = modifyFields(model, {
			maybeOrgId: () => Option.some(orgId),
			hasRequestedSidebarData: () => false,
			// Nothing read for the previous org (an in-place org change) carries over.
			infraPresence: () => InfraPresenceData.Idle(),
			integrations: () => PENDING_INTEGRATIONS,
			dashboards: () => DashboardsData.Idle(),
			namespaces: () => NamespacesData.Idle(),
		})
		const sidebar = model.isMobile ? { model: entered } : requestSidebarData(entered)
		return {
			model: sidebar.model,
			commands: [
				...(sidebar.commands ?? []),
				// Clerk: the reward pill (`OnboardingChecklistButton`) and who is looking at it.
				...(isClerkAuthEnabled
					? [toChecklist(Checklist.LoadChecklist()), toChecklist(Checklist.LoadViewer())]
					: []),
			],
		}
	}

/**
 * What `AppSidebar` reads once it mounts: always on desktop, but below `md` only when its sheet
 * first opens (a closed sheet renders nothing). The live dashboards read follows the flag.
 */
const requestSidebarData = (model: Model): UpdateReturn => {
	if (model.hasRequestedSidebarData || Option.isNone(model.maybeOrgId)) return { model }
	const surfaces = requestInfraSurfaces(model)
	return {
		model: modifyFields(surfaces.model, {
			hasRequestedSidebarData: () => true,
			dashboards: () => DashboardsData.Loading(),
		}),
		commands: surfaces.commands ?? [],
	}
}

/** `useInfraSurfaces`: the last hour's presence probe and the four integration statuses, once. */
const requestInfraSurfaces = (model: Model): UpdateReturn =>
	Option.match(model.maybeOrgId, {
		onNone: () => ({ model }),
		onSome: (orgId) =>
			!AsyncData.isIdle(model.infraPresence)
				? { model }
				: {
						model: modifyFields(model, { infraPresence: () => InfraPresenceData.Loading() }),
						commands: [
							LoadInfraPresence({ orgId }),
							LoadCloudflareStatus({ orgId }),
							LoadPlanetscaleStatus({ orgId }),
							LoadRailwayStatus({ orgId }),
							LoadGcpStatus({ orgId }),
							LoadSupabaseStatus({ orgId }),
							LoadAwsStatus({ orgId }),
						],
					},
	})

/**
 * `NamespaceScopeList` mounts with each menu open and probes a fresh 24 h window (cached while the
 * snapped window holds). Listed names stay up while it reads; only a first read shows the spinner.
 */
const readNamespaces = (model: Model): UpdateReturn =>
	Option.match(model.maybeOrgId, {
		onNone: () => ({ model }),
		onSome: (orgId) => ({
			model: AsyncData.isSuccess(model.namespaces)
				? model
				: modifyFields(model, { namespaces: () => NamespacesData.Loading() }),
			commands: [LoadNamespaces({ orgId })],
		}),
	})

/** An org-stamped answer applies only while the shell is still on that org. */
const forOrg = (model: Model, orgId: string, apply: (model: Model) => Model): UpdateReturn => ({
	model: Option.contains(model.maybeOrgId, orgId) ? apply(model) : model,
})

/** Once the org's live surfaces are complete, remember them if they changed. */
const rememberSettled = (orgId: string, step: UpdateReturn): UpdateReturn => {
	const model = step.model
	const settled = settledSurfaces(shellProbe(model), model.integrations)
	const remembered = model.rememberedSurfaces[orgId]
	if (
		settled === null ||
		(remembered !== undefined && Array.makeEquivalence(Equal.equals)(remembered, settled))
	)
		return step
	return {
		model: modifyFields(model, { rememberedSurfaces: (all) => Record.set(all, orgId, settled) }),
		commands: [SaveInfraSurfaces({ orgId, surfaces: settled })],
	}
}

/** A probe or status answer for the org; the last status to answer tells the pages. */
const surfacesAnswered = (model: Model, orgId: string, apply: (model: Model) => Model): UpdateReturn => {
	// A late answer for an org the shell has left must not file this org's set under it.
	if (!Option.contains(model.maybeOrgId, orgId)) return { model }
	const step = rememberSettled(orgId, { model: apply(model) })
	return !integrationsAnswered(model.integrations) && integrationsAnswered(step.model.integrations)
		? { ...step, outMessage: OutMessage.SettledInfraSurfaces() }
		: step
}

const toChecklist = Command.mapMessage((message: Checklist.Message) =>
	Message.GotChecklistMessage({ message }),
)

const supportChannelStep = (model: Model, step: ReturnType<typeof SupportChannel.update>): UpdateReturn => ({
	model: modifyFields(model, { supportChannel: () => step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotSupportChannelMessage({ message }),
	),
})

/** The reward pill's countdown runs while the checklist is in progress. */
export const isChecklistCounting = (model: Model): boolean => Checklist.isCounting(model.checklist)

export const checklistTicked = (nowMs: number): Message =>
	Message.GotChecklistMessage({ message: Checklist.Message.TickedClock({ nowMs }) })

/** The Connect panel's connection signal is polled while it is open. */
export const isConnectPolling = (model: Model): boolean => ConnectPanel.isPolling(model.connect)

export const connectPollTicked = (): Message =>
	Message.GotConnectMessage({ message: ConnectPanel.Message.TickedPoll() })

/**
 * Navigation closes every menu and the mobile sheet. The page
 * rails' sheets live in the page's `PageLayout.Root`: they survive a search change, not a new page.
 */
export const routeChanged =
	(isSamePage: boolean, hasTopBar = true) =>
	(model: Model): UpdateReturn => ({
		model: modifyFields(closeMenu(model), {
			isMobileNavOpen: () => false,
			filterSheet: (sheet) => (isSamePage ? sheet : initFilterSheet()),
			rightSheet: (sheet) => (isSamePage ? sheet : initRightSheet()),
		}),
		commands: checklistRefreshOnNavigation(model, hasTopBar, isClerkAuthEnabled),
	})

/**
 * Every checklist step is done on another page: a navigation re-reads it (`onResolved`), but only
 * where the top bar's pill is mounted.
 */
export const checklistRefreshOnNavigation = (model: Model, hasTopBar: boolean, isClerk: boolean) =>
	isClerk && hasTopBar && model.checklist.checklist !== null ? [toChecklist(Checklist.LoadChecklist())] : []

const toggleSidebar = (model: Model, isInstant: boolean): UpdateReturn =>
	model.isMobile
		? model.isMobileNavOpen
			? { model: modifyFields(model, { isMobileNavOpen: () => false }) }
			: requestSidebarData(modifyFields(model, { isMobileNavOpen: () => true }))
		: {
				// A tooltip left open on the rail would reappear on the next collapse.
				model: modifyFields(model, {
					isSidebarOpen: (isOpen) => !isOpen,
					isSidebarToggleInstant: () => isInstant,
					railTooltip: () => initRailTooltip(),
				}),
				commands: [SaveSidebarState({ isOpen: !model.isSidebarOpen })],
			}

type DialogStep = ReturnType<typeof Dialog.update>

const filterSheetStep = (model: Model, step: DialogStep): UpdateReturn => ({
	model: modifyFields(model, { filterSheet: () => step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotFilterSheetMessage({ message }),
	),
})

const rightSheetStep = (model: Model, step: DialogStep): UpdateReturn => ({
	model: modifyFields(model, { rightSheet: () => step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotRightSheetMessage({ message }),
	),
})

const clickedMenuTrigger = (model: Model, menu: Menu): UpdateReturn => {
	if (Option.exists(openMenuOf(model), (open) => isSameMenu(open, menu))) return { model: closeMenu(model) }
	const opened = modifyFields(model, {
		openMenu: () => Option.some({ menu, maybePosition: Option.none() }),
		namespaceQuery: () => "",
	})
	return menu._tag === "Org" ? readNamespaces(opened) : { model: opened }
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
		commands: Command.mapMessages(next.commands ?? [], (child) =>
			Message.GotClerkOrgMenuMessage({ message: child }),
		),
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
		OpenedNamespaces: () => {
			const read = readNamespaces(stepped.model)
			return { model: read.model, commands: [...(stepped.commands ?? []), ...(read.commands ?? [])] }
		},
	})
}

// UPDATE

const foldMessage = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedSidebarTrigger: () => toggleSidebar(model, false),
		PressedSidebarShortcut: () => toggleSidebar(model, true),
		RequestedInfraSurfaces: () => requestInfraSurfaces(model),
		ChangedViewport: ({ isMobile }) => {
			const changed = modifyFields(closeMenu(model), {
				isMobile: () => isMobile,
				isMobileNavOpen: () => false,
			})
			return isMobile ? { model: changed } : requestSidebarData(changed)
		},
		DismissedMobileNav: () => ({ model: modifyFields(model, { isMobileNavOpen: () => false }) }),
		// Crossing `lg` swaps a sheet for the inline rail; it comes back closed.
		ChangedFilterViewport: ({ isCollapsed }) => ({
			model: modifyFields(model, {
				isFilterCollapsed: () => isCollapsed,
				filterSheet: () => initFilterSheet(),
				rightSheet: () => initRightSheet(),
			}),
		}),
		ChangedSmallViewport: ({ isBelowSm }) => ({
			model: modifyFields(model, { isBelowSm: () => isBelowSm }),
		}),
		ClickedOpenFilters: () => filterSheetStep(model, Dialog.open(model.filterSheet)),
		ClickedOpenContext: () => rightSheetStep(model, Dialog.open(model.rightSheet)),
		GotFilterSheetMessage: ({ message: child }) =>
			filterSheetStep(model, Dialog.update(model.filterSheet, child)),
		GotRightSheetMessage: ({ message: child }) =>
			rightSheetStep(model, Dialog.update(model.rightSheet, child)),
		ClickedMenuTrigger: ({ menu }) => clickedMenuTrigger(model, menu),
		DismissedMenu: () => ({ model: closeMenu(model) }),
		MeasuredSidebarOverflow: () => ({ model }),
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
		ChangedNamespaceQuery: ({ value }) => ({
			model: modifyFields(model, { namespaceQuery: () => value }),
		}),
		CompletedMountNamespaceSearch: () => ({ model }),
		// Clerk signs out through the root (`useClerk().signOut()`); self-hosted clears its token.
		ClickedLogOut: () =>
			isClerkAuthEnabled
				? { model: closeMenu(model), outMessage: OutMessage.RequestedSignOut() }
				: { model: closeMenu(model), commands: [LogOut()] },
		CompletedFocusElement: () => ({ model }),
		CompletedSaveTheme: () => ({ model }),
		CompletedSaveNamespace: () => ({ model }),
		CompletedSaveInfraSurfaces: () => ({ model }),
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
		// Org-stamped answers: one for an org the shell has left is dropped.
		SucceededLoadInfraPresence: ({ orgId, surfaces }) =>
			surfacesAnswered(model, orgId, (current) =>
				modifyFields(current, { infraPresence: () => InfraPresenceData.Success({ data: surfaces }) }),
			),
		FailedLoadInfraPresence: ({ orgId }) =>
			surfacesAnswered(model, orgId, (current) =>
				modifyFields(current, {
					infraPresence: () => InfraPresenceData.Failure({ error: "Failed" }),
				}),
			),
		SucceededLoadIntegration: ({ orgId, integration, isConnected }) =>
			surfacesAnswered(model, orgId, (current) =>
				modifyFields(current, {
					integrations: (known) => ({ ...known, [integration]: isConnected }),
				}),
			),
		FailedLoadIntegration: ({ orgId, integration }) =>
			surfacesAnswered(model, orgId, (current) =>
				modifyFields(current, { integrations: (known) => ({ ...known, [integration]: false }) }),
			),
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
		SucceededLoadNamespaces: ({ orgId, namespaces }) =>
			forOrg(model, orgId, (current) =>
				modifyFields(current, { namespaces: () => NamespacesData.Success({ data: namespaces }) }),
			),
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
		ClickedSupportChannel: () =>
			supportChannelStep(closeMenu(model), SupportChannel.open(model.supportChannel)),
		GotChecklistMessage: ({ message: child }) => {
			const next = Checklist.update(model.checklist, child)
			return {
				model: modifyFields(model, { checklist: () => next.model }),
				commands: (next.commands ?? []).map(toChecklist),
			}
		},
		GotConnectMessage: ({ message: child }) => {
			const orgId = Option.getOrNull(model.maybeOrgId)
			const pinnedNamespace = orgId === null ? null : (model.pinnedNamespaces[orgId] ?? null)
			const next = ConnectPanel.update(model.connect, child, { orgId, pinnedNamespace })
			return {
				model: modifyFields(model, { connect: () => next.model }),
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotConnectMessage({ message }),
				),
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
		FailedLoadNamespaces: ({ orgId }) =>
			forOrg(model, orgId, (current) =>
				modifyFields(current, { namespaces: () => NamespacesData.Failure({ error: "Failed" }) }),
			),
		ClickedSearch: () => openPalette(model),
		// Mod+K while the palette is open keeps it open: a no-op.
		PressedPaletteShortcut: () => openPalette(model),
		PressedShortcutsKey: () => openShortcuts(model),
		PressedThemeKey: () => toggleTheme(model),
		PressedFocusSearchKey: () => ({ model, commands: [FocusShortcutSearch()] }),
		CompletedFocusShortcutSearch: () => ({ model }),
		GotPaletteMessage: ({ message: child }) => paletteStep(model, child),
		GotShortcutsDialogMessage: ({ message: child }) => shortcutsDialogStep(model, child),
		MeasuredShortcutsPanel: () => ({ model }),
		ClickedKeyboardShortcuts: () => openShortcuts(closeMenu(model)),
	})

/**
 * `modifyFields` always builds a new object, so a message that changed no field (a version check
 * that found the same commit) would re-render the whole app. Hand back the old Model instead.
 */
export const update = (model: Model, message: Message): UpdateReturn => {
	const result = foldMessage(model, message)
	const next = result.model
	return next !== model && Struct.keys(model).every((key) => model[key] === next[key])
		? { ...result, model }
		: result
}
