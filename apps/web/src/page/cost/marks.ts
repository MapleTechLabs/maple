import { CostProvider } from "@maple/domain/cost"
import type { CostSourceSummary } from "@maple/domain/http"
import type { SeriesMark } from "@maple/views/charts/timeseries-legend"
import { modelSlugIcon } from "@maple/views/lib/ai-vendor"
import type { IconName } from "@maple/views/ui/icon"
import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"
import type { CostGroupBy } from "./derive"
import { COST_PROVIDERS } from "./providers"

// What a key of the grouping is at a glance: the logo of whatever bills it, or its kind's glyph.

export type KeyMark = SeriesMark

const decodeProvider = Schema.decodeUnknownOption(CostProvider)

const providerMark = (provider: CostProvider): KeyMark => {
	const entry = COST_PROVIDERS[provider]
	return entry.iconClassName === undefined
		? { icon: entry.icon }
		: { icon: entry.icon, className: entry.iconClassName }
}

/** OpenRouter names a model `vendor/model`; an AWS service name never has a slash. */
const isModelSlug = (key: string): boolean => Str.includes("/")(key)

/** How AWS names its services: "Amazon Simple Storage Service", "AWS Lambda", "EC2 - Other". */
const isAwsServiceName = (key: string): boolean => /^(Amazon|AWS|EC2|Elastic|CloudWatch)/u.test(key)

/** A Vercel region is an airport code and a digit: `iad1`, `fra1`. */
const isVercelRegionId = (key: string): boolean => /^[a-z]{3}\d$/u.test(key)

/** The org's providers that bill services and regions of their own. OpenRouter's are model slugs. */
const platformsOf = (sources: ReadonlyArray<CostSourceSummary>): ReadonlyArray<CostProvider> =>
	Arr.dedupe(
		Arr.filter(
			Arr.map(sources, (source) => source.provider),
			(provider) => provider !== "openrouter",
		),
	)

/**
 * Whose service or region a key is, when its name does not say: the org's only platform, AWS
 * while no source is known, and nobody's when two platforms could each have billed it.
 */
const onlyPlatform = (sources: ReadonlyArray<CostSourceSummary>): CostProvider | undefined => {
	const platforms = platformsOf(sources)
	return platforms.length > 1 ? undefined : (platforms[0] ?? "aws")
}

const markOf = (provider: CostProvider | undefined, fallback: IconName): KeyMark =>
	provider === undefined ? glyph(fallback) : providerMark(provider)

/** An AWS account id is twelve digits; an OpenRouter one is its user or org id. */
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
			return markOf(isAwsServiceName(key) ? "aws" : onlyPlatform(sources), "CubeIcon")
		case "service_category":
			return glyph(isCategory(key) ? CATEGORY_ICONS[key] : "CubeIcon")
		case "region":
			if (key === "global") return glyph("GlobeIcon")
			if (isAwsRegion(key)) return providerMark("aws")
			if (isVercelRegionId(key) && Arr.contains(platformsOf(sources), "vercel")) {
				return providerMark("vercel")
			}
			return markOf(onlyPlatform(sources), "GlobeIcon")
		// A resource is what a charge is for (a Vercel project): its provider is in the row, not the key.
		case "resource":
			return glyph("FolderIcon")
		case "account": {
			const provider = accountProvider(key, sources)
			return provider === undefined ? glyph("IdBadgeIcon") : providerMark(provider)
		}
	}
}

/**
 * An account by what reads it: an AWS one by its id, a Vercel one by its team's slug (its id is a
 * team id, kept stable through a rename), an OpenRouter one by name alone while it is the org's
 * only one (its id means nothing to a reader). Unknown ids read as they are.
 */
export const accountLabel = (key: string, sources: ReadonlyArray<CostSourceSummary>): string => {
	const provider = accountProvider(key, sources)
	if (provider === undefined) return key
	const name = COST_PROVIDERS[provider].name
	if (provider === "aws") return `${name} ${key}`
	const sameProvider = Arr.filter(sources, (source) => source.provider === provider)
	const accountName = Arr.findFirst(sameProvider, (source) => source.accountId === key).pipe(
		Option.flatMapNullishOr((source) => source.accountName),
		Option.getOrUndefined,
	)
	if (accountName !== undefined) return `${name} ${accountName}`
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
 * What the name leaves out: where an AWS region is, the id behind an OpenRouter account's name.
 * Null when the name says it all.
 */
export const keyDetail = (
	dimension: CostGroupBy,
	key: string,
	sources: ReadonlyArray<CostSourceSummary>,
): string | null => {
	if (dimension === "region") return isAwsRegion(key) ? AWS_REGIONS[key] : null
	if (dimension === "account") {
		return accountProvider(key, sources) === "openrouter" ? key : null
	}
	return null
}
