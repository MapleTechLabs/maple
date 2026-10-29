import { Layer } from "effect"
import { Block } from "foldkit"
import { DismissQuotaBanner, OpenCustomerPortal } from "./billing-banners"
import {
	FocusElement,
	FocusShortcutSearch,
	FocusSiblingMenuItem,
	LogOut,
	OpenGlobalChat,
	ReleasePaletteServices,
	SaveInfraSurfaces,
	SaveNamespace,
	SaveSidebarState,
	SaveTheme,
} from "./command"
import { ShellComposition } from "./composition"
import {
	LoadAwsStatus,
	LoadCloudflareStatus,
	LoadGcpStatus,
	LoadInfraPresence,
	LoadNamespaces,
	LoadPlanetscaleStatus,
	LoadRailwayStatus,
	LoadSupabaseStatus,
	LoadTenant,
} from "./data"
import { Message } from "./message"
import { Model } from "./model"
import { MeasureShortcutsPanel, MeasureSidebarOverflow, MountNamespaceSearch, PositionMenu } from "./mounts"
import { init, update } from "./update"
import { CheckDeployedCommit, ReloadPage } from "./version"
import { frameView } from "./view"

// The completed shell: its children's handlers travel with their Bindings, these are its own.

const EffectsLayer = Layer.mergeAll(
	FocusElement.layer,
	FocusSiblingMenuItem.layer,
	FocusShortcutSearch.layer,
	LogOut.layer,
	OpenGlobalChat.layer,
	ReleasePaletteServices.layer,
	SaveInfraSurfaces.layer,
	SaveNamespace.layer,
	SaveSidebarState.layer,
	SaveTheme.layer,
	LoadTenant.layer,
	LoadInfraPresence.layer,
	LoadCloudflareStatus.layer,
	LoadPlanetscaleStatus.layer,
	LoadRailwayStatus.layer,
	LoadGcpStatus.layer,
	LoadSupabaseStatus.layer,
	LoadAwsStatus.layer,
	LoadNamespaces.layer,
	CheckDeployedCommit.layer,
	ReloadPage.layer,
	DismissQuotaBanner.layer,
	OpenCustomerPortal.layer,
	PositionMenu.layer,
	MountNamespaceSearch.layer,
	MeasureSidebarOverflow.layer,
	MeasureShortcutsPanel.layer,
)

/** What the root asks of the shell, and the facts its own Subscriptions and pages report to it. */
const operations = {
	requestEnter: Message.RequestedEnter,
	requestEnterBare: Message.RequestedEnterBare,
	informOfRoute: Message.ChangedRoute,
	informOfChecklistClock: Message.TickedChecklistClock,
	informOfConnectPoll: Message.TickedConnectPoll,
	requestSwitchOrganization: Message.RequestedSwitchOrganization,
	requestNamespace: Message.ClickedNamespace,
	requestPageSidebarToggle: Message.ClickedPageSidebarTrigger,
	requestInfraSurfaces: Message.RequestedInfraSurfaces,
	informOfViewport: Message.ChangedViewport,
	informOfFilterViewport: Message.ChangedFilterViewport,
	informOfSmallViewport: Message.ChangedSmallViewport,
	requestSidebarToggle: Message.PressedSidebarShortcut,
	requestPalette: Message.PressedPaletteShortcut,
	requestShortcuts: Message.PressedShortcutsKey,
	requestThemeToggle: Message.PressedThemeKey,
	requestSearchFocus: Message.PressedFocusSearchKey,
	informOfDashboards: Message.SucceededLoadDashboards,
	informOfDashboardsFailure: Message.FailedLoadDashboards,
	informOfDashboardFavorites: Message.ChangedDashboardFavorites,
	requestVersionCheck: Message.ElapsedVersionPollInterval,
	informOfVisibleTab: Message.BecameTabVisible,
}

const prepare = () =>
	ShellComposition.prepareBlock({ init, update, view: frameView, operations, EffectsLayer })
export const ShellBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
