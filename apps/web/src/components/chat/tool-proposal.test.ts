import { describe, expect, it } from "vitest"
import { parseToolProposal } from "./tool-proposal"

describe("parseToolProposal", () => {
	it("parses a JSON-string proposal (Flue's tool output)", () => {
		const out = JSON.stringify({
			status: "proposed",
			tool: "update_dashboard_widget",
			input: { dashboard_id: "d1", widget_id: "w1" },
		})
		const proposal = parseToolProposal(out)
		expect(proposal).not.toBeNull()
		expect(proposal?.tool).toBe("update_dashboard_widget")
		expect(proposal?.input).toEqual({ dashboard_id: "d1", widget_id: "w1" })
	})

	it("parses an already-parsed object proposal", () => {
		const proposal = parseToolProposal({ status: "proposed", tool: "create_alert_rule", input: { x: 1 } })
		expect(proposal?.tool).toBe("create_alert_rule")
	})

	it("returns null for non-proposal output", () => {
		expect(parseToolProposal("a normal tool result")).toBeNull()
		expect(parseToolProposal(JSON.stringify({ status: "ok" }))).toBeNull()
		expect(parseToolProposal(JSON.stringify({ status: "proposed" }))).toBeNull() // no tool
		expect(parseToolProposal(null)).toBeNull()
		expect(parseToolProposal(undefined)).toBeNull()
		expect(parseToolProposal(42)).toBeNull()
	})
})
