import { Result, Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { statusPage, statusPageConfig } from "../shared/test-pages"
import { parseDraft, problemText } from "./config-json"

const problemOf = (text: string) =>
	Result.match(parseDraft(text, statusPageConfig(statusPage(), [])), {
		onFailure: (problem) => problemText(problem),
		onSuccess: () => "ok",
	})

describe("parseDraft on hostile input", () => {
	it("reports deep nesting as a problem instead of overflowing the stack", () => {
		expect(problemOf(Str.repeat(20_000)("["))).toContain("Nested too deeply")
	})

	it("walks a very long array without overflowing the stack", () => {
		const longArray = `[${Arr.join(
			Array.from({ length: 20_000 }, () => "1"),
			",",
		)}`
		expect(problemOf(longArray)).toContain("column 40001")
	})
})
