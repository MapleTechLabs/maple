import { isClerkAuthEnabled } from "../lib/services/common/auth-mode"
import { Option } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { PENDING_INTEGRATIONS } from "../data/infra-surfaces"
import {
	FocusElement,
	FocusShortcutSearch,
	FocusSiblingMenuItem,
	LogOut,
	OpenGlobalChat,
	SaveSidebarState,
	SaveTheme,
} from "./command"
import { LoadTenant } from "./data"
import { DismissQuotaBanner, OpenCustomerPortal } from "./billing-banners"
import {
	ChecklistBinding,
	ClerkOrgMenuBinding,
	ConnectBinding,
	FilterSheetBinding,
	openPaletteStep,
	openShortcutsStep,
	RailTooltipBinding,
	RightSheetBinding,
	ShellComposition,
	SupportChannelBinding,
} from "./composition"
import { makeNoopStep, makeStep } from "./definition"
import * as Checklist from "./onboarding-checklist"
import * as ConnectPanel from "./connect-panel"
import { isSameMenu, popupIdOf, triggerIdOf } from "./menus"
import { OutMessage } from "./message"
import {
	DashboardsData,
	InfraPresenceData,
	initFilterSheet,
	initialModel,
	initRightSheet,
	type Model,
	NamespacesData,
	type ShellFlags,
	TenantData,
} from "./model"
import {
	clickedMenuTrigger,
	clickedNamespace,
	closeMenu,
	forOrg,
	openMenuOf,
	requestInfraSurfaces,
	requestSidebarData,
	connectContextOf,
	stable,
	type StepReturn,
	surfacesAnswered,
	toggleTheme,
	type UpdateReturn,
} from "./update-local"
import { BUILT_COMMIT, CheckDeployedCommit, ReloadPage } from "./version"

// ENTRY POINTS (operations the root calls)

/**
 * A shell route rendered for a signed-in org: the sidebar's and root's boot requests fire once
 * per org. A later org change (Clerk) reloads the page, so a new org reboots here.
 */
const entered = (model: Model, orgId: string): StepReturn => {
	const next = modifyFields(model, {
		maybeOrgId: () => Option.some(orgId),
		tenant: () => TenantData.Loading(),
		hasRequestedSidebarData: () => false,
		// Nothing read for the previous org (an in-place org change) carries over.
		infraPresence: () => InfraPresenceData.Idle(),
		integrations: () => PENDING_INTEGRATIONS,
		dashboards: () => DashboardsData.Idle(),
		namespaces: () => NamespacesData.Idle(),
	})
	const sidebar = model.isMobile ? { model: next } : requestSidebarData(next)
	return { model: sidebar.model, commands: [LoadTenant(), ...(sidebar.commands ?? [])] }
}

const enterStep = makeStep((model, orgId: string) =>
	Option.contains(model.maybeOrgId, orgId)
		? makeNoopStep()
		: Update.combineSteps([
				makeStep(() => entered(model, orgId)),
				// Clerk: the reward pill (`OnboardingChecklistButton`) and who is looking at it.
				isClerkAuthEnabled ? ChecklistBinding.requestLoad() : makeNoopStep(),
			]),
)

/** The reward pill's countdown runs while the checklist is in progress. */
export const isChecklistCounting = (model: Model): boolean => Checklist.isCounting(model.checklist)

/** The Connect panel's connection signal is polled while it is open. */
export const isConnectPolling = (model: Model): boolean => ConnectPanel.isPolling(model.connect)

/**
 * A signed-in route outside the shell (`/cli-login`, `/quick-start`): the root still mounts
 * the global chat sheet, whose org lookup is the only request of the shell's that it sends.
 */
const enterBare = (model: Model): StepReturn =>
	AsyncData.isIdle(model.tenant)
		? { model: modifyFields(model, { tenant: () => TenantData.Loading() }), commands: [LoadTenant()] }
		: { model }

/**
 * Every checklist step is done on another page: a navigation re-reads it (`onResolved`), but only
 * where the top bar's pill is mounted. `/chat` has no top bar, so it never re-reads there.
 */
export const refreshesChecklistOnNavigation = (model: Model, hasTopBar: boolean, isClerk: boolean): boolean =>
	isClerk && hasTopBar && model.checklist.checklist !== null

/**
 * Navigation closes every menu and the mobile sheet. The page
 * rails' sheets live in the page's `PageLayout.Root`: they survive a search change, not a new page.
 */
const routeChangedStep = makeStep((model, isSamePage: boolean, hasTopBar: boolean) =>
	Update.combineSteps([
		makeStep(() => ({
			model: modifyFields(closeMenu(model), {
				isMobileNavOpen: () => false,
				filterSheet: (sheet) => (isSamePage ? sheet : initFilterSheet()),
				rightSheet: (sheet) => (isSamePage ? sheet : initRightSheet()),
			}),
		})),
		refreshesChecklistOnNavigation(model, hasTopBar, isClerkAuthEnabled)
			? ChecklistBinding.requestRefresh()
			: makeNoopStep(),
	]),
)

