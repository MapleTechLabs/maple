import { describe, expect, it } from "vitest"
import { highlightCode, highlightTokens, resolveLang } from "./highlight"

describe("resolveLang", () => {
	it("takes a language name or alias, a file name's extension, else plain text", () => {
		expect(resolveLang(" Shell ")).toBe("shell")
		expect(resolveLang("maple-aws.tf")).toBe("tf")
		expect(resolveLang("config.yaml")).toBe("yaml")
		expect(resolveLang("docker run")).toBe("text")
		expect(resolveLang("")).toBe("text")
	})
})

describe("highlightCode", () => {
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
		highlightCode("x".repeat(100_000), "ts")
		expect(highlightCode("const a = 1", "ts")).toBe(first)
	})
})

describe("highlightTokens", () => {
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
