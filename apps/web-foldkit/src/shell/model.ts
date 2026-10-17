import { InfraSurfaceLiteral } from "@maple/domain/http"
import { OrgId } from "@maple/domain"
import { Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import { PopupPosition } from "../ui/anchor"
import { PinnedDashboardRow } from "./dashboards-shape"
import { Menu, Theme } from "./message"

/** A loader that failed reads as legacy's `orElse` fallback; the reason is not shown anywhere. */
export const LoadFailure = Schema.Literal("Failed")

export const TenantData = AsyncData.Schema(OrgId, LoadFailure)
export const InfraPresenceData = AsyncData.Schema(Schema.Array(InfraSurfaceLiteral), LoadFailure)
export const DashboardsData = AsyncData.Schema(Schema.Array(PinnedDashboardRow), LoadFailure)
export const NamespacesData = AsyncData.Schema(Schema.Array(Schema.String), LoadFailure)

export const OpenMenu = Schema.Struct({ menu: Menu, maybePosition: Schema.Option(PopupPosition) })
export type OpenMenu = typeof OpenMenu.Type

/** Connected integrations; one that has not answered (or failed) counts as not connected. */
export const Integrations = Schema.Struct({
	cloudflare: Schema.Boolean,
	railway: Schema.Boolean,
	planetscale: Schema.Boolean,
	gcp: Schema.Boolean,
})

export const Model = Schema.Struct({
	/** Desktop rail expanded (`SidebarProvider` `open`). */
	isSidebarOpen: Schema.Boolean,
	/** The mobile nav sheet (`openMobile`). */
	isMobileNavOpen: Schema.Boolean,
	/** Below `md` the sidebar is a sheet (`useIsMobile`). */
	isMobile: Schema.Boolean,
	theme: Theme,
	openMenu: Schema.Option(OpenMenu),
	maybeOrgId: Schema.Option(Schema.String),
	/** `maple.global-namespace.<orgId>` values, read at boot. */
	pinnedNamespaces: Schema.Record(Schema.String, Schema.String),
	/** `maple.dashboards.favorites`. */
	dashboardFavorites: Schema.Array(Schema.String),
	tenant: TenantData.schema,
	infraPresence: InfraPresenceData.schema,
	integrations: Integrations,
	dashboards: DashboardsData.schema,
	namespaces: NamespacesData.schema,
	/** The server serves a newer build than this tab (`AppUpdateBanner`). */
	isAppOutdated: Schema.Boolean,
})
export type Model = typeof Model.Type

/** Persisted shell state, read before the first render (see `main.ts` flags). */
export type ShellFlags = Readonly<{
	isMobile: boolean
	theme: Theme
	pinnedNamespaces: Readonly<Record<string, string>>
	dashboardFavorites: ReadonlyArray<string>
}>

export const init = (flags: ShellFlags): Model => ({
	isSidebarOpen: true,
	isMobileNavOpen: false,
	isMobile: flags.isMobile,
	theme: flags.theme,
	openMenu: Option.none(),
	maybeOrgId: Option.none(),
	pinnedNamespaces: flags.pinnedNamespaces,
	dashboardFavorites: flags.dashboardFavorites,
	tenant: TenantData.Idle(),
	infraPresence: InfraPresenceData.Idle(),
	integrations: { cloudflare: false, railway: false, planetscale: false, gcp: false },
	dashboards: DashboardsData.Idle(),
	namespaces: NamespacesData.Idle(),
	isAppOutdated: false,
})
