import { Effect, String as Str } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { DISPLAY_MAX_CHARS } from "./display-text"
import { awaitHighlighter, highlightCode, highlightTokens } from "./highlight"

describe("before the highlighter loads", () => {
	it("renders the code as escaped plain text, coloured once loaded", async () => {
		const plain = highlightCode('{"a": "<b>"}', "json")
		expect(plain).toContain('{"a": "&lt;b&gt;"}')
		expect(plain).not.toContain("var(--sh-")
		await Effect.runPromise(awaitHighlighter)
		expect(highlightCode('{"a": "<b>"}', "json")).toContain(
			'<span style="color:var(--sh-property)">"a"</span>',
		)
	})
})

describe("language labels", () => {
	it("takes a language name or alias, a file name's extension, else plain text", async () => {
		await Effect.runPromise(awaitHighlighter)
		expect(highlightCode("# a", " Shell ")).toBe(highlightCode("# a", "shell"))
		expect(highlightCode("a: 1", "config.yaml")).toBe(highlightCode("a: 1", "yaml"))
		expect(highlightCode("docker run", "docker run")).toBe("docker run")
	})
})

describe("highlightCode", () => {
	beforeAll(() => Effect.runPromise(awaitHighlighter))

	it("comes back as escaped plain text past the display cap instead of a span per token", () => {
		const html = highlightCode(`{"a": "<b>&"}${Str.repeat(DISPLAY_MAX_CHARS)(" ")}`, "json")
		expect([Str.includes("<span")(html), Str.startsWith('{"a": "&lt;b&gt;&amp;"}')(html)]).toEqual([
			false,
			true,
		])
	})

	it("colours tokens with the palette variables and escapes the source", () => {
		const html = highlightCode('{"a": "<b>&", "n": 1, "ok": true}', "json")
		expect(html).toContain('<span style="color:var(--sh-property)">"a"</span>')
		expect(html).toContain('"&lt;b&gt;&amp;"')
		expect(html).toContain('<span style="color:var(--sh-class)">1</span>')
		expect(html).toContain('<span style="color:var(--sh-keyword)">true</span>')
		expect(html).not.toContain("<pre")
	})

	it("reads a shell comment as a comment and a URL as text", () => {
		const html = highlightCode("curl https://ingest.maple.dev/v1 # send", "bash")
		expect(html).toContain('<span style="color:var(--sh-comment)"># send</span>')
		expect(html).not.toContain('<span style="color:var(--sh-comment)">//ingest')
	})

	it("keeps output valid across calls, the wasm buffer being reused", () => {
		const first = highlightCode("const a = 1", "ts")
		highlightCode(Str.repeat(100_000)("x"), "ts")
		expect(highlightCode("const a = 1", "ts")).toBe(first)
	})
})

describe("highlightTokens", () => {
	beforeAll(() => Effect.runPromise(awaitHighlighter))

	it("splits lines and names each token's slot", () => {
		expect(highlightTokens("let x\n\n// hi", "js")).toEqual([
			[
				{ content: "let ", slot: "keyword" },
				{ content: "x", slot: "foreground" },
			],
			[],
			[{ content: "// hi", slot: "comment" }],
		])
	})
})
