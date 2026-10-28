// Every tile on /integrations, grouped by what it connects. Each entry points at a
// shipping doc or landing page: this is an inventory of what exists, not a roadmap.
//
// Same rules as `page-registry.ts`: messages are stored uncalled (`Msg`), and nothing
// here imports `.astro`, so the `.md` twin and any island can read it. Hints that are
// only proper nouns (frameworks, libraries) stay literal in every locale; prose hints
// are messages.
import * as m from "../paraglide/messages.js"
import { AGENT_FRAMEWORK_GUIDES, AGENT_GATEWAY_GUIDES, AGENT_GUIDE_LANGUAGES } from "./agent-tracing-guides"
import type { AgentGuide } from "./agent-tracing-guides"
import type { BrandMarkId } from "./brand-marks"
import type { LanguageId } from "./docs-languages"

type Msg = () => string

export type HubIcon = { lang: LanguageId } | { mark: BrandMarkId } | { logo: "hazel" }

export interface HubTile {
	name: string | Msg
	hint: string | Msg
	/** Site path. Locale-prefixed at render only when `localized` (docs are English-only). */
	href: string
	localized?: boolean
	icon: HubIcon
	/** Extra search terms, never shown: what people type for this tile. */
	keywords?: string
}

/** `PixelIcon` glyphs the rail uses, spelled out so this module stays free of `.astro`. */
type RailIcon = "brackets-curly-dots" | "sparkle-2" | "cloud" | "stack-perspective-2" | "bell" | "laptop"

export interface HubCategory {
	/** Anchor id and rail key. */
	id: string
	icon: RailIcon
	title: Msg
	lede: Msg
	tiles: readonly HubTile[]
}

/** Resolves a literal-or-message field at render, in the active locale. */
export const text = (value: string | Msg): string => (typeof value === "string" ? value : value())

export const tileHref = (locale: string, tile: HubTile): string =>
	tile.localized && locale !== "en" ? `/${locale}${tile.href}` : tile.href

const doc = (path: string) => `/docs/${path}`

const languages: HubTile[] = [
	{ name: "Effect", hint: "Node, Bun, Deno, Workers", href: doc("sdks/effect"), icon: { lang: "effect" } },
	{
		name: "Node.js",
		keywords: "javascript typescript",
		hint: "Express, Fastify, pg",
		href: "/integrations/nodejs",
		localized: true,
		icon: { lang: "node" },
	},
	{
		name: "Next.js",
		keywords: "react vercel javascript typescript",
		hint: "App Router, Pages Router, Edge",
		href: "/integrations/nextjs",
		localized: true,
		icon: { lang: "nextjs" },
	},
	{
		name: "Python",
		hint: "FastAPI, Django, Flask",
		href: "/integrations/python",
		localized: true,
		icon: { lang: "python" },
	},
	{
		name: "Go",
		hint: "net/http, gRPC, database/sql",
		href: doc("guides/instrumentation-go"),
		icon: { lang: "go" },
	},
	{
		name: "Rust",
		hint: "tracing, Axum, reqwest",
		href: doc("guides/instrumentation-rust"),
		icon: { lang: "rust" },
	},
	{
		name: "Java",
		keywords: "jvm",
		hint: "Spring Boot, JDBC",
		href: doc("guides/instrumentation-java"),
		icon: { lang: "java" },
	},
	{
		name: "Kotlin",
		keywords: "jvm",
		hint: "Ktor, Spring Boot",
		href: doc("guides/instrumentation-kotlin"),
		icon: { lang: "kotlin" },
	},
	{
		name: "C# / .NET",
		keywords: "csharp dotnet",
		hint: "ASP.NET Core, HttpClient",
		href: doc("guides/instrumentation-csharp"),
		icon: { lang: "csharp" },
	},
	{
		name: "Laravel",
		keywords: "php",
		hint: "PHP, Eloquent",
		href: doc("guides/instrumentation-laravel"),
		icon: { lang: "laravel" },
	},
	{
		name: "Cloudflare Workers",
		hint: m.intg_hint_workers,
		href: doc("guides/instrumentation-cloudflare-workers"),
		icon: { mark: "cloudflare" },
	},
	{
		name: "Browser",
		keywords: "javascript react frontend web",
		hint: m.intg_hint_browser,
		href: doc("session-replay/browser-sdk"),
		icon: { mark: "javascript" },
	},
]

const LANGUAGE_LABELS = new Map<string, string>(AGENT_GUIDE_LANGUAGES.map((l) => [l.id, l.label]))

// The guide's languages are the hint: literal names, so ja and ko read the same tokens.
const agentTile = (g: AgentGuide): HubTile => ({
	name: g.name,
	hint:
		g.languages[0] === "other"
			? "OpenTelemetry GenAI"
			: g.languages.map((id) => LANGUAGE_LABELS.get(id) ?? id).join(", "),
	href: doc(`agent-tracing/${g.slug}`),
	icon: g.icon,
})

