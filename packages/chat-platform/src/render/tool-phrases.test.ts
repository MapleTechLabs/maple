import { describe, expect, it } from "vitest"
import { toolPhrase } from "./tool-phrases"

describe("toolPhrase", () => {
	it("holds one call's phrase still across re-renders", () => {
		expect(toolPhrase("run_sql", "call_1")).toBe(toolPhrase("run_sql", "call_1"))
	})

	it("varies the phrase from call to call", () => {
		const phrases = new Set(
			Array.from({ length: 20 }, (_, index) => toolPhrase("run_sql", `call_${index}`)),
		)
		expect(phrases.size).toBeGreaterThan(1)
		for (const phrase of phrases) expect(phrase).not.toContain("run_sql")
	})

	it("never shows a raw tool name, even for a tool it has no phrase for", () => {
		expect(toolPhrase("brand_new_tool", "call_1")).toBe("Using brand new tool")
	})
})
