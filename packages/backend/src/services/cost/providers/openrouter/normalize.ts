// OpenRouter activity as `cost_daily` rows: one per day, model and serving provider.
import { Array as Arr, Record as Rec, String as Str } from "effect"
import type { ActivityItem } from "../../../org/openrouter-api"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"

/** FOCUS `ServiceCategory` of every OpenRouter charge. */
const SERVICE_CATEGORY = "AI and Machine Learning"

const dayOf = (item: ActivityItem): string => Str.slice(0, 10)(item.date)

const tokensOf = (item: ActivityItem): number => (item.prompt_tokens ?? 0) + (item.completion_tokens ?? 0)

/**
 * The window's days of an activity answer, summed over a model's endpoints at one provider. A row
 * OpenRouter billed nothing for is left out: free models and requests paid for with the account's
 * own provider key. Days from `openDay` on can still change: OpenRouter may not have finished
 * counting a day that ended hours ago.
 */
export const toCostRows = (
	items: ReadonlyArray<ActivityItem>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): ReadonlyArray<CostPullRow> => {
	const billed = Arr.filter(items, (item) => {
		const day = dayOf(item)
		return day >= window.startDay && day <= window.endDay && item.usage !== 0
	})
	// NUL cannot be in a day, a model slug or a provider name, so the key keeps the three apart.
	const groups = Arr.groupBy(billed, (item) =>
		Arr.join([dayOf(item), item.model, item.provider_name ?? ""], "\u0000"),
	)
	return Arr.map(Rec.values(groups), (group): CostPullRow => {
		const first = Arr.headNonEmpty(group)
		const day = dayOf(first)
		const usd = Arr.reduce(group, 0, (sum, item) => sum + item.usage)
		return {
			day,
			accountId,
			cloudService: first.model,
			serviceCategory: SERVICE_CATEGORY,
			usageType: first.provider_name ?? "",
			region: "global",
			resourceId: "",
			resourceType: "",
			serviceName: "",
			chargeCategory: "usage",
			basis: "billed",
			currency: "USD",
			billedCost: usd,
			effectiveCost: usd,
			listCost: usd,
			consumedQuantity: Arr.reduce(group, 0, (sum, item) => sum + tokensOf(item)),
			consumedUnit: "tokens",
			tags: {},
			estimated: day >= openDay,
		}
	})
}
