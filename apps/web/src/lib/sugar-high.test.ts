import { describe, expect, test } from "vitest"
import { HIGHLIGHT_MAX_CHARS, highlightCode } from "./sugar-high"

describe("highlightCode", () => {
	test("small code is tokenized into spans", () => {
		expect(highlightCode('{"a": 1}')).toContain("<span")
	})

	test("code past the limit comes back as escaped plain text", () => {
		const html = highlightCode(`<b>&</b>${"x".repeat(HIGHLIGHT_MAX_CHARS)}`)
		expect([html.includes("<span"), html.startsWith("&lt;b&gt;&amp;&lt;/b&gt;")]).toEqual([false, true])
	})
})
