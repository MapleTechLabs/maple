import { CostProvider } from "@maple/domain/cost"
import type { CostSourceSummary } from "@maple/domain/http"
import type { SeriesMark } from "@maple/views/charts/timeseries-legend"
import { modelSlugIcon } from "@maple/views/lib/ai-vendor"
import type { IconName } from "@maple/views/ui/icon"
import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"
import type { CostGroupBy } from "./derive"
import { COST_PROVIDERS, type CostProviderEntry } from "./providers"

// What a key of the grouping is at a glance: the logo of whatever bills it, or its kind's glyph.

export type KeyMark = SeriesMark

const decodeProvider = Schema.decodeUnknownOption(CostProvider)

const providerMark = (provider: CostProvider): KeyMark => {
	const entry: CostProviderEntry = COST_PROVIDERS[provider]
	return entry.iconClassName === undefined
		? { icon: entry.icon }
		: { icon: entry.icon, className: entry.iconClassName }
}

/** OpenRouter names a model `vendor/model`; an AWS service name never has a slash. */
const isModelSlug = (key: string): boolean => Str.includes("/")(key)

/** An AWS account id is twelve digits; an OpenRouter one is its user or org id, a Cloudflare one 32 hex digits. */
const isAwsAccountId = (key: string): boolean => /^\d{12}$/u.test(key)

/** The provider whose source reads the account, from the org's sources, then by the id's shape. */
export const accountProvider = (
	key: string,
	sources: ReadonlyArray<CostSourceSummary>,
): CostProvider | undefined =>
	Option.getOrUndefined(
		Option.orElse(
			Option.map(
				Arr.findFirst(sources, (source) => source.accountId === key),
				(source) => source.provider,
			),
			() => (isAwsAccountId(key) ? Option.some<CostProvider>("aws") : Option.none()),
		),
	)

/** What Cloudflare bills by: its product families, and the plan fees Maple files under one name. */
const CLOUDFLARE_SERVICES: ReadonlySet<string> = new Set([
	"Workers",
	"Durable Objects",
	"Containers",
	"Queues",
	"R2",
	"D1",
	"Workers KV",
	"Workers AI",
	"Email",
	"Subscriptions",
])

/** GitHub's products as the cost rows name them. */
const GITHUB_PRODUCTS: ReadonlySet<string> = new Set([
	"Actions",
	"Copilot",
	"Packages",
	"Codespaces",
	"Git LFS",
])

/** AWS names nearly every service "Amazon ..." or "AWS ..."; these are the common ones it does not. */
const AWS_SERVICES: ReadonlySet<string> = new Set(["EC2 - Other", "Elastic Load Balancing", "Tax"])

const isAwsService = (key: string): boolean => /^(Amazon|AWS)\b/u.test(key) || AWS_SERVICES.has(key)

/** The platforms the org reads whose services are products, not models. */
const platformsOf = (sources: ReadonlyArray<CostSourceSummary>): ReadonlyArray<CostProvider> =>
	Arr.dedupe(Arr.flatMap(sources, (source) => (source.provider === "openrouter" ? [] : [source.provider])))

/**
 * The provider that bills a service which is not a model: by its name where the name says it, else
 * the org's only platform. Undefined when several could bill it: no logo is better than a wrong one.
 */
const serviceProvider = (
	key: string,
	sources: ReadonlyArray<CostSourceSummary>,
): CostProvider | undefined => {
	if (GITHUB_PRODUCTS.has(key)) return "github"
	if (CLOUDFLARE_SERVICES.has(key)) return "cloudflare"
	if (isAwsService(key)) return "aws"
	const [only, ...others] = platformsOf(sources)
	return others.length === 0 ? only : undefined
}

/** An AWS region code: `eu-west-1`, `us-gov-east-1`. Every other provider bills as `global`. */
const isAwsRegionCode = (key: string): boolean => /^[a-z]{2}(-gov)?-[a-z]+-\d+$/u.test(key)

/** Whether a region key is AWS's: by its code, or because AWS is the org's one platform with regions. */
const isAwsRegionKey = (key: string, sources: ReadonlyArray<CostSourceSummary>): boolean =>
	isAwsRegionCode(key) || Arr.some(sources, (source) => source.provider === "aws")

const CATEGORY_ICONS = {
	"AI and Machine Learning": "SparkleIcon",
	Analytics: "ChartBarIcon",
	Databases: "DatabaseIcon",
	Storage: "BoxArchiveIcon",
	Networking: "NetworkNodesIcon",
	Security: "ShieldIcon",
	"Management and Governance": "GaugeIcon",
	"Developer Tools": "CodeIcon",
	Compute: "MicrochipIcon",
} as const satisfies Record<string, IconName>

