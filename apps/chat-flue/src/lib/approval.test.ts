import { describe, expect, it } from "vitest"
import {
	applyApprovalGates,
	MUTATING_TOOL_NAMES,
	parseToolProposal,
	PROPOSAL_STATUS,
} from "./approval.ts"

const fakeTool = (name: string, execute = async () => "real-result") => ({
	name,
	description: "desc",
	parameters: {},
	execute,
})

describe("MUTATING_TOOL_NAMES", () => {
	it("covers dashboard/alert/issue mutations and excludes read tools", () => {
		expect(MUTATING_TOOL_NAMES.has("update_dashboard_widget")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("transition_error_issue")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("create_alert_rule")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("search_traces")).toBe(false)
		expect(MUTATING_TOOL_NAMES.has("find_errors")).toBe(false)
	})
})

describe("applyApprovalGates", () => {
	it("passes read-only tools through unchanged", async () => {
		const read = fakeTool("mcp__maple__search_traces")
		const [gated] = applyApprovalGates([read])
		expect(gated).toBe(read)
		expect(await gated.execute({})).toBe("real-result")
	})

	it("replaces a mutating tool's execute with a proposal marker", async () => {
		let sideEffect = false
		const mutate = fakeTool("mcp__maple__update_dashboard_widget", async () => {
			sideEffect = true
			return "mutated"
		})
		const [gated] = applyApprovalGates([mutate])

		// name + schema preserved so the model calls it identically
		expect(gated.name).toBe("mcp__maple__update_dashboard_widget")
		expect(gated.parameters).toBe(mutate.parameters)

		const result = await gated.execute({ dashboard_id: "d1", widget_id: "w2" })
		expect(sideEffect).toBe(false) // no mutation performed
		const proposal = parseToolProposal(result)
		expect(proposal).toEqual({
			status: PROPOSAL_STATUS,
			tool: "update_dashboard_widget",
			input: { dashboard_id: "d1", widget_id: "w2" },
		})
	})
})

describe("parseToolProposal", () => {
	it("returns null for a non-proposal result", () => {
		expect(parseToolProposal("plain text")).toBeNull()
		expect(parseToolProposal(JSON.stringify({ status: "ok" }))).toBeNull()
	})
})
