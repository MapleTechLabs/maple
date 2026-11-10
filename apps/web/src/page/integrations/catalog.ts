import { type ChatConnectorManifest, chatConnectorManifests } from "@maple/chat-platform/manifests"
import { ChatConnectorId } from "@maple/domain/primitives"
import { Option, Schema, String as Str, Array as Arr } from "effect"
import type { IconName } from "@maple/views/ui/icon"
import { type Provider, type ProviderId, PROVIDERS } from "../kit/providers"

// The integration catalog's data.

export type ChatIntegrationId = `chat-${string}`
export type IntegrationId = ProviderId | ChatIntegrationId

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

const named = (name: IconName): EntryIcon => ({ _tag: "Named", name })

export const chatIntegrationId = (connector: string): ChatIntegrationId => `chat-${connector}`

const decodeConnectorId = Schema.decodeUnknownOption(ChatConnectorId)

/** The connector behind a chat catalog id, or `null` for every other entry. */
export const chatConnectorOf = (id: IntegrationId): ChatConnectorId | null =>
	Str.startsWith("chat-")(id) ? Option.getOrNull(decodeConnectorId(Str.slice("chat-".length)(id))) : null

export const chatManifestOf = (connector: string): ChatConnectorManifest | undefined =>
	Option.getOrUndefined(Arr.findFirst(chatConnectorManifests, (manifest) => manifest.id === connector))

/** A chat connector's entry, from its manifest. */
export const chatEntry = (manifest: ChatConnectorManifest): CatalogEntry => ({
	id: chatIntegrationId(manifest.id),
	name: manifest.name,
	description: manifest.description,
	icon: { _tag: "Manifest", icon: manifest.icon },
	accent: manifest.accent,
	category: "notifications",
})

const CHAT_ENTRIES: ReadonlyArray<CatalogEntry> = Arr.map(chatConnectorManifests, chatEntry)

type ProviderCopy = Readonly<{ description: string; category: IntegrationCategory; isNew?: boolean }>

const PROVIDER_COPY = {
	cloudflare: {
		category: "infrastructure",
		description: "Connect your Cloudflare account via OAuth to collect zone and Workers analytics.",
	},
	prometheus: {
		category: "infrastructure",
		description: "Scrape any Prometheus-compatible endpoint on a schedule. No collector required.",
	},
	planetscale: {
		category: "infrastructure",
		description:
			"Authorize your organization with one click. Maple tracks every database branch automatically.",
	},
	gcp: {
		category: "infrastructure",
		isNew: true,
		description: "Logs, metrics and resources from a project, folder or organization.",
	},
	aws: {
		category: "infrastructure",
		isNew: true,
		description: "Connect an AWS account through a read-only role you deploy with CloudFormation.",
	},
	railway: {
		category: "infrastructure",
		isNew: true,
		description:
			"Paste a Railway token to collect CPU, memory, network and disk metrics for every service.",
	},
	supabase: {
		category: "infrastructure",
		isNew: true,
		description:
			"Authorize your Supabase organization to collect CPU, memory, disk and Postgres metrics for every project.",
	},
	warpstream: {
		category: "infrastructure",
		description: "Monitor WarpStream clusters via agent metrics or the hosted Prometheus endpoint.",
	},
	linear: {
		category: "notifications",
		description:
			"Open one Linear issue per alert rule, then comment as it fires again, changes severity or resolves.",
	},
	github: {
		category: "code",
		description: "Install the Maple GitHub App to sync repositories and commits from your org.",
	},
	"google-search-console": {
		category: "analytics",
		isNew: true,
		description: "Import the search queries, pages and positions that bring people to your sites.",
	},
} as const satisfies { readonly [K in ProviderId]: ProviderCopy }

const providerEntry = (provider: Provider, copy: ProviderCopy): CatalogEntry => ({
	id: provider.id,
	name: provider.name,
	description: copy.description,
	icon: named(provider.icon),
	accent: provider.accent,
	category: copy.category,
	iconClassName: provider.iconClassName,
	docsUrl: provider.docsUrl,
	isNew: copy.isNew,
})

/** The hub's order. */
const PROVIDER_ORDER: ReadonlyArray<ProviderId> = [
	"cloudflare",
	"prometheus",
	"planetscale",
	"gcp",
	"aws",
	"railway",
	"supabase",
	"warpstream",
	"linear",
	"github",
	"google-search-console",
]

/** A provider's entry; every provider has one. */
export const catalogEntry = (id: ProviderId): CatalogEntry => providerEntry(PROVIDERS[id], PROVIDER_COPY[id])

/** Every entry, in the hub's order: the providers, then the chat connectors. */
export const CATALOG: ReadonlyArray<CatalogEntry> = [
	...Arr.map(PROVIDER_ORDER, catalogEntry),
	...CHAT_ENTRIES,
]

/** The entry a URL value names (the OAuth callbacks append `?integration=`), or `null`. */
export const entryOfSearch = (value: string | undefined): CatalogEntry | null =>
	value === undefined ? null : Option.getOrNull(Arr.findFirst(CATALOG, (entry) => entry.id === value))

/** The `?integration=` the page shows: a known id, else the hub. */
export const integrationOfSearch = (value: string | undefined): IntegrationId | null =>
	entryOfSearch(value)?.id ?? null
