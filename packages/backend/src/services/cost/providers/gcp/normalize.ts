// Cloud Billing export lines as `cost_daily` rows. Each line becomes its charge, and its credits
// (negative) a `credit` row of their own, so the net of a day is the sum of its rows.
import type { CostChargeCategory } from "@maple/domain/cost"
import { Array as Arr, Option, String as Str } from "effect"
import type { CostPullRow } from "../../CostProvider"
import type { GcpCostLine } from "./bigquery"

/** The export's `cost_type` as a FOCUS charge category. */
const chargeCategoryOf = (costType: string): CostChargeCategory => {
	switch (costType) {
		case "regular":
			return "usage"
		case "tax":
			return "tax"
		case "adjustment":
		case "rounding_error":
			return "adjustment"
		default:
			return "unknown"
	}
}

const CATEGORY_KEYWORDS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
	["Storage", ["cloud storage", "filestore", "persistent disk", "artifact registry"]],
	["Databases", ["cloud sql", "spanner", "bigtable", "firestore", "datastore", "memorystore", "alloydb"]],
	["Analytics", ["bigquery", "dataflow", "dataproc", "pub/sub", "composer", "looker"]],
	["AI and Machine Learning", ["vertex ai", "gemini", "generative", "vision", "speech", "translate"]],
	["Networking", ["networking", "cloud cdn", "cloud dns", "load balancing", "vpc", "cloud nat", "armor"]],
	["Management and Governance", ["logging", "monitoring", "trace", "cloud build", "secret manager", "kms"]],
	["Compute", ["compute engine", "cloud run", "kubernetes", "cloud functions", "app engine", "batch"]],
]

/** The FOCUS-style category of a Google Cloud service name, by keyword. "Other" when none matches. */
export const serviceCategoryOf = (service: string): string => {
	const name = Str.toLowerCase(service)
	return Option.match(
		Arr.findFirst(CATEGORY_KEYWORDS, ([, keywords]) =>
			Arr.some(keywords, (keyword) => Str.includes(keyword)(name)),
		),
		{ onNone: () => "Other", onSome: ([category]) => category },
	)
}

/**
 * What kind of resource a full resource name points at: the collection its id sits in, e.g.
 * `instances` in `//compute.googleapis.com/projects/p/zones/z/instances/123`.
 */
export const resourceTypeOf = (resource: string): string => {
	if (resource === "") return ""
	const segments = Str.split("/")(resource)
	return segments.length >= 2 ? (segments[segments.length - 2] ?? "") : ""
}

const toNumber = (value: string): number => (value === "" ? 0 : Number(value))

// NUL cannot be in any of the fields, so the key keeps them apart.
const keyOf = (row: CostPullRow): string =>
	Arr.join(
		[
			row.day,
			row.accountId,
			row.cloudService,
			row.usageType,
			row.region,
			row.resourceId,
			row.chargeCategory,
			row.currency,
			row.consumedUnit,
		],
		"\u0000",
	)

const sum = (a: CostPullRow, b: CostPullRow): CostPullRow => ({
	...a,
	billedCost: a.billedCost + b.billedCost,
	effectiveCost: a.effectiveCost + b.effectiveCost,
	listCost: a.listCost + b.listCost,
	consumedQuantity: a.consumedQuantity + b.consumedQuantity,
})

/**
 * The query's lines as rows. A day from `openDay` on is still restated by Google, until the month's
 * invoice closes. Credit rows of one SKU from several cost types fold into one.
 */
export const rowsOf = (lines: ReadonlyArray<GcpCostLine>, openDay: string): ReadonlyArray<CostPullRow> => {
	const summed = Arr.reduce(
		Arr.flatMap(lines, (line) => linesRows(line, openDay)),
		new Map<string, CostPullRow>(),
		(rows, row) => {
			const key = keyOf(row)
			const existing = rows.get(key)
			return rows.set(key, existing === undefined ? row : sum(existing, row))
		},
	)
	return Arr.fromIterable(summed.values())
}

/** One line's charge, and its credits as a row of their own when it has any. */
const linesRows = (line: GcpCostLine, openDay: string): ReadonlyArray<CostPullRow> => {
	const base = {
		day: line.day,
		accountId: line.project,
		cloudService: line.service,
		serviceCategory: serviceCategoryOf(line.service),
		usageType: line.sku,
		region: line.region === "" ? "global" : line.region,
		resourceId: line.resource,
		resourceType: resourceTypeOf(line.resource),
		serviceName: "",
		basis: "billed",
		currency: line.currency === "" ? "USD" : line.currency,
		tags: {},
		estimated: line.day >= openDay,
	} as const
	const credits = toNumber(line.credits)
	const charge: CostPullRow = {
		...base,
		chargeCategory: chargeCategoryOf(line.costType),
		billedCost: toNumber(line.cost),
		effectiveCost: toNumber(line.cost),
		listCost: toNumber(line.listCost),
		consumedQuantity: toNumber(line.quantity),
		consumedUnit: line.unit,
	}
	return credits === 0
		? [charge]
		: [
				charge,
				{
					...base,
					chargeCategory: "credit",
					billedCost: credits,
					effectiveCost: credits,
					listCost: 0,
					consumedQuantity: 0,
					consumedUnit: "",
				},
			]
}
