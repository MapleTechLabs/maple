import { describe, expect, it } from "vitest"
import { fuzzyMatch, ToolCallScorer } from "./harness"

describe("fuzzyMatch", () => {
	it("treats expected object keys as a subset of the actual ones", () => {
		expect(fuzzyMatch({ service: "api" }, { service: "api", limit: 5 })).toBe(true)
		expect(fuzzyMatch({ service: "api", limit: 5 }, { service: "api" })).toBe(false)
	})

	it("compares strings case-insensitively as substrings either way round", () => {
		expect(fuzzyMatch("Checkout", "checkout-api")).toBe(true)
		expect(fuzzyMatch("checkout-api", "CHECKOUT")).toBe(true)
		expect(fuzzyMatch("checkout", "billing")).toBe(false)
	})

	it("matches arrays in any order, each actual item used once", () => {
		expect(fuzzyMatch(["b", "a"], ["a", "b", "c"])).toBe(true)
		expect(fuzzyMatch(["a", "a"], ["a", "b"])).toBe(false)
	})

	it("compares numbers within a relative tolerance", () => {
		expect(fuzzyMatch(1000, 1000.5)).toBe(true)
		expect(fuzzyMatch(1000, 1002)).toBe(false)
	})

	it("does not coerce across types", () => {
		expect(fuzzyMatch(true, "true")).toBe(false)
		expect(fuzzyMatch(5, "5")).toBe(false)
	})
})

const run = (
	expectedTools: ReadonlyArray<{ name: string; arguments?: Record<string, unknown> }>,
	toolCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>,
) => ({ input: "", output: "", expectedTools, toolCalls })

describe("ToolCallScorer", () => {
	it("passes when every expected tool was called with matching arguments, extras allowed", () => {
		const result = ToolCallScorer().score(
			run(
				[{ name: "find_errors", arguments: { service: "API" } }],
				[
					{ name: "list_services", arguments: {} },
					{ name: "find_errors", arguments: { service: "api", limit: 10 } },
				],
			),
		)
		expect(result.score).toBe(1)
	})

	it("scores 0 on any miss by default", () => {
		const result = ToolCallScorer().score(
			run(
				[{ name: "find_errors" }, { name: "inspect_trace" }],
				[{ name: "find_errors", arguments: {} }],
			),
		)
		expect(result.score).toBe(0)
		expect(result.rationale).toContain("missing inspect_trace")
	})

	it("scores the matched fraction without requireAll", () => {
		const result = ToolCallScorer({ requireAll: false }).score(
			run(
				[{ name: "find_errors" }, { name: "inspect_trace" }],
				[{ name: "find_errors", arguments: {} }],
			),
		)
		expect(result.score).toBe(0.5)
	})

	it("reports a right tool with wrong arguments as such", () => {
		const result = ToolCallScorer().score(
			run(
				[{ name: "error_detail", arguments: { fingerprint: "123" } }],
				[{ name: "error_detail", arguments: { fingerprint: "999" } }],
			),
		)
		expect(result.score).toBe(0)
		expect(result.rationale).toContain("error_detail called with wrong arguments")
	})

	it("scores 0 when nothing was called and 1 when nothing was expected", () => {
		expect(ToolCallScorer().score(run([{ name: "find_errors" }], [])).score).toBe(0)
		expect(ToolCallScorer().score(run([], [{ name: "find_errors", arguments: {} }])).score).toBe(1)
	})
})
