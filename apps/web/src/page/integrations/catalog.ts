import { type ChatConnectorManifest, chatConnectorManifests } from "@maple/chat-platform/manifests"
import { ChatConnectorId } from "@maple/domain/primitives"
import { docsUrl } from "../../lib/docs"
import { Option, Schema, String as Str, Array as Arr } from "effect"
import type { IconName } from "@maple/views/ui/icon"
import { DATA_SOURCE_KINDS, type DataSourceKind } from "@maple/domain/data-sources"
import { PLANETSCALE_COLOR } from "../infra-integrations/planetscale/notices"
import { SUPABASE_ACCENT } from "../infra-integrations/supabase/connect"

// The integration catalog's data.

export type ChatIntegrationId = `chat-${string}`
export type IntegrationId =
	| "cloudflare"
	| "prometheus"
	| "planetscale"
	| "gcp"
	| "aws"
	| "railway"
	| "vercel"
	| "supabase"
	| "warpstream"
	| "linear"
	| "github"
	| "google-search-console"
	| ChatIntegrationId

export const GITHUB_ACCENT = "#181717"
export const LINEAR_ACCENT = "#5E6AD5"
export const CLOUDFLARE_ACCENT = "#F38020"
export const RAILWAY_ACCENT = "#0B0D0E"
export const GCP_ACCENT = "#4285F4"
export const VERCEL_ACCENT = "#000000"
export const AWS_ACCENT = "#FF9900"

/** A generated icon, or a chat connector's manifest mark (rendered from its path data). */
export type EntryIcon =
	| Readonly<{ _tag: "Named"; name: IconName }>
	| Readonly<{ _tag: "Manifest"; icon: ChatConnectorManifest["icon"] }>

export type IntegrationCategory = "infrastructure" | "code" | "analytics" | "notifications"

/** What a connection does for Maple: the hub's row chips and filters. */
export const CAPABILITIES = ["telemetry", "query", "alerts", "analytics"] as const
export type Capability = (typeof CAPABILITIES)[number]

export const HubFilter = Schema.Literals(["all", ...CAPABILITIES, "attention"])
export type HubFilter = typeof HubFilter.Type

/** The row chip's word, then the filter chip's. */
export const CAPABILITY_LABEL = {
	telemetry: { chip: "Telemetry", filter: "Telemetry" },
	query: { chip: "Query", filter: "Query" },
	alerts: { chip: "Alerts", filter: "Alerts & chat" },
	analytics: { chip: "Analytics", filter: "Analytics" },
} as const satisfies Record<Capability, { readonly chip: string; readonly filter: string }>

export const capabilityOf = (category: IntegrationCategory): Capability =>
	category === "notifications" ? "alerts" : category === "analytics" ? "analytics" : "telemetry"

export interface CatalogEntry {
	readonly id: IntegrationId
	readonly name: string
	readonly description: string
	readonly icon: EntryIcon
	readonly accent: string
	readonly iconClassName?: string
	readonly docsUrl?: string
	readonly category: IntegrationCategory
	readonly isNew?: boolean
}

export const INTEGRATION_CATEGORIES: ReadonlyArray<{
	readonly id: IntegrationCategory
	readonly label: string
}> = [
	{ id: "infrastructure", label: "Infrastructure" },
	{ id: "code", label: "Code & deploys" },
	{ id: "notifications", label: "Chat & alerts" },
	{ id: "analytics", label: "Web analytics" },
]

/** A data source kind's card on the hub's "Query in place" shelf. */
export interface DataSourceKindEntry {
	readonly kind: DataSourceKind
	readonly name: string
	readonly description: string
	readonly icon: IconName
	readonly accent: string
}

export const DATA_SOURCE_KIND_ENTRY = {
	clickhouse: {
		kind: "clickhouse",
		name: "ClickHouse",
		description: "Query your own cluster in place from dashboards, alerts and agents.",
		icon: "ClickhouseIcon",
		accent: "#FAFF69",
	},
	clerk: {
		kind: "clerk",
		name: "Clerk",
		description: "Read users, organizations and sessions from your Clerk instance.",
		icon: "ClerkIcon",
		accent: "#6C47FF",
	},
} as const satisfies { readonly [K in DataSourceKind]: DataSourceKindEntry & { readonly kind: K } }

export const DATA_SOURCE_KIND_ENTRIES: ReadonlyArray<DataSourceKindEntry> = Arr.map(
	DATA_SOURCE_KINDS,
	(kind) => DATA_SOURCE_KIND_ENTRY[kind],
)

const named = (name: IconName): EntryIcon => ({ _tag: "Named", name })

export const chatIntegrationId = (connector: string): ChatIntegrationId => `chat-${connector}`

const decodeConnectorId = Schema.decodeUnknownOption(ChatConnectorId)

/** The connector behind a chat catalog id, or `null` for every other entry. */
export const chatConnectorOf = (id: IntegrationId): ChatConnectorId | null =>
	Str.startsWith("chat-")(id) ? Option.getOrNull(decodeConnectorId(Str.slice("chat-".length)(id))) : null

export const chatManifestOf = (connector: string): ChatConnectorManifest | undefined =>
	Option.getOrUndefined(Arr.findFirst(chatConnectorManifests, (manifest) => manifest.id === connector))

