/**
 * Issue transitions against seeded PGlite rows: the real previous state on single moves, and the
 * multi-issue paths (transition_error_issues, propose_fix `also_issue_ids`) reporting per id.
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	ProposeFixOutput,
	TransitionErrorIssueOutput,
	TransitionErrorIssuesOutput,
} from "@maple/domain/mcp-outputs"
import { executeSql } from "@maple/backend/platform/test-pglite"
import { makeEvalRuntime, runToolDirect, markdown, type EvalRuntime } from "./eval-runtime"
import { installFakeWarehouse, restoreWarehouse } from "./fake-warehouse"
import { FIXTURES } from "./utils"
import type { McpToolResult } from "../tools/types"

const MISSING_ISSUE = "3f1c2b8e-9d4a-4c6b-8e2f-1a2b3c4d5e6f"

let rt: EvalRuntime
let seq = 0

beforeAll(() => {
	installFakeWarehouse([])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: unknown): Promise<McpToolResult> => runToolDirect(rt, name, params)

const seedIssue = async (): Promise<string> => {
	const id = randomUUID()
	seq += 1
	const now = new Date().toISOString()
	await executeSql(
		rt.testDb,
		`insert into error_issues (id, org_id, fingerprint_hash, service_name, exception_type,
			exception_message, top_frame, first_seen_at, last_seen_at, created_at, updated_at)
		values ($1, $2, $3, 'checkout-api', 'TimeoutError', 'upstream timed out', '', $4, $4, $4, $4)`,
		[id, FIXTURES.orgId, String(1_000_000 + seq), now],
	)
	return id
}

describe("transition_error_issue", () => {
	it("returns the state the issue moved from", async () => {
		const id = await seedIssue()
		const result = await call("transition_error_issue", { issue_id: id, to_state: "todo" })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(TransitionErrorIssueOutput)(result.structuredContent)
		expect(output).toMatchObject({ fromState: "triage", toState: "todo", workflowState: "todo" })
		expect(markdown(result)).toContain("triage -> todo")
	})

	it("names the allowed next states when a move is illegal", async () => {
		const id = await seedIssue()
		const result = await call("transition_error_issue", { issue_id: id, to_state: "in_review" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("From 'triage' it can go to: todo, in_progress")
	})
})

describe("transition_error_issues", () => {
	it("moves each issue on its own and reports refusals per id", async () => {
		const a = await seedIssue()
		const b = await seedIssue()
		const result = await call("transition_error_issues", {
			issue_ids: [a, b, MISSING_ISSUE, "11640295108927840024", a],
			to_state: "in_progress",
			note: "same root cause as the deploy regression",
		})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(TransitionErrorIssuesOutput)(result.structuredContent)
		expect(output.succeeded).toBe(2)
		expect(output.failed).toBe(2)
		expect(output.results.find((r) => r.id === a)).toMatchObject({
			ok: true,
			fromState: "triage",
			workflowState: "in_progress",
		})
		expect(output.results.find((r) => r.id === MISSING_ISSUE)?.ok).toBe(false)
		expect(output.results.find((r) => r.id === "11640295108927840024")?.error).toContain(
			"list_error_issues",
		)
		expect(markdown(result)).toContain(MISSING_ISSUE)
	})

	it("refuses an illegal move per issue with the allowed states", async () => {
		const id = await seedIssue()
		const result = await call("transition_error_issues", { issue_ids: [id], to_state: "in_review" })
		const output = Schema.decodeUnknownSync(TransitionErrorIssuesOutput)(result.structuredContent)
		expect(output.results[0]?.error).toContain("it can go to:")
	})

	it("caps the list", async () => {
		const ids = Array.from({ length: 201 }, () => randomUUID())
		const result = await call("transition_error_issues", { issue_ids: ids, to_state: "todo" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toMatch(/^Invalid input \(`issue_ids`\): /)
	})
})

describe("propose_fix also_issue_ids", () => {
	it("applies one fix to several issues", async () => {
		const primary = await seedIssue()
		const other = await seedIssue()
		const result = await call("propose_fix", {
			issue_id: primary,
			patch_summary: "Retry the upstream call with backoff.",
			also_issue_ids: [other, MISSING_ISSUE],
		})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(ProposeFixOutput)(result.structuredContent)
		expect(output.workflowState).toBe("in_review")
		expect(output.also).toEqual([
			{ id: other, ok: true, workflowState: "in_review" },
			expect.objectContaining({ id: MISSING_ISSUE, ok: false }),
		])
	})
})
