// Morph usage as `cost_daily` rows: one per day and model.
import { Array as Arr } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import type { DayUsage, ModelUsage } from "./morph-usage-api"

/** The `cloud_service` of every Morph row; the model is the usage type. */
export const MORPH_SERVICE = "morph"
const CATEGORY = "AI and Machine Learning"

/**
 * The window's days, a row per model Morph billed. Models the plan covers cost 0 and are left out.
 * Days from `openDay` on are still being counted.
 */
export const toCostRows = (
	days: ReadonlyArray<DayUsage>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): ReadonlyArray<CostPullRow> => {
	const inWindow = Arr.filter(days, (day) => day.date >= window.startDay && day.date <= window.endDay)
	return Arr.flatMap(inWindow, (day: DayUsage) =>
		Arr.map(
			Arr.filter(day.models, (model) => model.spend !== 0),
			(model: ModelUsage): CostPullRow => ({
				day: day.date,
				accountId,
				cloudService: MORPH_SERVICE,
				serviceCategory: CATEGORY,
				usageType: model.model,
				region: "global",
				resourceId: "",
				resourceType: "",
				serviceName: "",
				// Morph can restate a day lower (a refund): the drop is a correction, not usage.
				chargeCategory: model.spend < 0 ? "adjustment" : "usage",
				basis: "billed",
				currency: "USD",
				billedCost: model.spend,
				effectiveCost: model.spend,
				listCost: model.spend,
				consumedQuantity: model.inputTokens + model.outputTokens,
				consumedUnit: "tokens",
				tags: {},
				estimated: day.date >= openDay,
			}),
		),
	)
}
