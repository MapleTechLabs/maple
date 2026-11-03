import { describe, expect, it } from "vitest"

import { parseErrorBody, splitErrorText, tokenizeJson } from "../error-body"
import { Array as Arr } from "effect"

describe("parseErrorBody", () => {
	it("pretty-prints JSON objects", () => {
		const body = parseErrorBody('{"code":500,"message":"boom"}')
		expect(body.format).toBe("json")
		expect(body.full).toBe('{\n  "code": 500,\n  "message": "boom"\n}')
	})

	it("treats malformed and scalar JSON as text", () => {
		expect(parseErrorBody('{"code":500').format).toBe("text")
		expect(parseErrorBody('"just a string"').format).toBe("text")
	})

	it("leaves plain text — and its line breaks — untouched", () => {
		const body = parseErrorBody("Timed out\n  at fetch()")
		expect(body.format).toBe("text")
		expect(body.full).toBe("Timed out\n  at fetch()")
	})

	it("drops leading and trailing blank lines, LF or CRLF", () => {
		expect(parseErrorBody("\r\n\nPlain text\r\n").full).toBe("Plain text")
		expect(parseErrorBody("\n  indented\n\n").full).toBe("  indented")
	})
})

describe("tokenizeJson", () => {
	it("distinguishes keys from string values", () => {
		const tokens = tokenizeJson('{"message": "boom"}')
		expect(
			Arr.map(
				Arr.filter(tokens, (t) => t.type === "key"),
				(t) => t.text,
			),
		).toEqual(['"message"'])
		expect(
			Arr.map(
				Arr.filter(tokens, (t) => t.type === "string"),
				(t) => t.text,
			),
		).toEqual(['"boom"'])
	})

	it("tags numbers and literals, and round-trips the source", () => {
		const source = '{\n  "retries": -1.5e3,\n  "ok": false,\n  "cause": null\n}'
		const tokens = tokenizeJson(source)
		expect(
			Arr.join(
				Arr.map(tokens, (t) => t.text),
				"",
			),
		).toBe(source)
		expect(
			Arr.map(
				Arr.filter(tokens, (t) => t.type === "number"),
				(t) => t.text,
			),
		).toEqual(["-1.5e3"])
		expect(
			Arr.map(
				Arr.filter(tokens, (t) => t.type === "keyword"),
				(t) => t.text,
			),
		).toEqual(["false", "null"])
	})

	it("does not mistake a colon inside a string for a key separator", () => {
		const tokens = tokenizeJson('{"url": "https://x.dev"}')
		expect(
			Arr.map(
				Arr.filter(tokens, (t) => t.type === "key"),
				(t) => t.text,
			),
		).toEqual(['"url"'])
	})
})

describe("splitErrorText", () => {
	it("marks stack frames after the first line", () => {
		const lines = splitErrorText("Cannot read x\n    at handler (a.ts:1)\n    at run (b.ts:2)")
		expect(Arr.map(lines, (l) => l.frame)).toEqual([false, true, true])
	})

	it("keeps a multi-line message unframed", () => {
		expect(Arr.map(splitErrorText("line one\nline two"), (l) => l.frame)).toEqual([false, false])
	})
})
