import { describe, expect, it } from "vitest"
import { formatRunOutput, formatRunResult } from "./format.ts"
import { PROPOSED_BATCH_STATUS, type CodeRunResult } from "./types.ts"

const base: CodeRunResult = { logs: [], returnValue: undefined, error: null }

describe("formatRunOutput", () => {
	it("renders console + return value", () => {
		const out = formatRunOutput({ ...base, logs: ["a", "b"], returnValue: { n: 1 } })
		expect(out).toContain("Console output:\na\nb")
		expect(out).toContain('Return value:\n{\n  "n": 1\n}')
	})

	it("surfaces an error", () => {
		const out = formatRunOutput({ ...base, error: { name: "Boom", message: "bad" } })
		expect(out).toBe("Error (Boom): bad")
	})

	it("explains a crash distinctly", () => {
		const out = formatRunOutput({ ...base, crashed: true, error: { name: "TimeoutError", message: "aborted" } })
		expect(out).toContain("Code mode failed to run your snippet (TimeoutError): aborted")
	})

	it("handles an empty run", () => {
		expect(formatRunOutput(base)).toContain("no console output")
	})
})

describe("formatRunResult", () => {
	it("returns plain text when there are no proposals", () => {
		const out = formatRunResult({ ...base, logs: ["hi"] })
		expect(out).toContain("Console output:\nhi")
		expect(() => JSON.parse(out)).toThrow()
	})

	it("wraps proposals in a proposed_batch envelope", () => {
		const out = formatRunResult({ ...base, logs: ["did stuff"] }, [
			{ tool: "create_dashboard", input: { title: "x" } },
			{ tool: "add_dashboard_widget", input: { id: "1" } },
		])
		const parsed = JSON.parse(out)
		expect(parsed.status).toBe(PROPOSED_BATCH_STATUS)
		expect(parsed.proposals).toHaveLength(2)
		expect(parsed.text).toContain("Queued 2 change(s) for approval: create_dashboard, add_dashboard_widget.")
	})
})
