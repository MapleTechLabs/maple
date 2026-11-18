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
})
