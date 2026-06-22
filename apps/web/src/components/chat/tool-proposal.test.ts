import { describe, expect, it } from "vitest"
import { parseToolProposal, parseToolProposalBatch } from "./tool-proposal"

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

	it("does not treat a proposed_batch as a single proposal", () => {
		const out = JSON.stringify({
			status: "proposed_batch",
			proposals: [{ tool: "create_dashboard", input: {} }],
		})
		expect(parseToolProposal(out)).toBeNull()
	})
})

describe("parseToolProposalBatch", () => {
	it("parses a run_code proposed_batch envelope into one proposal per change", () => {
		const out = JSON.stringify({
			status: "proposed_batch",
			proposals: [
				{ tool: "create_dashboard", input: { title: "x" } },
				{ tool: "add_dashboard_widget", input: { id: "1" } },
			],
			text: "did stuff",
		})
		const batch = parseToolProposalBatch(out)
		expect(batch).toHaveLength(2)
		expect(batch?.[0]).toEqual({ status: "proposed", tool: "create_dashboard", input: { title: "x" } })
		expect(batch?.[1]?.tool).toBe("add_dashboard_widget")
	})

	it("drops malformed entries and returns null when nothing valid remains", () => {
		expect(
			parseToolProposalBatch(JSON.stringify({ status: "proposed_batch", proposals: [{ no: "tool" }] })),
		).toBeNull()
	})

	it("returns null for non-batch output", () => {
		expect(parseToolProposalBatch("plain text")).toBeNull()
		expect(parseToolProposalBatch(JSON.stringify({ status: "proposed", tool: "x" }))).toBeNull()
		expect(parseToolProposalBatch(null)).toBeNull()
	})
})