const isCategory = (key: string): key is keyof typeof CATEGORY_ICONS =>
	Rec.has<string, IconName>(CATEGORY_ICONS, key)

const glyph = (name: IconName): KeyMark => ({ icon: name, className: "text-muted-foreground" })

/** The provider's logo, or the kind's glyph when no one provider is known to own the key. */
const markOf = (provider: CostProvider | undefined, fallback: IconName): KeyMark =>
	provider === undefined ? glyph(fallback) : providerMark(provider)

/** The mark beside a key in the table, the legend and the filter chips; null for an empty key. */
export const keyMark = (
	dimension: CostGroupBy,
	key: string,
	sources: ReadonlyArray<CostSourceSummary>,
): KeyMark | null => {
	if (key === "") return null
	switch (dimension) {
		case "provider":
			return Option.match(decodeProvider(key), { onNone: () => null, onSome: providerMark })
		case "cloud_service":
			if (isModelSlug(key)) return { icon: modelSlugIcon(key) }
			if (key === "AWS Lambda") return { icon: "AwsLambdaIcon" }
			return markOf(serviceProvider(key, sources), "CubeIcon")
		case "service_category":
			return glyph(isCategory(key) ? CATEGORY_ICONS[key] : "CubeIcon")
		case "region":
			return key !== "global" && isAwsRegionKey(key, sources) ? providerMark("aws") : glyph("GlobeIcon")
		case "account": {
			return markOf(accountProvider(key, sources), "IdBadgeIcon")
		}
	}
}

/** Whether a provider's account id tells a reader which account it is: an AWS number, a GitHub organization. */
const isNamedByAccount = (provider: CostProvider): boolean => provider === "aws" || provider === "github"

/**
 * An account by what reads it: an AWS one by its id, a GitHub one by its organization, an
 * OpenRouter or Cloudflare one by name alone while it is the org's only one (its id means nothing
 * to a reader). Unknown ids read as they are.
 */
export const accountLabel = (key: string, sources: ReadonlyArray<CostSourceSummary>): string => {
	const provider = accountProvider(key, sources)
	if (provider === undefined) return key
	const name = COST_PROVIDERS[provider].name
	if (isNamedByAccount(provider)) return `${name} ${key}`
	const sameProvider = Arr.filter(sources, (source) => source.provider === provider)
	return sameProvider.length <= 1 ? name : `${name} ${key}`
}

/** AWS region codes and where they are, as the AWS console names them. */
const AWS_REGIONS = {
	"us-east-1": "N. Virginia",
	"us-east-2": "Ohio",
	"us-west-1": "N. California",
	"us-west-2": "Oregon",
	"af-south-1": "Cape Town",
	"ap-east-1": "Hong Kong",
	"ap-south-1": "Mumbai",
	"ap-south-2": "Hyderabad",
	"ap-southeast-1": "Singapore",
	"ap-southeast-2": "Sydney",
	"ap-southeast-3": "Jakarta",
	"ap-southeast-4": "Melbourne",
	"ap-northeast-1": "Tokyo",
	"ap-northeast-2": "Seoul",
	"ap-northeast-3": "Osaka",
	"ca-central-1": "Canada Central",
	"ca-west-1": "Calgary",
	"eu-central-1": "Frankfurt",
	"eu-central-2": "Zurich",
	"eu-west-1": "Ireland",
	"eu-west-2": "London",
	"eu-west-3": "Paris",
	"eu-south-1": "Milan",
	"eu-south-2": "Spain",
	"eu-north-1": "Stockholm",
	"il-central-1": "Tel Aviv",
	"me-south-1": "Bahrain",
	"me-central-1": "UAE",
	"sa-east-1": "São Paulo",
	"us-gov-east-1": "GovCloud US-East",
	"us-gov-west-1": "GovCloud US-West",
} as const satisfies Record<string, string>

const isAwsRegion = (key: string): key is keyof typeof AWS_REGIONS =>
	Rec.has<string, string>(AWS_REGIONS, key)

/**
 * What the name leaves out: where an AWS region is, the id behind an account that reads by its
 * provider's name. Null when the name says it all.
 */
export const keyDetail = (
	dimension: CostGroupBy,
	key: string,
	sources: ReadonlyArray<CostSourceSummary>,
): string | null => {
	if (dimension === "region") return isAwsRegion(key) ? AWS_REGIONS[key] : null
	if (dimension === "account") {
		const provider = accountProvider(key, sources)
		return provider === undefined || isNamedByAccount(provider) ? null : key
	}
	return null
}
