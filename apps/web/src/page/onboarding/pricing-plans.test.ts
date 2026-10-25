import { CatalogPlan, CatalogPlanItem, CatalogPlanItemPrice } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import { getFeatureRows } from "./pricing-plans"

const item = (featureId: string, included: number) =>
	new CatalogPlanItem({
		featureId,
		included,
		price: new CatalogPlanItemPrice({ amount: 1, billingUnits: 1, interval: "month" }),
	})

describe("getFeatureRows", () => {
	it("lists only the priced features, so metering-only plan items never reach a card", () => {
		const plan = new CatalogPlan({
			id: "startup",
			name: "Startup",
			price: { amount: 39, interval: "month" },
			items: [
				item("logs", 100),
				item("ai_input_tokens", 0),
				item("some_future_feature", 5),
				item("ai_credits", 10),
			],
		})

		expect(getFeatureRows(plan).map((row) => row.featureId)).toEqual(["logs", "ai_credits"])
	})
})
