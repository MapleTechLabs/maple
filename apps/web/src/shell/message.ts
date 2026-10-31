import { InfraSurfaceLiteral } from "@maple/domain/http"
import { V2Source } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { PopupPosition } from "../ui/anchor"
import * as Dialog from "../ui/dialog"
import * as Tooltip from "../ui/tooltip"
import * as ClerkOrgSwitcher from "./clerk-org-switcher"
import * as Checklist from "./onboarding-checklist"
import * as ConnectPanel from "./connect-panel"
import * as SupportChannel from "./support-channel"
import { PinnedDashboardRow } from "./dashboards-shape"
import * as Palette from "./palette/model"

/** The shell's dropdown menus; a collapsed-rail section menu is keyed by its section title. */
export const Menu = defineTaggedUnion({
	Org: {},
	User: {},
	Support: {},
	NavSection: { title: Schema.String },
})
export type Menu = typeof Menu.Type

export const Integration = Schema.Literals(["cloudflare", "railway", "planetscale", "gcp", "supabase", "aws"])
export type Integration = typeof Integration.Type

export const Theme = Schema.Literals(["light", "dark"])
export type Theme = typeof Theme.Type

export const Message = defineMessageUnion({
	ClickedSidebarTrigger: {},
	PressedSidebarShortcut: {},
	/** A page reads `useInfraSurfaces` itself (the infra overview, Kubernetes workloads). */
	RequestedInfraSurfaces: {},
	/** A page links to its source: read the org's sources, again when `isRefresh` (one may be new). */
	RequestedSources: { isRefresh: Schema.Boolean },
	ChangedViewport: { isMobile: Schema.Boolean },
	DismissedMobileNav: {},
	ChangedFilterViewport: { isCollapsed: Schema.Boolean },
	ChangedSmallViewport: { isBelowSm: Schema.Boolean },
	/** The top bar's "Open filters" / "Open context" (`FilterSidebarTrigger`, `RightSidebarTrigger`). */
	ClickedOpenFilters: {},
	ClickedOpenContext: {},
	GotFilterSheetMessage: { message: Dialog.Message },
	GotRightSheetMessage: { message: Dialog.Message },
	ClickedMenuTrigger: { menu: Menu },
	DismissedMenu: {},
	MeasuredMenuPopup: { menu: Menu, position: PopupPosition },
	/** The sidebar nav's overflow was measured (the Mount keeps it current itself). */
	MeasuredSidebarOverflow: {},
	PressedMenuKey: { key: Schema.String },
	HoveredMenuItem: { itemId: Schema.String },
	ClickedMenuAction: {},
	ClickedThemeSwitch: {},
	ClickedNamespace: { maybeNamespace: Schema.Option(Schema.String) },
	/** The namespace list's search row (from eight namespaces). */
	ChangedNamespaceQuery: { value: Schema.String },
	CompletedMountNamespaceSearch: {},
	ClickedLogOut: {},
	CompletedFocusElement: {},
	CompletedSaveTheme: {},
	CompletedSaveNamespace: {},
	CompletedSaveInfraSurfaces: {},
	CompletedSaveSidebarState: {},
	CompletedLogOut: {},
	ElapsedVersionPollInterval: {},
	BecameTabVisible: {},
	CheckedDeployedCommit: { maybeCommit: Schema.Option(Schema.String) },
	ClickedReload: {},
	CompletedReloadPage: {},
	SucceededLoadInfraPresence: { orgId: Schema.String, surfaces: Schema.Array(InfraSurfaceLiteral) },
	FailedLoadInfraPresence: { orgId: Schema.String },
	SucceededLoadSources: { orgId: Schema.String, sources: Schema.Array(V2Source) },
	FailedLoadSources: { orgId: Schema.String },
	SucceededLoadIntegration: { orgId: Schema.String, integration: Integration, isConnected: Schema.Boolean },
	FailedLoadIntegration: { orgId: Schema.String, integration: Integration },
	SucceededLoadDashboards: { orgId: Schema.String, dashboards: Schema.Array(PinnedDashboardRow) },
	FailedLoadDashboards: { orgId: Schema.String },
	ChangedDashboardFavorites: { favorites: Schema.Array(Schema.String) },
	SucceededLoadNamespaces: { orgId: Schema.String, namespaces: Schema.Array(Schema.String) },
	FailedLoadNamespaces: { orgId: Schema.String },
	GotRailTooltipMessage: { message: Tooltip.Message },
	GotClerkOrgMenuMessage: { message: ClerkOrgSwitcher.Message },
	GotChecklistMessage: { message: Checklist.Message },
	GotConnectMessage: { message: ConnectPanel.Message },
	GotSupportChannelMessage: { message: SupportChannel.Message },
	ClickedSupportChannel: {},
	ClickedUpdatePaymentMethod: {},
	CompletedOpenCustomerPortal: {},
	FailedOpenCustomerPortal: { message: Schema.String },
	ClickedDismissQuotaBanner: {},
	CompletedDismissQuotaBanner: {},
	/** The sidebar's Search row (`openCommandPalette`). */
	ClickedSearch: {},
	/** Mod+K, anywhere: opens the palette (a no-op while it is open). */
	PressedPaletteShortcut: {},
	/** `?`, `T` and `/` outside fields and dialogs (`GlobalShortcuts`). */
	PressedShortcutsKey: {},
	PressedThemeKey: {},
	PressedFocusSearchKey: {},
	CompletedFocusShortcutSearch: {},
	GotPaletteMessage: { message: Palette.Message },
	GotShortcutsDialogMessage: { message: Dialog.Message },
	MeasuredShortcutsPanel: {},
	/** A menu's "Keyboard shortcuts" item (`showKeyboardShortcuts`). */
	ClickedKeyboardShortcuts: {},
})
export type Message = typeof Message.Type

/** Facts the shell reports to the root. */
export const OutMessage = defineMessageUnion({
	/** The org-global namespace pin changed: pages rebuild their queries under the new scope. */
	ChangedGlobalNamespace: { maybeNamespace: Schema.Option(Schema.String) },
	/** Every integration status answered: pages waiting on the org's surfaces read now. */
	SettledInfraSurfaces: {},
	/** Clerk: an org other than the active one was picked (`setActive`, then reload). */
	RequestedOrganizationSwitch: { orgId: Schema.String },
	/** Clerk: Log out in the user menu (`signOut()`). */
	RequestedSignOut: {},
	/** A failure the shell reports as an error toast (the billing portal not opening). */
	RequestedErrorToast: { title: Schema.String },
	/** A billing mutation succeeded: the Autumn customer is re-read. */
	RequestedCustomerRefresh: {},
	/** The command palette opened a page. */
	RequestedNavigation: { url: Schema.String },
})
export type OutMessage = typeof OutMessage.Type
