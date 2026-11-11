import { Array as Arr } from "effect"
import { DATA_SOURCE_KINDS, type DataSourceKind } from "@maple/domain/data-sources"
import type { IconName } from "@maple/views/ui/icon"
import { docsUrl } from "./docs"
import type { IntegrationBrand } from "./integration-empty"

// The integration providers: each one's name, mark, accent, docs and infra page, read by the
// integrations catalog, the sidebar, the infra overview, Sources and the provider pages.

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

export interface Provider {
	readonly id: ProviderId
	readonly name: string
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
		icon: "CloudflareBrandIcon",
		backerIcon: "CloudflareMonoIcon",
		accent: "#F38020",
		docsUrl: docsUrl("cloudflare"),
		infraHref: "/infra/cloudflare",
	},
	prometheus: {
		id: "prometheus",
		name: "Prometheus",
		icon: "PrometheusIcon",
		accent: "#E6522C",
		docsUrl: docsUrl("prometheus"),
	},
	planetscale: {
		id: "planetscale",
		name: "PlanetScale",
		icon: "PlanetScaleIcon",
		accent: "oklch(0.62 0.02 270)",
		docsUrl: docsUrl("planetscale"),
		infraHref: "/infra/planetscale",
	},
	gcp: {
		id: "gcp",
		name: "Google Cloud",
		icon: "GoogleCloudIcon",
		backerIcon: "GoogleCloudMonoIcon",
		accent: "#4285F4",
		docsUrl: docsUrl("gcp"),
		infraHref: "/infra/gcp",
	},
	aws: {
		id: "aws",
		name: "AWS",
		icon: "AwsIcon",
		accent: "#FF9900",
		iconClassName: "text-foreground",
		docsUrl: docsUrl("aws"),
		infraHref: "/infra/aws",
	},
	railway: {
		id: "railway",
		name: "Railway",
		icon: "RailwayIcon",
		accent: "#0B0D0E",
		iconClassName: "text-foreground",
		docsUrl: docsUrl("railway"),
		infraHref: "/infra/railway",
	},
	vercel: {
		id: "vercel",
		name: "Vercel",
		icon: "VercelIcon",
		accent: "#000000",
		iconClassName: "text-foreground",
		docsUrl: docsUrl("vercel"),
		infraHref: "/infra/vercel",
	},
	supabase: {
		id: "supabase",
		name: "Supabase",
		icon: "SupabaseIcon",
		accent: "#3FCF8E",
		docsUrl: docsUrl("supabase"),
		infraHref: "/infra/supabase",
	},
	warpstream: {
		id: "warpstream",
		name: "WarpStream",
		icon: "WarpStreamIcon",
		accent: "#E52344",
		docsUrl: docsUrl("warpstream"),
	},
	linear: { id: "linear", name: "Linear", icon: "LinearIcon", accent: "#5E6AD5" },
	github: {
		id: "github",
		name: "GitHub",
		icon: "GithubIcon",
		accent: "#181717",
		iconClassName: "text-foreground",
		docsUrl: docsUrl("github"),
	},
	"google-search-console": {
		id: "google-search-console",
		name: "Google Search Console",
		icon: "GoogleIcon",
		accent: "#4285F4",
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
