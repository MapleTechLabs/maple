/**
 * Pure shaping of Cost Explorer answers into cost rows. No Effect services and no SDK import: the
 * shapes below are the parts of a `GetCostAndUsage` answer a pull reads.
 */
import { Array as Arr, Number as Num, Option, Order, Result, String as Str } from "effect"
import { timestampMs } from "@maple/backend/platform/time"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"

export interface CostExplorerMetric {
	readonly Amount?: string
	readonly Unit?: string
}

export interface CostExplorerGroup {
	readonly Keys?: ReadonlyArray<string>
	readonly Metrics?: Readonly<Record<string, CostExplorerMetric | undefined>>
}

export interface CostExplorerResult {
	readonly TimePeriod?: { readonly Start: string; readonly End: string }
	readonly Groups?: ReadonlyArray<CostExplorerGroup>
	readonly Estimated?: boolean
}

/** One group of one day with its amounts parsed. `key` is the second GroupBy key. */
export interface CostGroup {
	readonly day: string
	readonly estimated: boolean
	readonly service: string
	/** A region for `SERVICE` x `REGION`, a usage type for `SERVICE` x `USAGE_TYPE`. */
	readonly key: string
	readonly currency: string
	readonly billedCost: number
	readonly effectiveCost: number
	readonly quantity: number
	readonly unit: string
}

export interface CostExplorerPeriod {
	readonly Start: string
	/** Exclusive, as Cost Explorer reads it: the day after the window's last. */
	readonly End: string
	readonly days: number
}

const DAY_MS = 86_400_000

const dayOf = (ms: number) => Str.slice(0, 10)(new Date(ms).toISOString())

// The round trip refuses a day the calendar lacks, which parsing rolls into the next month.
const parseDay = (day: string): Option.Option<number> => {
	const ms = /^\d{4}-\d{2}-\d{2}$/u.test(day) ? timestampMs(`${day}T00:00:00Z`) : Number.NaN
	return Number.isFinite(ms) && dayOf(ms) === day ? Option.some(ms) : Option.none()
}

/** The window as a `TimePeriod`. None when a day is not a calendar day or the window is reversed. */
export const costExplorerPeriod = (window: CostPullWindow): Option.Option<CostExplorerPeriod> =>
	Option.flatMap(parseDay(window.startDay), (start) =>
		Option.flatMap(parseDay(window.endDay), (end) =>
			end < start
				? Option.none()
				: Option.some({
						Start: window.startDay,
						End: dayOf(end + DAY_MS),
						days: Math.round((end - start) / DAY_MS) + 1,
					}),
		),
	)

// `Number("")` is 0: an empty amount is a broken answer, not a free one.
const amountOf = (metric: CostExplorerMetric | undefined, name: string): Result.Result<number, string> => {
	const raw = metric?.Amount
	const value = raw === undefined || Str.trim(raw) === "" ? Number.NaN : Number(raw)
	return Number.isFinite(value) ? Result.succeed(value) : Result.fail(`${name} is not a number`)
}

const groupOf = (result: CostExplorerResult, group: CostExplorerGroup): Result.Result<CostGroup, string> => {
	const day = result.TimePeriod?.Start
	const [service, key] = group.Keys ?? []
	if (day === undefined || service === undefined || key === undefined) {
		return Result.fail("a group has no day or fewer than two keys")
	}
	const unblended = group.Metrics?.["UnblendedCost"]
	const usage = group.Metrics?.["UsageQuantity"]
	// Cost Explorer answers `N/A` for a group that sums usage of different units.
	const unit = usage?.Unit === undefined || usage.Unit === "N/A" ? "" : usage.Unit
	return Result.map(
		Result.all({
			billedCost: amountOf(unblended, "UnblendedCost"),
			effectiveCost: amountOf(group.Metrics?.["AmortizedCost"], "AmortizedCost"),
			quantity: unit === "" ? Result.succeed(0) : amountOf(usage, "UsageQuantity"),
		}),
		(amounts) => ({
			day,
			estimated: result.Estimated === true,
			service,
			key,
			currency: unblended?.Unit ?? "",
			...amounts,
			unit,
		}),
	)
}

/** Every group of every day, or why the answer cannot be read. */
export const parseGroups = (
	results: ReadonlyArray<CostExplorerResult>,
): Result.Result<ReadonlyArray<CostGroup>, string> =>
	Result.all(
		Arr.flatMap(results, (result) => Arr.map(result.Groups ?? [], (group) => groupOf(result, group))),
	)

// Amortized cost counts too: a commitment's day can bill nothing and still cost something.
const magnitude = (group: CostGroup) => Math.max(Math.abs(group.billedCost), Math.abs(group.effectiveCost))

/** A region is worth its own usage-type pull at this share of the window's cost... */
const DETAIL_MIN_SHARE = 0.001
/** ...and this much per day of the window. Most listed regions hold fractions of a cent. */
const DETAIL_MIN_PER_DAY = 0.01
/** Each detailed region is at least one more billed request per pull: the largest ones only. */
export const MAX_DETAILED_REGIONS = 12

/**
 * The regions of a `SERVICE` x `REGION` answer that get a pull by usage type, sorted: the largest
 * `MAX_DETAILED_REGIONS` of those worth one. Credits and refunds count by their absolute value.
 */
