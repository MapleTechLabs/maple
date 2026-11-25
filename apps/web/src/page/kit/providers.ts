import { Array as Arr } from "effect"
import { DATA_SOURCE_KINDS, type DataSourceKind } from "@maple/domain/data-sources"
import type { IconName } from "@maple/views/ui/icon"
import { docsUrl } from "./docs"
import type { IntegrationBrand } from "./integration-empty"

// The integration providers: each one's name, mark, accent, catalog copy, docs and infra page.
// The catalog, the sidebar, the infra overview, Sources and the provider pages read them.

export type ProviderId =
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
	| "fleet"

/** The hub section a provider lists under. */
export type IntegrationCategory = "infrastructure" | "code" | "analytics" | "notifications" | "security"

export interface Provider {
	readonly id: ProviderId
	readonly name: string
	/** The catalog row's one-line pitch. */
	readonly description: string
	readonly category: IntegrationCategory
	/** Badged "New" in the catalog. */
	readonly isNew?: boolean
	readonly icon: IconName
	/** A monochrome twin for the dimmed backer plates (multicolour marks). */
	readonly backerIcon?: IconName
	readonly accent: string
	/** Monochrome marks: the glyph tints by class and the wash goes neutral. */
	readonly iconClassName?: string
	readonly docsUrl?: string
	/** The provider's `/infra` page, for the ones with one. */
	readonly infraHref?: string
}

export const PROVIDERS = {
	cloudflare: {
		id: "cloudflare",
		name: "Cloudflare",
		description: "Connect your Cloudflare account via OAuth to collect zone and Workers analytics.",
		category: "infrastructure",
		icon: "CloudflareBrandIcon",
		backerIcon: "CloudflareMonoIcon",
		accent: "#F38020",
		docsUrl: docsUrl("cloudflare"),
		infraHref: "/infra/cloudflare",
	},
	prometheus: {
		id: "prometheus",
		name: "Prometheus",
		description: "Scrape any Prometheus-compatible endpoint on a schedule. No collector required.",
		category: "infrastructure",
		icon: "PrometheusIcon",
		accent: "#E6522C",
		docsUrl: docsUrl("prometheus"),
	},
	planetscale: {
		id: "planetscale",
		name: "PlanetScale",
		description:
			"Authorize your organization with one click. Maple tracks every database branch automatically.",
		category: "infrastructure",
		icon: "PlanetScaleIcon",
		accent: "oklch(0.62 0.02 270)",
		docsUrl: docsUrl("planetscale"),
		infraHref: "/infra/planetscale",
	},
	gcp: {
		id: "gcp",
		name: "Google Cloud",
		description: "Logs, metrics and resources from a project, folder or organization.",
		category: "infrastructure",
		isNew: true,
		icon: "GoogleCloudIcon",
		backerIcon: "GoogleCloudMonoIcon",
		accent: "#4285F4",
		docsUrl: docsUrl("gcp"),
		infraHref: "/infra/gcp",
	},
	aws: {
		id: "aws",
		name: "AWS",
		description: "Connect an AWS account through a read-only role you deploy with CloudFormation.",
		category: "infrastructure",
		isNew: true,
		icon: "AwsIcon",
		accent: "#FF9900",
		iconClassName: "text-foreground",
		docsUrl: docsUrl("aws"),
		infraHref: "/infra/aws",
	},
	railway: {
		id: "railway",
		name: "Railway",
		description:
			"Paste a Railway token to collect CPU, memory, network and disk metrics for every service.",
		category: "infrastructure",
		isNew: true,
		icon: "RailwayIcon",
		accent: "#0B0D0E",
		iconClassName: "text-foreground",
		docsUrl: docsUrl("railway"),
		infraHref: "/infra/railway",
	},
	vercel: {
		id: "vercel",
		name: "Vercel",
		description: "Paste a Vercel token to drain request logs, traces and AI Gateway usage from a team.",
		category: "infrastructure",
		isNew: true,
		icon: "VercelIcon",
		accent: "#000000",
		iconClassName: "text-foreground",
		docsUrl: docsUrl("vercel"),
		infraHref: "/infra/vercel",
	},
	supabase: {
		id: "supabase",
		name: "Supabase",
		description:
			"Authorize your Supabase organization to collect CPU, memory, disk and Postgres metrics for every project.",
		category: "infrastructure",
		isNew: true,
		icon: "SupabaseIcon",
		accent: "#3FCF8E",
		docsUrl: docsUrl("supabase"),
		infraHref: "/infra/supabase",
	},
	warpstream: {
		id: "warpstream",
		name: "WarpStream",
		description: "Monitor WarpStream clusters via agent metrics or the hosted Prometheus endpoint.",
		category: "infrastructure",
		icon: "WarpStreamIcon",
		accent: "#E52344",
		docsUrl: docsUrl("warpstream"),
	},
	linear: {
		id: "linear",
		name: "Linear",
		description:
			"Open one Linear issue per alert rule, then comment as it fires again, changes severity or resolves.",
		category: "notifications",
		icon: "LinearIcon",
		accent: "#5E6AD5",
	},
	github: {
		id: "github",
		name: "GitHub",
		description: "Install the Maple GitHub App to sync repositories and commits from your org.",
		category: "code",
		icon: "GithubIcon",
		accent: "#181717",
		iconClassName: "text-foreground",
		docsUrl: docsUrl("github"),
	},
	"google-search-console": {
		id: "google-search-console",
		name: "Google Search Console",
		description: "Import the search queries, pages and positions that bring people to your sites.",
		category: "analytics",
		isNew: true,
		icon: "GoogleIcon",
		accent: "#4285F4",
	},
	fleet: {
		id: "fleet",
		name: "Fleet",
		description:
			"Connect a Fleet server with a read-only API token: its admin activity goes to the audit log, its failing policies and vulnerable software to Security, Devices.",
		category: "security",
		isNew: true,
		icon: "FleetIcon",
		backerIcon: "FleetMonoIcon",
		accent: "#192147",
	},
} as const satisfies { readonly [K in ProviderId]: Provider & { readonly id: K } }

/** The provider's mark for an icon plate or an empty state. */
export const providerBrand = (id: ProviderId): IntegrationBrand => PROVIDERS[id]

/** A data source kind: its name, logo and the hub's "Query in place" card. */
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
