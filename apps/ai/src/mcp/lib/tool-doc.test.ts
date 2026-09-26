import { describe, expect, it } from "vitest"
import { doc, filterNextCalls, renderToolDoc } from "./tool-doc"

describe("renderToolDoc", () => {
	it("renders sections in a fixed order", () => {
		const text = renderToolDoc({
			title: "Errors by Type",
			scope: [
				["Time range", "a to b"],
				["Service", undefined],
			],
			notices: ["`servce` is not a parameter"],
			blocks: [doc.table(["Error", "Count"], [["Boom | pipe", "3"]])],
			truncation: {
				shown: 1,
				total: 9,
				noun: "error types",
				next: doc.next("find_errors", { offset: 1 }, "the next page"),
			},
			next: [doc.next("error_detail", { fingerprint: "123", service: undefined }, "sample traces")],
		})
		expect(text).toBe(
			[
				"## Errors by Type",
				"Time range: a to b",
				"Note: `servce` is not a parameter",
				"| Error | Count |\n|---|---|\n| Boom \\| pipe | 3 |",
				"Showing 1 of 9 error types. Next page: `find_errors offset=1`: the next page",
				'Next:\n- `error_detail fingerprint="123"`: sample traces',
			].join("\n\n"),
		)
	})

	it("says what was searched when nothing matched", () => {
		const text = renderToolDoc({
			title: "Logs",
			empty: { message: "No logs matched.", hints: ["Widen the window."] },
			blocks: [],
		})
		expect(text).toBe("## Logs\n\nNo logs matched.\n\n- Widen the window.")
	})

	it("fences code with a fence longer than any backtick run inside", () => {
		expect(renderToolDoc({ title: "T", blocks: [doc.code("sql", "select '```'")] })).toBe(
			"## T\n\n````sql\nselect '```'\n````",
		)
	})

	it("removes rejected next calls, including the page link", () => {
		const page = doc.next("search_logs", { offset: 30 }, "more")
		const filtered = filterNextCalls(
			{ title: "T", blocks: [], truncation: { shown: 30, noun: "logs", next: page }, next: [page] },
			() => false,
		)
		expect(renderToolDoc(filtered)).toBe("## T\n\nShowing 30 logs.")
	})
})
