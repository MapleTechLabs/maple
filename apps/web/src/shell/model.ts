import { InfraSurfaceLiteral } from "@maple/domain/http"
import type { BillingCustomer } from "@maple/domain/http"
import type { ClerkOrganization, ClerkUser } from "../platform/clerk"
import { Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import { PopupPosition } from "../ui/anchor"
import * as Dialog from "../ui/dialog"
import * as Tooltip from "../ui/tooltip"
import * as ClerkOrgSwitcher from "./clerk-org-switcher"
import * as Checklist from "./onboarding-checklist"
import * as ConnectPanel from "./connect-panel"
import * as SupportChannel from "./support-channel"
import { PinnedDashboardRow } from "./dashboards-shape"
import * as Palette from "./palette/model"
import { Platform } from "./palette/shortcuts"
import { Menu, Theme } from "./message"
import { NavSurface } from "./nav"
import {
	type InfraSurfaces,
	PENDING_INTEGRATIONS,
	type PresenceProbe,
	probeOf,
	resolveInfraSurfaces,
} from "../data/infra-surfaces"

/** A loader that failed reads as its fallback; the reason is not shown anywhere. */
export const LoadFailure = Schema.Literal("Failed")

export const InfraPresenceData = AsyncData.Schema(Schema.Array(InfraSurfaceLiteral), LoadFailure)
export const DashboardsData = AsyncData.Schema(Schema.Array(PinnedDashboardRow), LoadFailure)
export const NamespacesData = AsyncData.Schema(Schema.Array(Schema.String), LoadFailure)

export const OpenMenu = Schema.Struct({ menu: Menu, maybePosition: Schema.Option(PopupPosition) })
export type OpenMenu = typeof OpenMenu.Type

/** Connected integrations: `null` until its status answers; a failed status counts as not connected. */
const IntegrationFlag = Schema.NullOr(Schema.Boolean)
export const Integrations = Schema.Struct({
	cloudflare: IntegrationFlag,
	railway: IntegrationFlag,
	planetscale: IntegrationFlag,
	gcp: IntegrationFlag,
	supabase: IntegrationFlag,
	aws: IntegrationFlag,
})

export const Model = Schema.Struct({
	/** Desktop rail expanded (`SidebarProvider` `open`). */
	isSidebarOpen: Schema.Boolean,
	/** The mobile nav sheet (`openMobile`). */
	isMobileNavOpen: Schema.Boolean,
	/** Below `md` the sidebar is a sheet (`useIsMobile`). */
	isMobile: Schema.Boolean,
	/** The sidebar's own reads (infra presence, integrations, pinned dashboards) were sent for this org. */
	hasRequestedSidebarData: Schema.Boolean,
	/** Below `lg` the page rails are sheets (`PageLayout`'s `useMediaQuery("max-lg")`). */
	isFilterCollapsed: Schema.Boolean,
	/** Below `sm` (`useMediaQuery("max-sm")`), passed to pages that branch on it. */
	isBelowSm: Schema.Boolean,
	/** `PageLayout.FilterSidebar` and `RightSidebar` as sheets, opened from the top bar. */
	filterSheet: Dialog.Model,
	rightSheet: Dialog.Model,
	theme: Theme,
	openMenu: Schema.Option(OpenMenu),
	maybeOrgId: Schema.Option(Schema.String),
	/** `maple.global-namespace.<orgId>` values, read at boot. */
	pinnedNamespaces: Schema.Record(Schema.String, Schema.String),
	/** `maple.dashboards.favorites`. */
	dashboardFavorites: Schema.Array(Schema.String),
	infraPresence: InfraPresenceData.schema,
	integrations: Integrations,
	/** `maple.infra-surfaces.<orgId>`: each org's last settled surfaces, so the sidebar lays out once. */
	rememberedSurfaces: Schema.Record(Schema.String, Schema.Array(NavSurface)),
	dashboards: DashboardsData.schema,
	namespaces: NamespacesData.schema,
	/** The self-hosted namespace menu's search query; each opening starts blank. */
	namespaceQuery: Schema.String,
	/** The collapsed rail's tooltips: one Tooltip shared by every rail button. */
	railTooltip: Tooltip.Model,
	/** Clerk: the org switcher (`ClerkOrgSwitcherMenu namespaceScope`). */
	clerkOrgMenu: ClerkOrgSwitcher.Model,
	/** Clerk: the onboarding reward pill in the top bar. */
	checklist: Checklist.Model,
	/** The top bar's Connect popover (`ConnectButton`). */
	connect: ConnectPanel.Model,
	/** Clerk: the shared Slack channel dialog of the Support menu. */
	supportChannel: SupportChannel.Model,
	/** `quota-banner-approaching` in sessionStorage: the approaching-quota banner was dismissed. */
	isQuotaApproachingDismissed: Schema.Boolean,
	/** The server serves a newer build than this tab (`AppUpdateBanner`). */
	isAppOutdated: Schema.Boolean,
	/** `GlobalShortcuts`: the command palette and the shortcuts dialog, `null` while unmounted. */
	palette: Schema.NullOr(Palette.Model),
	shortcutsDialog: Schema.NullOr(Dialog.Model),
	/** `detectPlatform`: how the shortcuts dialog spells modifiers. */
	platform: Platform,
})
export type Model = typeof Model.Type

/**
 * What the shell reads from Clerk and Autumn in Clerk mode (`useUser`, `useOrganization`,
 * `useOrganizationList`, `useMapleCustomer`), passed in by the root; `null` self-hosted.
 */
export type ShellClerk = Readonly<{
	maybeUser: Option.Option<ClerkUser>
	maybeOrganization: Option.Option<ClerkOrganization>
	memberships: ReadonlyArray<ClerkOrganization>
	customer: BillingCustomer | undefined
}>

/** `<TooltipPopup side="right" align="center">` of `SidebarMenuButton`. */
export const initRailTooltip = (): Tooltip.Model =>
	Tooltip.init("shell-rail-tooltip", { side: "right", align: "center" })

export const FILTER_SHEET_ID = "page-filter-sheet"
export const RIGHT_SHEET_ID = "page-right-sheet"

/** A page change starts the page's sheets closed. */
export const initFilterSheet = (): Dialog.Model => Dialog.init(FILTER_SHEET_ID, "sheet")
export const initRightSheet = (): Dialog.Model => Dialog.init(RIGHT_SHEET_ID, "sheet")

/** Persisted shell state, read before the first render (see `main.ts` flags). */
export type ShellFlags = Readonly<{
	isMobile: boolean
	isFilterCollapsed?: boolean
	isBelowSm?: boolean
	theme: Theme
	pinnedNamespaces: Readonly<Record<string, string>>
	dashboardFavorites: ReadonlyArray<string>
	rememberedSurfaces?: Readonly<Record<string, ReadonlyArray<NavSurface>>>
	isQuotaApproachingDismissed?: boolean
	platform?: Platform
}>

export const init = (flags: ShellFlags): Model => ({
	isSidebarOpen: true,
	isMobileNavOpen: false,
	isMobile: flags.isMobile,
	hasRequestedSidebarData: false,
	isFilterCollapsed: flags.isFilterCollapsed ?? false,
	isBelowSm: flags.isBelowSm ?? false,
	filterSheet: initFilterSheet(),
	rightSheet: initRightSheet(),
	theme: flags.theme,
	openMenu: Option.none(),
	maybeOrgId: Option.none(),
	pinnedNamespaces: flags.pinnedNamespaces,
	dashboardFavorites: flags.dashboardFavorites,
	infraPresence: InfraPresenceData.Idle(),
	integrations: PENDING_INTEGRATIONS,
	rememberedSurfaces: flags.rememberedSurfaces ?? {},
	dashboards: DashboardsData.Idle(),
	namespaces: NamespacesData.Idle(),
	namespaceQuery: "",
	isAppOutdated: false,
	railTooltip: initRailTooltip(),
	clerkOrgMenu: ClerkOrgSwitcher.init("shell-clerk-org-switcher"),
	checklist: Checklist.init(),
	connect: ConnectPanel.init(),
	supportChannel: SupportChannel.init(),
	isQuotaApproachingDismissed: flags.isQuotaApproachingDismissed ?? false,
	palette: null,
	shortcutsDialog: null,
	platform: flags.platform ?? "mac",
})

/** The sidebar's last-hour probe as `resolveInfraSurfaces` reads it; a re-read keeps the last answer. */
export const shellProbe = (model: Model): PresenceProbe => probeOf(model.infraPresence)

/** `useInfraSurfaces()`: the live answer once complete, else the org's remembered set. */
export const shellSurfaces = (model: Model): InfraSurfaces =>
	resolveInfraSurfaces(
		shellProbe(model),
		model.integrations,
		Option.getOrUndefined(
			Option.flatMapNullishOr(model.maybeOrgId, (orgId) => model.rememberedSurfaces[orgId]),
		),
	)
