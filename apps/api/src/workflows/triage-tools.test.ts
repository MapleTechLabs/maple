import { describe, expect, it } from "vitest"
import { mapleToolDefinitions } from "@/mcp/tools/registry"
import { SUBMIT_TRIAGE_TOOL_NAME, TRIAGE_TOOL_NAMES, decodeTriageResult } from "./triage-tools"

const MUTATION_TOOL_NAMES = [
	"create_dashboard",
	"update_dashboard",
	"add_dashboard_widget",
	"remove_dashboard_widget",
	"reorder_dashboard_widgets",
	"replace_dashboard_widgets",
	"update_dashboard_widget",
	"create_alert_rule",
	"transition_error_issue",
	"claim_error_issue",
	"release_error_issue",
	"heartbeat_error_issue",
	"comment_on_error_issue",
	"propose_fix",
	"register_agent",
	"update_error_notification_policy",
]

describe("TRIAGE_TOOL_NAMES", () => {
	it("every allowlisted tool exists in the registry (catches renames)", () => {
		const registryNames = new Set(mapleToolDefinitions.map((d) => d.name))
		for (const name of TRIAGE_TOOL_NAMES) {
			expect(registryNames.has(name), `missing registry tool: ${name}`).toBe(true)
		}
	})

	it("contains no mutation tools", () => {
		for (const name of MUTATION_TOOL_NAMES) {
			expect(TRIAGE_TOOL_NAMES.has(name), `mutation tool in allowlist: ${name}`).toBe(false)
		}
	})

	it("does not include session-replay tools", () => {
		expect(TRIAGE_TOOL_NAMES.has("search_sessions")).toBe(false)
		expect(TRIAGE_TOOL_NAMES.has("get_session_transcript")).toBe(false)
	})

	it("reserves the submit tool name (not a registry tool)", () => {
		const registryNames = new Set(mapleToolDefinitions.map((d) => d.name))
		expect(registryNames.has(SUBMIT_TRIAGE_TOOL_NAME)).toBe(false)
	})
})

describe("decodeTriageResult", () => {
	it("decodes a complete triage result", () => {
		const result = decodeTriageResult({
			summary: "Checkout error rate jumped to 12% after the 14:00 deploy.",
			suspectedCause: "NullPointerException in PaymentService.charge introduced by commit abc123.",
			severityAssessment: "high",
			affectedScope: "checkout-api POST /charge, ~12% of requests",
			evidence: [
				{
					traceIds: ["0af7651916cd43dd8448eb211c80319c"],
					logPatterns: ["payment provider timeout after <num>ms"],
					relatedServices: ["payment-service"],
					note: "All failing traces end in the same span.",
				},
			],
			suggestedActions: ["Roll back the 14:00 checkout-api deploy."],
			confidence: "high",
		})
		expect(result.severityAssessment).toBe("high")
		expect(result.evidence[0]?.traceIds).toHaveLength(1)
	})

	it("rejects results missing required fields", () => {
		expect(() => decodeTriageResult({ summary: "only a summary" })).toThrow()
	})
})
