import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { ChatFlueEnv } from "./env.ts"
import { baseToolName, connectMapleMcp, filterMcpTools } from "./mcp.ts"
import { buildTriageContextMessage, TRIAGE_TOOL_NAMES } from "./triage-prompt.ts"
import { AiTriageResultSchema } from "./triage-result.ts"

describe("buildTriageContextMessage", () => {
	it("renders the incident kind + non-empty context lines", () => {
		const msg = buildTriageContextMessage("error", {
			fingerprint: "fp_1",
			service: "checkout",
			empty: "",
		})
		expect(msg).toContain("A new error incident opened")
		expect(msg).toContain("- fingerprint: fp_1")
		expect(msg).toContain("- service: checkout")
		expect(msg).not.toContain("- empty:")
		expect(msg).toContain("produce your structured triage result")
	})
	it("JSON-encodes non-string values", () => {
		const msg = buildTriageContextMessage("anomaly", { count: 42, tags: ["a", "b"] })
		expect(msg).toContain("- count: 42")
		expect(msg).toContain('- tags: ["a","b"]')
	})
})

describe("TRIAGE_TOOL_NAMES", () => {
	it("is the read-only 18-tool subset and excludes mutations", () => {
		expect(TRIAGE_TOOL_NAMES.size).toBe(18)
		expect(TRIAGE_TOOL_NAMES.has("search_traces")).toBe(true)
		for (const mutating of [
			"create_dashboard",
			"update_dashboard_widget",
			"transition_error_issue",
			"create_alert_rule",
		]) {
			expect(TRIAGE_TOOL_NAMES.has(mutating)).toBe(false)
		}
	})
})

describe("mcp tool filtering", () => {
	it("strips the mcp__maple__ prefix", () => {
		expect(baseToolName("mcp__maple__search_traces")).toBe("search_traces")
		expect(baseToolName("search_traces")).toBe("search_traces")
	})
	it("keeps only allowlisted tools by base name", () => {
		const tools = [
			{ name: "mcp__maple__search_traces" },
			{ name: "mcp__maple__create_dashboard" },
			{ name: "mcp__maple__find_errors" },
		]
		const kept = filterMcpTools(tools, TRIAGE_TOOL_NAMES).map((t) => t.name)
		expect(kept).toEqual(["mcp__maple__search_traces", "mcp__maple__find_errors"])
	})

	it("connectMapleMcp fails fast (no empty bearer) when the token is unset", async () => {
		const env: ChatFlueEnv = {
			AI: { run: async () => ({}) },
			MAPLE_API_URL: "http://maple-test.invalid",
			INTERNAL_SERVICE_TOKEN: "",
		}
		await expect(connectMapleMcp(env, "org_1")).rejects.toThrow("INTERNAL_SERVICE_TOKEN is not configured")
	})
})

describe("AiTriageResultSchema", () => {
	const valid = {
		summary: "s",
		suspectedCause: "c",
		severityAssessment: "high",
		affectedScope: "checkout",
		evidence: [{ traceIds: ["t1"], logPatterns: [], relatedServices: ["checkout"], note: "n" }],
		suggestedActions: ["roll back"],
		confidence: "medium",
	}
	it("parses a valid result", () => {
		expect(() => v.parse(AiTriageResultSchema, valid)).not.toThrow()
	})
	it("rejects an invalid severity", () => {
		expect(v.safeParse(AiTriageResultSchema, { ...valid, severityAssessment: "catastrophic" }).success).toBe(
			false,
		)
	})
	it("rejects a result missing required fields", () => {
		expect(v.safeParse(AiTriageResultSchema, { summary: "only" }).success).toBe(false)
	})
})
