/**
 * Bounding tool output at creation.
 *
 * The properties that matter: both limits bite, the text stays valid UTF-8 across the cut, the model
 * is told what it lost, and output that already fits is returned untouched — because every result on
 * every tool call goes through here.
 */
import { assert, describe, it } from "vitest"
import { doc, renderToolDoc, type ToolDoc } from "../lib/tool-doc"
import {
	countLines,
	formatSize,
	MAX_TOOL_OUTPUT_BYTES,
	MAX_TOOL_OUTPUT_LINES,
	MAX_TOOL_TEXT_CHARS,
	renderToolDocWithinBudget,
	truncateToolOutput,
	utf8ByteLength,
} from "./tool-output"

describe("countLines", () => {
	it("counts the way a file does", () => {
		assert.equal(countLines(""), 0)
		assert.equal(countLines("a"), 1)
		// A trailing newline terminates the last line rather than opening an empty one.
		assert.equal(countLines("a\n"), 1)
		assert.equal(countLines("a\nb"), 2)
		assert.equal(countLines("a\nb\n"), 2)
		assert.equal(countLines("\n"), 1)
	})
})

describe("formatSize", () => {
	it("scales the unit", () => {
		assert.equal(formatSize(512), "512B")
		assert.equal(formatSize(51_200), "50.0KB")
		assert.equal(formatSize(1_258_291), "1.2MB")
	})
})

describe("truncateToolOutput", () => {
	it("returns short output untouched", () => {
		const text = "3 traces found\nab12\ncd34"
		const result = truncateToolOutput(text)
		assert.isFalse(result.truncated)
		// Identity: every tool call pays this, so the common case must cost nothing but measurement.
		assert.strictEqual(result.text, text)
	})

	it("cuts on the line limit", () => {
		const text = Array.from({ length: MAX_TOOL_OUTPUT_LINES + 500 }, (_, i) => `row ${i}`).join("\n")
		const result = truncateToolOutput(text)

		assert.isTrue(result.truncated)
		const body = result.text.slice(0, result.text.indexOf("\n\n…["))
		assert.equal(countLines(body), MAX_TOOL_OUTPUT_LINES)
		assert.isTrue(body.startsWith("row 0\n"))
		assert.isTrue(body.endsWith(`row ${MAX_TOOL_OUTPUT_LINES - 1}`))
	})

	it("cuts on the byte limit even when the line count is fine", () => {
		// One enormous line — a trace payload, not a row set. The line limit alone would pass it.
		const result = truncateToolOutput("x".repeat(MAX_TOOL_OUTPUT_BYTES * 2))

		assert.isTrue(result.truncated)
		const body = result.text.slice(0, result.text.indexOf("\n\n…["))
		assert.equal(utf8ByteLength(body), MAX_TOOL_OUTPUT_BYTES)
	})

	it("counts bytes, not JS string length", () => {
		// "…" is 3 UTF-8 bytes. 400 of them is 1200 bytes against a 1000-byte budget, but only 400
		// by `.length` — measuring the wrong one lets 20% more through than the provider will see.
		const result = truncateToolOutput("…".repeat(400), { maxBytes: 1_000, maxLines: 10 })
		assert.isTrue(result.truncated)
	})

	it("never splits a character", () => {
		// A budget landing mid-sequence: 3-byte characters against a budget that is not a multiple
		// of 3. A naive byte slice decodes the tail to U+FFFD, which the model cannot tell apart
		// from a replacement character the tool really returned.
		for (const maxBytes of [100, 101, 102]) {
			const result = truncateToolOutput("…".repeat(200), { maxBytes, maxLines: 10 })
			const body = result.text.slice(0, result.text.indexOf("\n\n…["))
			assert.notInclude(body, "�")
			assert.isAtMost(utf8ByteLength(body), maxBytes)
		}
	})

	it("keeps the head, so the excerpt is the start of the real output", () => {
		const text = `first row\n${"filler\n".repeat(5_000)}last row`
		assert.isTrue(truncateToolOutput(text).text.startsWith("first row\n"))
	})

	it("tells the model what it lost and what to do about it", () => {
		// A result that quietly loses its tail is indistinguishable from a tool that returned less
		// than it did — which is how a model concludes "there were only 2000 traces".
		const text = Array.from({ length: 10_000 }, (_, i) => `row ${i}`).join("\n")
		const marker = truncateToolOutput(text).text

		assert.include(marker, "truncated")
		assert.include(marker, `first ${MAX_TOOL_OUTPUT_LINES} of 10000 lines`)
		assert.include(marker, "Narrow the request")
	})

	it("handles empty output", () => {
		const result = truncateToolOutput("")
		assert.isFalse(result.truncated)
		assert.equal(result.text, "")
	})

	it("bounds a single line longer than the byte budget", () => {
		// No newline to cut at — the line slice is a no-op and the byte slice has to carry it.
		const result = truncateToolOutput("y".repeat(5_000), { maxLines: 10, maxBytes: 1_000 })
		const body = result.text.slice(0, result.text.indexOf("\n\n…["))
		assert.equal(body.length, 1_000)
	})
})

describe("renderToolDocWithinBudget", () => {
	const rows = (count: number) => Array.from({ length: count }, (_, i) => [`row-${i}`, "x".repeat(100)])
	const big = (count: number): ToolDoc => ({
		title: "Big",
		scope: [["Time range", "last 6h"]],
		blocks: [doc.text("Summary first."), doc.table(["Name", "Value"], rows(count)), doc.text("trailer")],
		truncation: {
			shown: count,
			total: count * 2,
			noun: "rows",
			next: doc.next("search_traces", { offset: count }, "next page"),
		},
		next: [doc.next("list_services", {}, "look around")],
	})

	it("renders a doc that fits exactly as renderToolDoc does", () => {
		assert.equal(renderToolDocWithinBudget(big(5)), renderToolDoc(big(5)))
	})

	it("cuts the overflowing table on a row boundary and keeps head, tail and a narrowing notice", () => {
		const text = renderToolDocWithinBudget(big(1_000))
		assert.isAtMost(text.length, MAX_TOOL_TEXT_CHARS)
		assert.include(text, "## Big")
		assert.include(text, "Summary first.")
		assert.include(text, "`list_services`")
		const kept = Number(
			/showing (\d+) of 1000 rows in the last section; 1 later section omitted/.exec(text)?.[1],
		)
		assert.isBelow(kept, 1_000)
		// Paging follows the rows actually sent, and no next page skips the ones that were cut.
		assert.include(text, `Showing ${kept} of 2000 rows.`)
		assert.notInclude(text, "Next page")
		assert.notInclude(text, "offset=1000")
		assert.include(text, "lower `limit`")
		assert.notInclude(text, "trailer")
		assert.notInclude(text, "row-999")
		const lastRow = text
			.split("\n")
			.filter((line) => line.startsWith("| row-"))
			.at(-1)!
		assert.match(lastRow, /\|$/)
	})

	it("keeps the hard-cut fallback, marker included, under the ceiling", () => {
		const text = renderToolDocWithinBudget(
			{ title: "t".repeat(5_000), blocks: [doc.text("body")] },
			1_000,
		)
		assert.isAtMost(text.length, 1_000)
		assert.include(text, "[truncated:")
	})

	it("cuts one enormous line on characters", () => {
		const text = renderToolDocWithinBudget(
			{ title: "Blob", blocks: [doc.text("z".repeat(100_000))] },
			2_000,
		)
		assert.isAtMost(text.length, 2_000)
		assert.include(text, "characters in the last section")
	})
})
