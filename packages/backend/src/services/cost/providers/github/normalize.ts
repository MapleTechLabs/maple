// A GitHub billing usage report as `cost_daily` rows: one per day, product, SKU and repository.
import { Array as Arr, DateTime, Option, Record as Rec, Schema, String as Str } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"

/** A day alone, or a UTC timestamp to the second, with or without a fraction. */
const USAGE_DATE = /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z)?$/

/**
 * Whether the text is a day that exists, alone or as a UTC timestamp. A day that does not exist
 * (`2026-11-31`) parses as nothing or as a later day, so it does not come back as itself.
 */
const isUsageDate = (value: string): boolean => {
	if (!USAGE_DATE.test(value)) return false
	const day = Str.slice(0, 10)(value)
	return Option.exists(
		DateTime.make(`${day}T00:00:00Z`),
		(parsed) => DateTime.formatIsoDateUtc(parsed) === day,
	)
}

/**
 * One usage line of the report. `date` is a timestamp, not always at midnight: the day is its
 * first ten characters. `quantity` is a float, whatever the spec says. Seat products can leave
 * the repository out.
 */
export const UsageItem = Schema.Struct({
	date: Schema.String.check(
		Schema.makeFilter((value: string) => isUsageDate(value), {
			description: "Expected a calendar day (YYYY-MM-DD) or a UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)",
		}),
	),
	product: Schema.String,
	sku: Schema.String,
	quantity: Schema.Number,
	unitType: Schema.String,
	grossAmount: Schema.Number,
	netAmount: Schema.Number,
	repositoryName: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type UsageItem = typeof UsageItem.Type

/** A month with no usage answers an empty list. An answer without the list is not a report. */
export const UsageReport = Schema.Struct({ usageItems: Schema.Array(UsageItem) })

/** FOCUS `ServiceCategory` of every GitHub charge. */
const SERVICE_CATEGORY = "Developer Tools"

/** GitHub names products in lower case; these read as GitHub writes them. */
const PRODUCT_NAMES = new Map([
	["actions", "Actions"],
	["copilot", "Copilot"],
	["packages", "Packages"],
	["codespaces", "Codespaces"],
	["git_lfs", "Git LFS"],
])

const productName = (product: string): string => PRODUCT_NAMES.get(product) ?? Str.capitalize(product)

const dayOf = (item: UsageItem): string => Str.slice(0, 10)(item.date)

const repositoryOf = (item: UsageItem): string => item.repositoryName ?? ""

const sum = (items: ReadonlyArray<UsageItem>, of: (item: UsageItem) => number): number =>
	Arr.reduce(items, 0, (total, item) => total + of(item))

/**
 * The window's days of a report, summed per day, product, SKU and repository. Billed is the net
 * amount and list the gross one, so usage a plan allowance or a public repository made free keeps
 * its list cost. A line with neither is left out. Days from `openDay` on can still change.
 */
export const toCostRows = (
	items: ReadonlyArray<UsageItem>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): ReadonlyArray<CostPullRow> => {
	const inWindow = Arr.filter(items, (item) => {
		const day = dayOf(item)
		return day >= window.startDay && day <= window.endDay
	})
	// By the name a row is written with: two spellings of a product must not make two rows of one
	// key. NUL cannot be in a day, a product, a SKU or a repository name, so it keeps them apart.
	const groups = Arr.groupBy(inWindow, (item) =>
		Arr.join([dayOf(item), productName(item.product), item.sku, repositoryOf(item)], "\u0000"),
	)
	return Arr.flatMap(Rec.values(groups), (group): ReadonlyArray<CostPullRow> => {
		const first = Arr.headNonEmpty(group)
		const day = dayOf(first)
		const repository = repositoryOf(first)
		const net = sum(group, (item) => item.netAmount)
		const gross = sum(group, (item) => item.grossAmount)
		if (net === 0 && gross === 0) return []
		return [
			{
				day,
				accountId,
				cloudService: productName(first.product),
				serviceCategory: SERVICE_CATEGORY,
				usageType: first.sku,
				region: "global",
				resourceId: repository,
				resourceType: repository === "" ? "" : "repository",
				serviceName: "",
				chargeCategory: "usage",
				basis: "billed",
				currency: "USD",
				billedCost: net,
				effectiveCost: net,
				listCost: gross,
				consumedQuantity: sum(group, (item) => item.quantity),
				consumedUnit: first.unitType,
				tags: {},
				estimated: day >= openDay,
			},
		]
	})
}
