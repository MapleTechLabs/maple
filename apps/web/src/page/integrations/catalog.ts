import { type ChatConnectorManifest, chatConnectorManifests } from "@maple/chat-platform/manifests"
import { ChatConnectorId } from "@maple/domain/primitives"
import { docsUrl } from "../../lib/docs"
import { Array, Option, Schema } from "effect"
import type { IconName } from "../../ui/icon"
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
	| "supabase"
	| "warpstream"
	| "hazel"
	| "linear"
	| "github"
	| ChatIntegrationId

export const GITHUB_ACCENT = "#181717"
export const HAZEL_ACCENT = "#F46F0F"
export const LINEAR_ACCENT = "#5E6AD5"
export const CLOUDFLARE_ACCENT = "#F38020"
export const RAILWAY_ACCENT = "#0B0D0E"
export const GCP_ACCENT = "#4285F4"
export const AWS_ACCENT = "#FF9900"

/** A generated icon, or a chat connector's manifest mark (rendered from its path data). */
export type EntryIcon =
	| Readonly<{ _tag: "Named"; name: IconName }>
	| Readonly<{ _tag: "Manifest"; icon: ChatConnectorManifest["icon"] }>

export type IntegrationCategory = "infrastructure" | "code" | "notifications"

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
]

const named = (name: IconName): EntryIcon => ({ _tag: "Named", name })

export const chatIntegrationId = (connector: string): ChatIntegrationId => `chat-${connector}`

const decodeConnectorId = Schema.decodeUnknownOption(ChatConnectorId)

/** The connector behind a chat catalog id, or `null` for every other entry. */
export const chatConnectorOf = (id: IntegrationId): ChatConnectorId | null =>
	id.startsWith("chat-") ? Option.getOrNull(decodeConnectorId(id.slice("chat-".length))) : null

export const chatManifestOf = (connector: string): ChatConnectorManifest | undefined =>
	chatConnectorManifests.find((manifest) => manifest.id === connector)

const CHAT_ENTRIES: ReadonlyArray<CatalogEntry> = chatConnectorManifests.map((manifest) => ({
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
		id: "warpstream",
		category: "infrastructure",
		name: "WarpStream",
		description: "Monitor WarpStream clusters via agent metrics or the hosted Prometheus endpoint.",
		icon: named("WarpStreamIcon"),
		accent: "#E52344",
		docsUrl: docsUrl("warpstream"),
	},
	{
		id: "hazel",
		category: "notifications",
		name: "Hazel",
		description:
			"Forward Maple alerts into a Hazel workspace via OAuth. Pick destinations per notification.",
		icon: named("HazelIcon"),
		accent: HAZEL_ACCENT,
		docsUrl: "https://hazel.sh/docs/integrations/maple",
	},
	{
		id: "linear",
		category: "notifications",
		name: "Linear",
		description:
			"Open a Linear issue for each critical incident, then comment as it escalates and resolves.",
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
	...CHAT_ENTRIES,
]

/** What `/integrations` lists: chat and alert connectors. Data integrations live under Sources. */
export const HUB_CATALOG: ReadonlyArray<CatalogEntry> = CATALOG.filter(
	(entry) => entry.category === "notifications",
)

export const catalogEntry = (id: IntegrationId): CatalogEntry =>
	Option.getOrElse(
		Array.findFirst(CATALOG, (entry) => entry.id === id),
		() => CLOUDFLARE_ENTRY,
	)

/** Whether a URL value names a catalog entry (the OAuth callbacks append `?integration=`). */
export const isIntegrationId = (value: string): value is IntegrationId =>
	CATALOG.some((entry) => entry.id === value)

/** The `?integration=` the page shows: a known id, else the hub. */
export const integrationOfSearch = (value: string | undefined): IntegrationId | null =>
	value !== undefined && isIntegrationId(value) ? value : null