export const detailedRegions = (groups: ReadonlyArray<CostGroup>, days: number): ReadonlyArray<string> => {
	const total = Num.sumAll(Arr.map(groups, magnitude))
	const regions = Arr.dedupe(Arr.map(groups, (group) => group.key))
	const sized = Arr.map(regions, (region) => ({
		region,
		cost: Num.sumAll(
			Arr.map(
				Arr.filter(groups, (group) => group.key === region),
				magnitude,
			),
		),
	}))
	const worthIt = Arr.filter(
		sized,
		// A charge with no region keeps its service-level rows: an empty value is not a filter.
		({ region, cost }) =>
			region !== "" && cost >= total * DETAIL_MIN_SHARE && cost >= days * DETAIL_MIN_PER_DAY,
	)
	const largest = Arr.take(
		Arr.sort(
			worthIt,
			Order.mapInput(Order.flip(Order.Number), (entry: { readonly cost: number }) => entry.cost),
		),
		MAX_DETAILED_REGIONS,
	)
	return Arr.sort(
		Arr.map(largest, (entry) => entry.region),
		Order.String,
	)
}

/** A cent, or a thousandth of the region's cost: float noise passes, a missing charge does not. */
const reconcileTolerance = (cost: number) => Math.max(0.01, Math.abs(cost) * 0.001)

/**
 * Whether a region's pull by usage type holds the same money as its rows in the `SERVICE` x
 * `REGION` answer. When it does not (the region filter missed a charge), the region keeps its
 * service-level rows, so the day still sums to what Cost Explorer reports.
 */
export const usageReconciles = (
	usage: ReadonlyArray<CostGroup>,
	byRegion: ReadonlyArray<CostGroup>,
	region: string,
): boolean => {
	const ofRegion = Arr.filter(byRegion, (group) => group.key === region)
	const sum = (groups: ReadonlyArray<CostGroup>, pick: (group: CostGroup) => number) =>
		Num.sumAll(Arr.map(groups, pick))
	const billed = sum(ofRegion, (group) => group.billedCost)
	const effective = sum(ofRegion, (group) => group.effectiveCost)
	return (
		Math.abs(sum(usage, (group) => group.billedCost) - billed) <= reconcileTolerance(billed) &&
		Math.abs(sum(usage, (group) => group.effectiveCost) - effective) <= reconcileTolerance(effective)
	)
}

const CATEGORY_KEYWORDS: ReadonlyArray<readonly [category: string, keywords: ReadonlyArray<string>]> = [
	["AI and Machine Learning", ["bedrock", "sagemaker", "rekognition", "comprehend", "textract"]],
	["Analytics", ["athena", "glue", "kinesis", "redshift", "opensearch", "quicksight", "mapreduce"]],
	["Databases", ["relational database", "dynamodb", "elasticache", "documentdb", "neptune", "memorydb"]],
	["Storage", ["simple storage", "s3", "elastic file system", "glacier", "backup", "fsx"]],
	["Networking", ["virtual private cloud", "cloudfront", "route 53", "load balancing", "api gateway"]],
	["Security", ["key management", "secrets manager", "waf", "guardduty", "shield", "cognito"]],
	["Management and Governance", ["cloudwatch", "cloudtrail", "aws config", "systems manager"]],
	["Developer Tools", ["codebuild", "codepipeline", "codecommit", "codedeploy", "x-ray"]],
	["Compute", ["elastic compute cloud", "ec2", "lambda", "container", "kubernetes", "lightsail"]],
]

/** The FOCUS-style category of an AWS service name, by keyword. "Other" when none matches. */
export const serviceCategoryOf = (cloudService: string): string => {
	const name = Str.toLowerCase(cloudService)
	return Option.match(
		Arr.findFirst(CATEGORY_KEYWORDS, ([, keywords]) =>
			Arr.some(keywords, (keyword) => Str.includes(keyword)(name)),
		),
		{ onNone: () => "Other", onSome: ([category]) => category },
	)
}

const rowOf = (
	group: CostGroup,
	accountId: string,
	place: { readonly region: string; readonly usageType: string },
	usage: { readonly quantity: number; readonly unit: string },
): CostPullRow => ({
	day: group.day,
	accountId,
	cloudService: group.service,
	serviceCategory: serviceCategoryOf(group.service),
	usageType: place.usageType,
	region: place.region,
	resourceId: "",
	resourceType: "",
	serviceName: "",
	// Cost Explorer nets credits and refunds into the service rows: only tax stands apart.
	chargeCategory: group.service === "Tax" ? "tax" : "usage",
	basis: "billed",
	currency: group.currency,
	billedCost: group.billedCost,
	effectiveCost: group.effectiveCost,
	listCost: 0,
	consumedQuantity: usage.quantity,
	consumedUnit: usage.unit,
	tags: {},
	estimated: group.estimated,
})

const costs = (group: CostGroup) => group.billedCost !== 0 || group.effectiveCost !== 0

/**
 * Service-level rows of a `SERVICE` x `REGION` answer, for the regions without a pull by usage
 * type. They carry no quantity: a service's usage mixes units.
 */
export const serviceRows = (
	groups: ReadonlyArray<CostGroup>,
	accountId: string,
	detailed: ReadonlyArray<string>,
): ReadonlyArray<CostPullRow> =>
	Arr.map(
		Arr.filter(groups, (group) => costs(group) && !Arr.contains(detailed, group.key)),
		(group) => rowOf(group, accountId, { region: group.key, usageType: "" }, { quantity: 0, unit: "" }),
	)

/** Rows of one region's `SERVICE` x `USAGE_TYPE` answer. */
export const usageRows = (
	groups: ReadonlyArray<CostGroup>,
	accountId: string,
	region: string,
): ReadonlyArray<CostPullRow> =>
	Arr.map(Arr.filter(groups, costs), (group) =>
		rowOf(
			group,
			accountId,
			{ region, usageType: group.key },
			{ quantity: group.quantity, unit: group.unit },
		),
	)
