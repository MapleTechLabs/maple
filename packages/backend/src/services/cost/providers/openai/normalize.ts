// OpenAI's daily costs as `cost_daily` rows: one per day, model (or product) and line item, per
// project. The `openai/` service prefix is what the Cost page shows the OpenAI logo for.
import { DateTime, Option, Array as Arr, Record as Rec, Result, String as Str } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import type { CostBucket } from "./openai-costs-api"

const SERVICE_PREFIX = "openai/"
const UNATTRIBUTED = "unattributed"
const CATEGORY = "AI and Machine Learning"
// A model's line items read "<model>, <part>", as "gpt-4o-2024-08-06, input".
const PART_SEPARATOR = ", "

/** The service a line item belongs to: the model of "<model>, <part>", else the line item itself. */
export const serviceOf = (lineItem: string | null): string => {
	if (lineItem === null || lineItem === "") return `${SERVICE_PREFIX}${UNATTRIBUTED}`
	const cut = Option.getOrElse(Str.indexOf(PART_SEPARATOR)(lineItem), () => 0)
	return `${SERVICE_PREFIX}${cut > 0 ? Str.slice(0, cut)(lineItem) : lineItem}`
}

const dayOf = (unixSeconds: number): string =>
	DateTime.formatIsoDateUtc(DateTime.makeUnsafe(unixSeconds * 1000))

// NUL cannot be in a day, a name or an id, so the key keeps the parts apart.
const keyOf = (parts: ReadonlyArray<string>): string => Arr.join(parts, "\u0000")

const sum = <A>(items: ReadonlyArray<A>, of: (item: A) => number): number =>
	Arr.reduce(items, 0, (total, item) => total + of(item))

interface Charge {
	readonly day: string
	readonly lineItem: string | null
	readonly projectId: string | null
	readonly value: number
	readonly currency: string
	readonly quantity: number
	readonly unit: string
}

/**
 * The window's charges, merged per day, service, line item and project. A result without an amount
 * is not a charge. One with an amount that is not a finite number fails: it cannot be stored as cost.
 */
export const toCostRows = (
	buckets: ReadonlyArray<CostBucket>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): Result.Result<ReadonlyArray<CostPullRow>, string> => {
	const charges = Arr.flatMap(buckets, (bucket) => {
		const day = dayOf(bucket.start_time)
		if (day < window.startDay || day > window.endDay) return []
		return Arr.flatMap(bucket.results, (result): ReadonlyArray<Charge> => {
			const value = result.amount?.value
			if (value === undefined || value === null) return []
			return [
				{
					day,
					lineItem: result.line_item ?? null,
					projectId: result.project_id ?? null,
					value,
					currency: Str.toUpperCase(result.amount?.currency ?? "usd"),
					quantity: result.quantity ?? 0,
					unit: result.quantity_unit ?? "",
				},
			]
		})
	})
	const bad = Arr.findFirst(charges, (charge) => !Number.isFinite(charge.value))
	if (Option.isSome(bad)) {
		return Result.fail(`OpenAI reported an amount that is not a number on ${bad.value.day}`)
	}
	// A day's rows are replaced whole and read per key, so two rows of one key would count once.
	const groups = Arr.groupBy(charges, (charge) =>
		keyOf([charge.day, serviceOf(charge.lineItem), charge.lineItem ?? "", charge.projectId ?? ""]),
	)
	return Result.succeed(
		Arr.map(Rec.values(groups), (group): CostPullRow => {
			const first = Arr.headNonEmpty(group)
			const value = sum(group, (charge) => charge.value)
			return {
				day: first.day,
				accountId,
				cloudService: serviceOf(first.lineItem),
				serviceCategory: CATEGORY,
				usageType: first.lineItem ?? "",
				region: "global",
				resourceId: first.projectId ?? "",
				resourceType: first.projectId === null ? "" : "project",
				serviceName: "",
				chargeCategory: "usage",
				basis: "billed",
				currency: first.currency,
				billedCost: value,
				effectiveCost: value,
				listCost: value,
				// Only quantities in the row's own unit add up.
				consumedQuantity: sum(group, (charge) => (charge.unit === first.unit ? charge.quantity : 0)),
				consumedUnit: first.unit,
				tags: {},
				estimated: first.day >= openDay,
			}
		}),
	)
}
