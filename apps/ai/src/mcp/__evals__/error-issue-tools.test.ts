/**
 * The error-issue tools on the `define` contract, end to end through the executor against an
 * empty PGlite database: typed outputs, enum and id decoding, and not-found as invalid input.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	ListErrorIncidentsOutput,
	ListErrorIssuesOutput,
	RegisterAgentOutput,
} from "@maple/domain/mcp-outputs"
import { makeEvalRuntime, runToolDirect, markdown, type EvalRuntime } from "./eval-runtime"
import { installFakeWarehouse, restoreWarehouse } from "./fake-warehouse"
import type { McpToolResult } from "../tools/types"

const MISSING_ISSUE = "3f1c2b8e-9d4a-4c6b-8e2f-1a2b3c4d5e6f"

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: unknown): Promise<McpToolResult> => runToolDirect(rt, name, params)

describe("error-issue tools", () => {
	it("list_error_issues returns a typed empty page and says what was searched", async () => {
		const result = await call("list_error_issues", { workflow_state: "triage", include_archived: "1" })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(ListErrorIssuesOutput)(result.structuredContent)
		expect(output.total).toBe(0)
		expect(output.filters).toMatchObject({ workflowState: "triage", includeArchived: true, limit: 50 })
		const text = markdown(result)
		expect(text).toContain("## Error Issues")
		expect(text).toContain("State: triage")
		expect(text).toContain("No error issues found.")
	})

	it("rejects a severity outside the enum as a parameter error", async () => {
		const result = await call("list_error_issues", { severity: "urgent" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Invalid parameters for `list_error_issues`:")
		expect(markdown(result)).toContain("`severity`")
	})

	it("rejects a fingerprint passed as issue_id, naming where issue ids come from", async () => {
		const result = await call("transition_error_issue", {
			issue_id: "11640295108927840024",
			to_state: "todo",
		})
		expect(result.isError).toBe(true)
		const text = markdown(result)
		expect(text).toContain("`issue_id`")
		expect(text).toContain("list_error_issues")
	})

	it("does not offer machine-owned states to transition_error_issue", async () => {
		const result = await call("transition_error_issue", {
			issue_id: MISSING_ISSUE,
			to_state: "regressed",
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("`to_state`")
	})

	it("reports an unknown issue as invalid input on issue_id", async () => {
		const result = await call("set_issue_severity", { issue_id: MISSING_ISSUE, severity: "high" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toMatch(/^Invalid input \(`issue_id`\): /)
	})

	it("reports an out-of-range lease as invalid input", async () => {
		const result = await call("claim_error_issue", {
			issue_id: MISSING_ISSUE,
			lease_duration_seconds: 10,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toMatch(/^Invalid input \(`lease_duration_seconds`\): /)
	})

	it("list_error_incidents returns a typed empty list", async () => {
		const result = await call("list_error_incidents", {})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(ListErrorIncidentsOutput)(result.structuredContent)
		expect(output.total).toBe(0)
		expect(markdown(result)).toContain("No open incidents in this org.")
	})

	it("register_agent decodes capabilities_json against the real schema", async () => {
		const bad = await call("register_agent", {
			name: "eval-agent",
			capabilities_json: '{"not":"a list"}',
		})
		expect(bad.isError).toBe(true)
		expect(markdown(bad)).toContain("`capabilities_json`")

		const result = await call("register_agent", {
			name: "eval-agent",
			capabilities_json: '["auto-triage"]',
		})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(RegisterAgentOutput)(result.structuredContent)
		expect(output.capabilities).toEqual(["auto-triage"])
		expect(markdown(result)).toContain(`x-maple-agent-id: ${output.id}`)
	})
})