const cloud: HubTile[] = [
	{
		name: "AWS",
		keywords: "amazon cloudwatch ec2 lambda",
		hint: m.intg_hint_aws,
		href: doc("integrations/aws"),
		icon: { mark: "aws" },
	},
	{
		name: "Google Cloud",
		keywords: "gcp gke cloud run",
		hint: m.intg_hint_gcp,
		href: doc("integrations/gcp"),
		icon: { mark: "googlecloud" },
	},
	{
		name: "Cloudflare",
		hint: m.intg_hint_cloudflare,
		href: doc("integrations/cloudflare"),
		icon: { mark: "cloudflare" },
	},
	{
		name: "Railway",
		hint: m.intg_hint_railway,
		href: doc("integrations/railway"),
		icon: { mark: "railway" },
	},
	{
		name: "Kubernetes",
		keywords: "k8s helm eks gke",
		hint: m.intg_hint_kubernetes,
		href: doc("infrastructure/kubernetes"),
		icon: { mark: "kubernetes" },
	},
	{
		name: "Docker",
		hint: m.intg_hint_docker,
		href: doc("infrastructure/docker"),
		icon: { mark: "docker" },
	},
	{
		name: "Hosts",
		keywords: "linux vm server hostmetrics",
		hint: m.intg_hint_hosts,
		href: doc("infrastructure/hosts"),
		icon: { mark: "opentelemetry" },
	},
	{
		name: "Prometheus",
		hint: m.intg_hint_prometheus,
		href: doc("integrations/prometheus"),
		icon: { mark: "prometheus" },
	},
]

const data: HubTile[] = [
	{
		name: "PlanetScale",
		keywords: "postgres mysql vitess database",
		hint: m.intg_hint_planetscale,
		href: doc("integrations/planetscale"),
		icon: { mark: "planetscale" },
	},
	{
		name: "Supabase",
		keywords: "postgres database",
		hint: m.intg_hint_supabase,
		href: doc("integrations/supabase"),
		icon: { mark: "supabase" },
	},
	{
		name: "WarpStream",
		keywords: "kafka",
		hint: m.intg_hint_warpstream,
		href: doc("integrations/warpstream"),
		icon: { mark: "warpstream" },
	},
]

const destinations = doc("alerting/notification-destinations")

const alerts: HubTile[] = [
	{ name: "Slack", hint: m.intg_hint_slack, href: doc("integrations/slack"), icon: { mark: "slack" } },
	{
		name: "Discord",
		hint: m.intg_hint_discord,
		href: doc("integrations/discord"),
		icon: { mark: "discord" },
	},
	{
		name: "PagerDuty",
		keywords: "on-call oncall incident",
		hint: m.intg_hint_pagerduty,
		href: `${destinations}#pagerduty`,
		icon: { mark: "pagerduty" },
	},
	{
		name: "Telegram",
		hint: m.intg_hint_telegram,
		href: `${destinations}#telegram`,
		icon: { mark: "telegram" },
	},
	{
		name: m.stack_chip_email,
		hint: m.intg_hint_email,
		href: `${destinations}#email`,
		icon: { mark: "email" },
	},
	{
		name: "Webhooks",
		keywords: "http webhook",
		hint: m.intg_hint_webhooks,
		href: doc("reference/webhooks"),
		icon: { mark: "webhooks" },
	},
	{ name: "Hazel", hint: m.intg_hint_hazel, href: `${destinations}#hazel`, icon: { logo: "hazel" } },
]

const code: HubTile[] = [
	{ name: "GitHub", hint: m.intg_hint_github, href: doc("integrations/github"), icon: { mark: "github" } },
	{
		name: "Claude Code",
		keywords: "anthropic agent",
		hint: m.intg_hint_mcp_client,
		href: doc("reference/mcp"),
		icon: { mark: "claude" },
	},
	{ name: "Cursor", hint: m.intg_hint_mcp_client, href: doc("reference/mcp"), icon: { mark: "cursor" } },
	{ name: "MCP", hint: m.intg_hint_mcp, href: doc("reference/mcp"), icon: { mark: "mcp" } },
	{ name: "Alchemy", hint: m.intg_hint_alchemy, href: doc("iac/alchemy"), icon: { mark: "alchemy" } },
]

export const HUB_CATEGORIES: readonly HubCategory[] = [
	{
		id: "languages",
		icon: "brackets-curly-dots",
		title: m.intg_cat_languages_title,
		lede: m.intg_cat_languages_lede,
		tiles: languages,
	},
	{
		id: "agents",
		icon: "sparkle-2",
		title: m.intg_cat_agents_title,
		lede: m.intg_cat_agents_lede,
		tiles: [...AGENT_FRAMEWORK_GUIDES, ...AGENT_GATEWAY_GUIDES].map(agentTile),
	},
	{ id: "cloud", icon: "cloud", title: m.intg_cat_cloud_title, lede: m.intg_cat_cloud_lede, tiles: cloud },
	{
		id: "databases",
		icon: "stack-perspective-2",
		title: m.intg_cat_data_title,
		lede: m.intg_cat_data_lede,
		tiles: data,
	},
	{
		id: "alerts",
		icon: "bell",
		title: m.intg_cat_alerts_title,
		lede: m.intg_cat_alerts_lede,
		tiles: alerts,
	},
	{ id: "code", icon: "laptop", title: m.intg_cat_code_title, lede: m.intg_cat_code_lede, tiles: code },
]

export const HUB_TILE_COUNT = HUB_CATEGORIES.reduce((n, c) => n + c.tiles.length, 0)