const toggleSidebarStep = makeStep((model, isInstant: boolean) =>
	model.isMobile
		? makeStep(() =>
				model.isMobileNavOpen
					? { model: modifyFields(model, { isMobileNavOpen: () => false }) }
					: requestSidebarData(modifyFields(model, { isMobileNavOpen: () => true })),
			)
		: Update.combineSteps([
				makeStep(() => ({
					model: modifyFields(model, {
						isSidebarOpen: (isOpen) => !isOpen,
						isSidebarToggleInstant: () => isInstant,
					}),
					commands: [SaveSidebarState({ isOpen: !model.isSidebarOpen })],
				})),
				// A tooltip left open on the rail would reappear on the next collapse.
				RailTooltipBinding.requestReset(),
			]),
)

// MENU KEYS

/** Escape closes and refocuses the trigger, arrows walk the items (Base UI `Menu`). */
const pressedMenuKey = (model: Model, key: string): StepReturn =>
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

// UPDATE

export const init = ShellComposition.makeInit((flags: ShellFlags) => ({ model: initialModel(flags) }))

const keep = (model: Model): StepReturn => ({ model })

export const update = ShellComposition.makeUpdate({
	ClickedSidebarTrigger: (model) => toggleSidebarStep(model, false),
	PressedSidebarShortcut: (model) => toggleSidebarStep(model, true),
	ClickedPageSidebarTrigger: (model) =>
		model.isMobile ? toggleSidebarStep(model, false) : makeNoopStep()(model),
	RequestedInfraSurfaces: (model) => stable(model, requestInfraSurfaces(model)),
	ChangedViewport: (model, { isMobile }) => {
		const changed = modifyFields(closeMenu(model), {
			isMobile: () => isMobile,
			isMobileNavOpen: () => false,
		})
		return stable(model, isMobile ? { model: changed } : requestSidebarData(changed))
	},
	DismissedMobileNav: (model) =>
		stable(model, { model: modifyFields(model, { isMobileNavOpen: () => false }) }),
	// Crossing `lg` swaps a sheet for the inline rail; it comes back closed.
	ChangedFilterViewport: (model, { isCollapsed }) => ({
		model: modifyFields(model, {
			isFilterCollapsed: () => isCollapsed,
			filterSheet: () => initFilterSheet(),
			rightSheet: () => initRightSheet(),
		}),
	}),
	ChangedSmallViewport: (model, { isBelowSm }) =>
		stable(model, { model: modifyFields(model, { isBelowSm: () => isBelowSm }) }),
	ClickedOpenFilters: (model) => FilterSheetBinding.requestOpen()(model),
	ClickedOpenContext: (model) => RightSheetBinding.requestOpen()(model),
	ClickedMenuTrigger: (model, { menu }) => clickedMenuTrigger(model, menu),
	DismissedMenu: (model) => stable(model, { model: closeMenu(model) }),
	MeasuredSidebarOverflow: keep,
	MeasuredMenuPopup: (model, { menu, position }) =>
		stable(model, {
			model: modifyFields(model, {
				openMenu: Option.map((open) =>
					isSameMenu(open.menu, menu)
						? { menu: open.menu, maybePosition: Option.some(position) }
						: open,
				),
			}),
		}),
	PressedMenuKey: (model, { key }) => pressedMenuKey(model, key),
	HoveredMenuItem: (model, { itemId }) => ({ model, commands: [FocusElement({ id: itemId })] }),
	ClickedMenuAction: (model) => stable(model, { model: closeMenu(model) }),
	ClickedThemeSwitch: (model) => {
		const theme = model.theme === "dark" ? "light" : "dark"
		return { model: modifyFields(model, { theme: () => theme }), commands: [SaveTheme({ theme })] }
	},
	ClickedNamespace: (model, { maybeNamespace }) => clickedNamespace(model, maybeNamespace),
	ChangedNamespaceQuery: (model, { value }) =>
		stable(model, { model: modifyFields(model, { namespaceQuery: () => value }) }),
	CompletedMountNamespaceSearch: keep,
	// Clerk signs out through the root (`useClerk().signOut()`); self-hosted clears its token.
	ClickedLogOut: (model): UpdateReturn =>
		isClerkAuthEnabled
			? { model: closeMenu(model), outMessage: OutMessage.RequestedSignOut() }
			: { model: closeMenu(model), commands: [LogOut()] },
	CompletedFocusElement: keep,
	CompletedSaveTheme: keep,
	CompletedSaveNamespace: keep,
	CompletedSaveInfraSurfaces: keep,
	CompletedSaveSidebarState: keep,
	CompletedLogOut: keep,
	ElapsedVersionPollInterval: (model) => ({ model, commands: [CheckDeployedCommit()] }),
	BecameTabVisible: (model) => ({ model, commands: [CheckDeployedCommit()] }),
	CheckedDeployedCommit: (model, { maybeCommit }) =>
		stable(model, {
			model: modifyFields(model, {
				isAppOutdated: (isOutdated) =>
					isOutdated || Option.exists(maybeCommit, (commit) => commit !== BUILT_COMMIT),
			}),
		}),
	ClickedReload: (model) => ({ model, commands: [ReloadPage()] }),
	CompletedReloadPage: keep,
	ClickedAskMapleAi: (model) => ({ model, commands: [OpenGlobalChat({ isFocusVisible: false })] }),
	CompletedOpenGlobalChat: keep,
	SucceededLoadTenant: (model, { orgId }) => ({
		model: modifyFields(model, { tenant: () => TenantData.Success({ data: orgId }) }),
	}),
	FailedLoadTenant: (model) => ({
		model: modifyFields(model, { tenant: () => TenantData.Failure({ error: "Failed" }) }),
	}),
	// Org-stamped answers: one for an org the shell has left is dropped.
	SucceededLoadInfraPresence: (model, { orgId, surfaces }) =>
		surfacesAnswered(model, orgId, (current) =>
			modifyFields(current, { infraPresence: () => InfraPresenceData.Success({ data: surfaces }) }),
		),
	FailedLoadInfraPresence: (model, { orgId }) =>
		surfacesAnswered(model, orgId, (current) =>
			modifyFields(current, { infraPresence: () => InfraPresenceData.Failure({ error: "Failed" }) }),
		),
	SucceededLoadIntegration: (model, { orgId, integration, isConnected }) =>
		surfacesAnswered(model, orgId, (current) =>
			modifyFields(current, { integrations: (known) => ({ ...known, [integration]: isConnected }) }),
		),
	FailedLoadIntegration: (model, { orgId, integration }) =>
		surfacesAnswered(model, orgId, (current) =>
			modifyFields(current, { integrations: (known) => ({ ...known, [integration]: false }) }),
		),
	// A result for an org the shell has left is dropped.
	SucceededLoadDashboards: (model, { orgId, dashboards }) =>
		Option.contains(model.maybeOrgId, orgId)
			? {
					model: modifyFields(model, {
						dashboards: () => DashboardsData.Success({ data: dashboards }),
					}),
				}
			: { model },
	ChangedDashboardFavorites: (model, { favorites }) => ({
		model: modifyFields(model, { dashboardFavorites: () => favorites }),
	}),
	FailedLoadDashboards: (model, { orgId }) =>
		Option.contains(model.maybeOrgId, orgId)
			? {
					model: modifyFields(model, {
						dashboards: () => DashboardsData.Failure({ error: "Failed" }),
					}),
				}
			: { model },
	SucceededLoadNamespaces: (model, { orgId, namespaces }) =>
		forOrg(model, orgId, (current) =>
			modifyFields(current, { namespaces: () => NamespacesData.Success({ data: namespaces }) }),
		),
	FailedLoadNamespaces: (model, { orgId }) =>
		forOrg(model, orgId, (current) =>
			modifyFields(current, { namespaces: () => NamespacesData.Failure({ error: "Failed" }) }),
		),
	ClickedSupportChannel: (model) =>
		Update.combineSteps(model, [
			makeStep(() => ({ model: closeMenu(model) })),
			SupportChannelBinding.requestOpen(),
		]),
	ClickedUpdatePaymentMethod: (model) => ({ model, commands: [OpenCustomerPortal()] }),
	// The portal mutation's reactivity keys re-read the customer.
	CompletedOpenCustomerPortal: (model) => ({ model, outMessage: OutMessage.RequestedCustomerRefresh() }),
	FailedOpenCustomerPortal: (model, { message: title }) => ({
		model,
		outMessage: OutMessage.RequestedErrorToast({ title }),
	}),
	ClickedDismissQuotaBanner: (model) => ({
		model: modifyFields(model, { isQuotaApproachingDismissed: () => true }),
		commands: [DismissQuotaBanner()],
	}),
	CompletedDismissQuotaBanner: keep,
	ClickedSearch: (model) => openPaletteStep(model),
	// Mod+K while the palette is open keeps it open: a no-op.
	PressedPaletteShortcut: (model) => openPaletteStep(model),
	PressedShortcutsKey: (model) => openShortcutsStep(model),
	PressedThemeKey: (model) => toggleTheme(model),
	PressedFocusSearchKey: (model) => ({ model, commands: [FocusShortcutSearch()] }),
	CompletedFocusShortcutSearch: keep,
	MeasuredShortcutsPanel: keep,
	ClickedKeyboardShortcuts: (model) =>
		Update.combineSteps(model, [makeStep(() => ({ model: closeMenu(model) })), openShortcutsStep]),
	CompletedReleasePaletteServices: keep,
	RequestedEnter: (model, { orgId }) => enterStep(model, orgId),
	RequestedEnterBare: (model) => enterBare(model),
	ChangedRoute: (model, { isSamePage, hasTopBar }) => routeChangedStep(model, isSamePage, hasTopBar),
	TickedChecklistClock: (model, { nowMs }) => ChecklistBinding.informOfClock({ nowMs })(model),
	TickedConnectPoll: (model) => ConnectBinding.informOfPollTick(connectContextOf(model))(model),
	RequestedSwitchOrganization: (model, { orgId, targetUrl }) =>
		ClerkOrgMenuBinding.requestSwitchOrganization({ orgId, targetUrl })(model),
})
