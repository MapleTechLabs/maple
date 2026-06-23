import { describe, expect, it } from "vitest"
import { looksMutating } from "@maple/codemode"
import { mapleToolDefinitions } from "./registry"
import { MUTATING_TOOL_NAMES } from "./mutating"

describe("MUTATING_TOOL_NAMES", () => {
	it("every approval-gated tool exists in the registry", () => {
		const registered = new Set(mapleToolDefinitions.map((d) => d.name))
		for (const name of MUTATING_TOOL_NAMES) {
			expect(registered.has(name), `missing registered tool: ${name}`).toBe(true)
		}
	})

	it("gates every conventionally-named mutating tool (run_code's sandbox fails OPEN otherwise)", () => {
		// The inverse of the check above, and the safety-critical one: a registry
		// tool that looks mutating (create_/update_/delete_/…) but is missing from
		// the set would run its real side effect inside `run_code`. This fails CI so
		// a new mutating tool can't ship ungated.
		const ungated = mapleToolDefinitions
			.map((d) => d.name)
			.filter((name) => looksMutating(name) && !MUTATING_TOOL_NAMES.has(name))
		expect(
			ungated,
			`mutating-looking tools are NOT in MUTATING_TOOL_NAMES — gate them or they run real side effects inside run_code: [${ungated.join(", ")}]`,
		).toEqual([])
	})

	it("excludes read-only tools (so /chat/apply can't run them)", () => {
		expect(MUTATING_TOOL_NAMES.has("find_errors")).toBe(false)
		expect(MUTATING_TOOL_NAMES.has("search_traces")).toBe(false)
		expect(MUTATING_TOOL_NAMES.has("list_dashboards")).toBe(false)
		expect(MUTATING_TOOL_NAMES.has("get_dashboard")).toBe(false)
	})

	it("covers the dashboard/alert/issue mutations", () => {
		expect(MUTATING_TOOL_NAMES.has("update_dashboard_widget")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("create_alert_rule")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("transition_error_issue")).toBe(true)
	})
})
