import { type ChatConnectorManifest, chatConnectorManifests } from "@maple/chat-platform/manifests"
import { ChatConnectorId } from "@maple/primitives"
import { Option, Schema, String as Str, Array as Arr } from "effect"
import type { IconName } from "@maple/views/ui/icon"
import { type IntegrationCategory, type Provider, type ProviderId, PROVIDERS } from "../kit/providers"

export type ChatIntegrationId = `chat-${string}`
export type IntegrationId = ProviderId | ChatIntegrationId

/** A generated icon, or a chat connector's manifest mark (rendered from its path data). */
export type EntryIcon =
	| Readonly<{ _tag: "Named"; name: IconName }>
	| Readonly<{ _tag: "Manifest"; icon: ChatConnectorManifest["icon"] }>

/** What a connection does for Maple: the hub's row chips and filters. */
export const CAPABILITIES = ["telemetry", "query", "alerts", "analytics", "security"] as const
export type Capability = (typeof CAPABILITIES)[number]

export const HubFilter = Schema.Literals(["all", ...CAPABILITIES, "attention"])
export type HubFilter = typeof HubFilter.Type

/** The row chip's word, then the filter chip's. */
export const CAPABILITY_LABEL = {
	telemetry: { chip: "Telemetry", filter: "Telemetry" },
	query: { chip: "Query", filter: "Query" },
	alerts: { chip: "Alerts", filter: "Alerts & chat" },
	analytics: { chip: "Analytics", filter: "Analytics" },
	security: { chip: "Security", filter: "Security" },
} as const satisfies Record<Capability, { readonly chip: string; readonly filter: string }>

export const capabilityOf = (category: IntegrationCategory): Capability =>
	category === "notifications"
		? "alerts"
		: category === "analytics"
			? "analytics"
			: category === "security"
				? "security"
				: "telemetry"

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
	{ id: "security", label: "Security & audit" },
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

const providerEntry = (provider: Provider): CatalogEntry => ({
	id: provider.id,
	name: provider.name,
	description: provider.description,
	icon: named(provider.icon),
	accent: provider.accent,
	category: provider.category,
	iconClassName: provider.iconClassName,
	docsUrl: provider.docsUrl,
	isNew: provider.isNew,
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
	"vercel",
	"warpstream",
	"linear",
	"github",
	"google-search-console",
	"fleet",
]

/** A provider's entry; every provider has one. */
export const catalogEntry = (id: ProviderId): CatalogEntry => providerEntry(PROVIDERS[id])

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
