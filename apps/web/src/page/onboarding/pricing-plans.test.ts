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

	it("quotes an overage rate in whole cents and leaves sub-cent rates alone", () => {
		const metered = (featureId: string, secondaryText: string) =>
			new CatalogPlanItem({ featureId, included: 100, display: { secondaryText } })
		const plan = new CatalogPlan({
			id: "startup",
			name: "Startup",
			items: [
				metered("logs", "then $0.3 per 1 logs"),
				metered("browser_sessions", "then $0.002 per browser session"),
			],
		})

		expect(getFeatureRows(plan).map((row) => row.detail)).toEqual([
			"then $0.30 per GB",
			"then $0.002 per browser session",
		])
	})
})