const CHAT_ENTRIES: ReadonlyArray<CatalogEntry> = Arr.map(chatConnectorManifests, (manifest) => ({
	id: chatIntegrationId(manifest.id),
	name: manifest.name,
	description: manifest.description,
	icon: { _tag: "Manifest", icon: manifest.icon },
	accent: manifest.accent,
	category: "notifications",
}))

const CLOUDFLARE_ENTRY: CatalogEntry = {
	id: "cloudflare",
	category: "infrastructure",
	name: "Cloudflare",
	description: "Connect your Cloudflare account via OAuth to collect zone and Workers analytics.",
	icon: named("CloudflareBrandIcon"),
	accent: CLOUDFLARE_ACCENT,
	docsUrl: docsUrl("cloudflare"),
}

export const CATALOG: ReadonlyArray<CatalogEntry> = [
	CLOUDFLARE_ENTRY,
	{
		id: "prometheus",
		category: "infrastructure",
		name: "Prometheus",
		description: "Scrape any Prometheus-compatible endpoint on a schedule. No collector required.",
		icon: named("PrometheusIcon"),
		accent: "#E6522C",
		docsUrl: docsUrl("prometheus"),
	},
	{
		id: "planetscale",
		category: "infrastructure",
		name: "PlanetScale",
		description:
			"Authorize your organization with one click. Maple tracks every database branch automatically.",
		icon: named("PlanetScaleIcon"),
		accent: PLANETSCALE_COLOR,
		docsUrl: docsUrl("planetscale"),
	},
	{
		id: "gcp",
		category: "infrastructure",
		isNew: true,
		name: "Google Cloud",
		description: "Logs, metrics and resources from a project, folder or organization.",
		icon: named("GoogleCloudIcon"),
		accent: GCP_ACCENT,
		docsUrl: docsUrl("gcp"),
	},
	{
		id: "aws",
		category: "infrastructure",
		isNew: true,
		name: "AWS",
		description: "Connect an AWS account through a read-only role you deploy with CloudFormation.",
		icon: named("AwsIcon"),
		accent: AWS_ACCENT,
		iconClassName: "text-foreground",
		docsUrl: docsUrl("aws"),
	},
	{
		id: "railway",
		category: "infrastructure",
		isNew: true,
		name: "Railway",
		description:
			"Paste a Railway token to collect CPU, memory, network and disk metrics for every service.",
		icon: named("RailwayIcon"),
		accent: RAILWAY_ACCENT,
		iconClassName: "text-foreground",
		docsUrl: docsUrl("railway"),
	},
	{
		id: "supabase",
		category: "infrastructure",
		isNew: true,
		name: "Supabase",
		description:
			"Authorize your Supabase organization to collect CPU, memory, disk and Postgres metrics for every project.",
		icon: named("SupabaseIcon"),
		accent: SUPABASE_ACCENT,
		docsUrl: docsUrl("supabase"),
	},
	{
		id: "vercel",
		category: "infrastructure",
		isNew: true,
		name: "Vercel",
		description: "Paste a Vercel token to drain request logs, traces and AI Gateway usage from a team.",
		icon: named("VercelIcon"),
		accent: VERCEL_ACCENT,
		iconClassName: "text-foreground",
		docsUrl: docsUrl("vercel"),
	},
	{
		id: "warpstream",
		category: "infrastructure",
		name: "WarpStream",
		description: "Monitor WarpStream clusters via agent metrics or the hosted Prometheus endpoint.",
		icon: named("WarpStreamIcon"),
		accent: "#E52344",
		docsUrl: docsUrl("warpstream"),
	},
	{
		id: "linear",
		category: "notifications",
		name: "Linear",
		description:
			"Open one Linear issue per alert rule, then comment as it fires again, changes severity or resolves.",
		icon: named("LinearIcon"),
		accent: LINEAR_ACCENT,
	},
	{
		id: "github",
		category: "code",
		name: "GitHub",
		description: "Install the Maple GitHub App to sync repositories and commits from your org.",
		icon: named("GithubIcon"),
		accent: GITHUB_ACCENT,
		iconClassName: "text-foreground",
		docsUrl: docsUrl("github"),
	},
	{
		id: "google-search-console",
		category: "analytics",
		isNew: true,
		name: "Google Search Console",
		description: "Import the search queries, pages and positions that bring people to your sites.",
		icon: named("GoogleIcon"),
		accent: GCP_ACCENT,
	},
	...CHAT_ENTRIES,
]

export const catalogEntry = (id: IntegrationId): CatalogEntry =>
	Option.getOrElse(
		Arr.findFirst(CATALOG, (entry) => entry.id === id),
		() => CLOUDFLARE_ENTRY,
	)

/** Whether a URL value names a catalog entry (the OAuth callbacks append `?integration=`). */
export const isIntegrationId = (value: string): value is IntegrationId =>
	Arr.some(CATALOG, (entry) => entry.id === value)

/** The `?integration=` the page shows: a known id, else the hub. */
export const integrationOfSearch = (value: string | undefined): IntegrationId | null =>
	value !== undefined && isIntegrationId(value) ? value : null
