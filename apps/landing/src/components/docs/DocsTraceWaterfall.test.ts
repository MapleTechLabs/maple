import { describe, expect, it } from "vitest"
import renderer from "../../foldkit-island/server"
import { DocsTraceWaterfall } from "./DocsTraceWaterfall"

describe("Docs trace waterfall", () => {
	it("renders the checkout and its nested spans before the browser mounts", async () => {
		const { html } = await renderer.renderToStaticMarkup(DocsTraceWaterfall, {})

		expect(html).toContain("POST /checkout")
		expect(html).toContain("chargeCard")
		expect(html).toContain("sendConfirmation")
	})
})
