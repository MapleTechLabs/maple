import { describe, expect, it } from "vitest"
import renderer from "../../foldkit-island/server"
import { LiveLogsStream } from "./LiveLogsStream"

describe("Logs stream island", () => {
	it("renders every example log with its severity before the browser mounts", async () => {
		const { html } = await renderer.renderToStaticMarkup(LiveLogsStream, {})

		expect(html).toContain("card declined: insufficient_funds")
		expect(html).toContain("POST /api/feedback 201")
		expect(html).toContain("ERROR")
		expect(html).toContain("16 logs")
	})
})
