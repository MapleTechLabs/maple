import { describe, expect, it } from "vitest"
import renderer from "../../foldkit-island/server"
import { LiveTraceWaterfall } from "./LiveTraceWaterfall"

describe("Trace waterfall island", () => {
	it("renders the checkout and its nested spans before the browser mounts", async () => {
		const { html } = await renderer.renderToStaticMarkup(LiveTraceWaterfall, {})

		expect(html).toContain("POST /checkout")
		expect(html).toContain("chargeCard")
		expect(html).toContain("sendConfirmation")
	})

	it("renders an integration page's example trace instead of the checkout", async () => {
		const { html } = await renderer.renderToStaticMarkup(LiveTraceWaterfall, { demo: "go" })

		expect(html).toContain("GET /api/orders/{id}")
		expect(html).toContain("inventory.v1.Inventory/Reserve")
		expect(html).not.toContain("POST /checkout")
	})

	it("falls back to the checkout for a runtime without an example", async () => {
		const { html } = await renderer.renderToStaticMarkup(LiveTraceWaterfall, { demo: "nodejs" })

		expect(html).toContain("POST /checkout")
	})
})
