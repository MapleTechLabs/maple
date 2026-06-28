import { describe, expect, it } from "vitest"
import { mapleToolDefinitions } from "./registry"
import { MUTATING_TOOL_NAMES } from "./mutating"

describe("MUTATING_TOOL_NAMES", () => {
	it("every approval-gated tool exists in the registry", () => {
		const registered = new Set(mapleToolDefinitions.map((d) => d.name))
		for (const name of MUTATING_TOOL_NAMES) {
			expect(registered.has(name), `missing registered tool: ${name}`).toBe(true)
		}
	})

	it("exactly equals the tools registered via mutatingTool (structural flag <-> shared list)", () => {
		// The per-tool `mutating` flag (set at registration via `server.mutatingTool`)
		// is the structural truth the run_code gate uses; MUTATING_TOOL_NAMES is the
		// static list the chat + /chat/apply paths use (they can't read the flag over
		// MCP). This asserts they can't drift in either direction — register a
		// mutating tool but forget the list (or vice versa) and CI fails.
		const flagged = new Set(mapleToolDefinitions.filter((d) => d.mutating).map((d) => d.name))
		const flaggedButUnlisted = [...flagged].filter((n) => !MUTATING_TOOL_NAMES.has(n))
		const listedButUnflagged = [...MUTATING_TOOL_NAMES].filter((n) => !flagged.has(n))
		expect(flaggedButUnlisted, `registered mutating but absent from MUTATING_TOOL_NAMES: [${flaggedButUnlisted.join(", ")}]`).toEqual([])
		expect(listedButUnflagged, `in MUTATING_TOOL_NAMES but not registered via mutatingTool: [${listedButUnflagged.join(", ")}]`).toEqual([])
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
