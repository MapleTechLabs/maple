import { describe, expect, it } from "vitest"
import { genAiErrorFingerprintText } from "./gen-ai-columns"

// Messages production tool failures carry. A tool call's result reaches the
// span as JSON, `{"result":"…"}`, so each is wrapped exactly that way before
// the mirror sees it.
const result = (message: string) => JSON.stringify({ result: message })
const fromResult = (message: string) =>
	genAiErrorFingerprintText({ failedToolCallResult: result(message), statusMessage: "" })

describe("genAiErrorFingerprintText", () => {
	it("groups a missing key by its path, not by the array index it was missing at", () => {
		const missingAt = (index: number) =>
			fromResult(`Invalid tool input: Missing key\n  at ["evidence"][${index}]["traceIds"]`)
		expect(missingAt(1)).toBe(missingAt(0))
		expect(missingAt(2)).toBe(missingAt(0))
		expect(fromResult('Invalid tool input: Missing key\n  at ["claim"]')).not.toBe(
			fromResult('Invalid tool input: Missing key\n  at ["scopeSummary"]'),
		)
	})

	it("groups a timeout whatever elapsed time it reports", () => {
		const timeout = (elapsed: string) =>
			fromResult(
				`Tool failed: @maple/mcp/errors/McpQueryError: [Error] Timeout exceeded: elapsed ${elapsed} ms, maximum: 15000 ms.`,
			)
		expect(timeout("10000.4")).toBe(timeout("15346.717367"))
	})

	it("keeps a quoted argument value apart, because it names a different mistake", () => {
		const invalidGroupBy = (value: string) =>
			fromResult(`Tool failed: Invalid group_by "${value}" for source="traces" kind="breakdown".`)
		expect(invalidGroupBy("service.version")).not.toBe(invalidGroupBy("commit_shas"))
	})

	it("reads the status message where the call carries no result, and the result where it does", () => {
		const statusMessage = "effect-agent.execute_tool: Tool execution reached a failed terminal state"
		expect(genAiErrorFingerprintText({ failedToolCallResult: "", statusMessage })).toBe(statusMessage)
		expect(genAiErrorFingerprintText({ failedToolCallResult: result("boom"), statusMessage })).toBe(
			result("boom"),
		)
	})
})
