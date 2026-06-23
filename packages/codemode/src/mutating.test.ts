import { describe, expect, it } from "vitest"
import { looksMutating, MUTATING_TOOL_NAMES, MUTATING_TOOL_PREFIXES } from "./mutating.ts"

describe("looksMutating", () => {
	it("flags conventionally-named mutating tools", () => {
		expect(looksMutating("create_dashboard")).toBe(true)
		expect(looksMutating("delete_alert_rule")).toBe(true)
		expect(looksMutating("set_issue_severity")).toBe(true)
		expect(looksMutating("register_agent")).toBe(true)
	})

	it("does not flag read-only tools or run_code", () => {
		for (const name of ["find_errors", "search_traces", "list_dashboards", "get_dashboard", "query_data", "run_code"]) {
			expect(looksMutating(name), name).toBe(false)
		}
	})

	it("every gated tool name matches the mutating convention (prefixes stay in sync with the set)", () => {
		for (const name of MUTATING_TOOL_NAMES) {
			expect(looksMutating(name), `${name} is gated but matches no MUTATING_TOOL_PREFIXES`).toBe(true)
		}
	})

	it("exposes the prefix list", () => {
		expect(MUTATING_TOOL_PREFIXES).toContain("create_")
		expect(MUTATING_TOOL_PREFIXES).not.toContain("get_")
		expect(MUTATING_TOOL_PREFIXES).not.toContain("run_")
	})
})
