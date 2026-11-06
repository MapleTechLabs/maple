import { describe, expect, it } from "vitest"
import renderer from "../foldkit-island/server"
import { defaultValues, estimateMaple, estimateVendor, formatCurrency } from "../lib/vendor-pricing"
import { initModel, Message, PricingCalculator, update } from "./PricingCalculator"
import { PricingComparisonCalculator } from "./PricingComparisonCalculator"

describe("pricing calculator island", () => {
	it("server-renders the totals for the vendor's reference workload", async () => {
		const values = defaultValues("grafana")
		const { html } = await renderer.renderToStaticMarkup(PricingCalculator, { competitor: "grafana", compact: true })
		expect(html).toContain(formatCurrency(estimateMaple("grafana", values).total))
		expect(html).toContain(formatCurrency(estimateVendor("grafana", values).total))
		expect(html).not.toContain("Adjust your usage")
	})

	it("is claimed by the renderer, unlike other components", async () => {
		expect(await renderer.check(PricingComparisonCalculator)).toBe(true)
		expect(await renderer.check(() => null)).toBe(false)
	})

	it("rejects props that name no vendor", async () => {
		await expect(renderer.renderToStaticMarkup(PricingCalculator, { competitor: "acme" })).rejects.toMatchObject({ _tag: "SchemaError" })
	})

	it("reports a slider once it settles, not on every tick", () => {
		const first = update(initModel("datadog", false), Message.ChangedSlider({ key: "hosts", value: 40 }))
		const second = update(first.model, Message.ChangedSlider({ key: "hosts", value: 45 }))
		expect(second.model.values.hosts).toBe(45)
		const settled = (version: number) =>
			update(second.model, Message.SettledSlider({ version, competitor: "datadog", key: "hosts", value: 45 }))
		expect(settled(first.model.settleVersion).commands ?? []).toHaveLength(0)
		expect(settled(second.model.settleVersion).commands ?? []).toHaveLength(1)
	})

	it("re-seeds the sliders with the new vendor's defaults on a switch", () => {
		const moved = update(initModel("datadog", false), Message.ChangedSlider({ key: "hosts", value: 40 }))
		const switched = update(moved.model, Message.SelectedCompetitor({ competitor: "dash0" }))
		expect(switched.model.competitor).toBe("dash0")
		expect(switched.model.values).toEqual(defaultValues("dash0"))
	})
})
