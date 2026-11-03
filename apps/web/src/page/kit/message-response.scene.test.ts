import { Effect } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { altText, expect, given, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { messageResponse, parseMarkdownTexts, type ParsedMarkdown } from "./message-response"

// Markdown images in model output render as links, so nothing is fetched until the reader opens one.

const parse = (text: string) =>
	Effect.runPromise(parseMarkdownTexts([text])).then(([parsed]) => parsed ?? { document: null })

const config = {
	update: (model: ParsedMarkdown, _message: never) => ({ model }),
	view: (model: ParsedMarkdown, h: HtmlBuilder<never>) => messageResponse(h, model.document, ""),
}

describe("markdown images", () => {
	test("a remote image renders as a link to its URL instead of an img", async () => {
		const parsed = await parse("See ![the latency chart](https://example.test/chart.png) here.")
		scene(
			config,
			given(parsed),
			expect(altText("the latency chart")).toBeAbsent(),
			expect(role("link", { name: "the latency chart" })).toHaveAttr(
				"href",
				"https://example.test/chart.png",
			),
		)
	})

	test("a linked image is the outer link's label, with no link inside it", async () => {
		const parsed = await parse(
			"[![the latency chart](https://example.test/chart.png)](https://example.test/dash)",
		)
		scene(
			config,
			given(parsed),
			expect(altText("the latency chart")).toBeAbsent(),
			expect(role("link", { name: "the latency chart" })).toHaveAttr(
				"href",
				"https://example.test/dash",
			),
			expect(role("link", { name: "https://example.test/chart.png" })).toBeAbsent(),
		)
	})

	test("an image wrapped in emphasis inside a link is still only a label", async () => {
		const parsed = await parse(
			"[**![the latency chart](https://example.test/chart.png)**](https://example.test/dash)",
		)
		scene(
			config,
			given(parsed),
			expect(role("link", { name: "the latency chart" })).toHaveAttr(
				"href",
				"https://example.test/dash",
			),
			expect(role("link", { name: "https://example.test/chart.png" })).toBeAbsent(),
		)
	})

	test("an image without alt text links by its URL", async () => {
		const parsed = await parse("![](https://example.test/a.png)")
		scene(config, given(parsed), expect(role("link", { name: "https://example.test/a.png" })).toExist())
	})
})
