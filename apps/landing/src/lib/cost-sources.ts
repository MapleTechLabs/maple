import type { IconName } from "@maple/views/ui/icon"

// The cost sources the feature page's tiles and its markdown twin state. Every string is a product
// fact, so none goes through Paraglide; `history` follows `COST_SYNC_PROFILES` in the backend.

export interface CostSource {
	readonly name: string
	readonly icon: IconName
	readonly iconClassName?: string
	/** What one source is: an account, a team, an organization. */
	readonly reads: string
	readonly splitsBy: string
	readonly addedWith: string
	readonly history: string
	/** The integration's setup doc, where one exists. */
	readonly docs?: string
}

export const COST_SOURCES: ReadonlyArray<CostSource> = [
	{
		name: "AWS",
		icon: "AwsIcon",
		iconClassName: "text-foreground",
		reads: "account",
		splitsBy: "service · region · account",
		addedWith: "the AWS connection's role",
		history: "13 months",
		docs: "/docs/integrations/aws",
	},
	{
		name: "Vercel",
		icon: "VercelIcon",
		iconClassName: "text-foreground",
		reads: "team",
		splitsBy: "product · project",
		addedWith: "the Vercel connection",
		history: "11 months",
		docs: "/docs/integrations/vercel",
	},
	{
		name: "Cloudflare",
		icon: "CloudflareBrandIcon",
		reads: "account",
		splitsBy: "product",
		addedWith: "API token · Billing: Read",
		history: "11 months",
	},
	{
		name: "PlanetScale",
		icon: "PlanetScaleIcon",
		iconClassName: "text-foreground",
		reads: "organization",
		splitsBy: "database · branch",
		addedWith: "the PlanetScale connection",
		history: "12 months",
		docs: "/docs/integrations/planetscale",
	},
	{
		name: "GitHub",
		icon: "GithubIcon",
		iconClassName: "text-foreground",
		reads: "organization",
		splitsBy: "product · repository",
		addedWith: "the GitHub App",
		history: "3 months",
		docs: "/docs/integrations/github",
	},
	{
		name: "Anthropic",
		icon: "AnthropicIcon",
		iconClassName: "text-foreground",
		reads: "organization",
		splitsBy: "model · workspace",
		addedWith: "Admin API key",
		history: "3 months",
	},
	{
		name: "OpenAI",
		icon: "OpenAiIcon",
		iconClassName: "text-foreground",
		reads: "organization",
		splitsBy: "model · project",
		addedWith: "Admin API key",
		history: "3 months",
	},
	{
		name: "OpenRouter",
		icon: "OpenRouterIcon",
		iconClassName: "text-foreground",
		reads: "account",
		splitsBy: "model",
		addedWith: "management key",
		history: "4 weeks",
	},
]

/** A source Maple does not read yet. Named so a reader knows it is coming, with no date and no detail promised. */
export interface PlannedCostSource {
	readonly name: string
	readonly icon: IconName
	readonly iconClassName?: string
	/** What kind of bill it is. */
	readonly kind: string
}

export const PLANNED_COST_SOURCES: ReadonlyArray<PlannedCostSource> = [
	{ name: "Google Cloud", icon: "GoogleCloudIcon", kind: "cloud" },
	{ name: "Microsoft Azure", icon: "AzureIcon", kind: "cloud" },
	{ name: "Railway", icon: "RailwayIcon", iconClassName: "text-foreground", kind: "platform" },
	{ name: "Supabase", icon: "SupabaseIcon", kind: "database" },
	{ name: "Google Gemini", icon: "GeminiIcon", kind: "AI API" },
	{ name: "Kubernetes", icon: "KubernetesIcon", kind: "cluster" },
	{ name: "ClickHouse Cloud", icon: "ClickhouseIcon", kind: "database" },
	{ name: "MongoDB Atlas", icon: "MongodbIcon", kind: "database" },
]
