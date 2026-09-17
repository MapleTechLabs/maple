import { describe, expect, it } from "vitest"

import {
	describeSchemaFailure,
	failureDetailText,
	incompleteRunTool,
	rawFailureText,
	stripFailurePrefixes,
	toolNamedBySchemaError,
} from "./failure-text"
import { llmSpan, toolSpan } from "./span-test-support"

describe("stripFailurePrefixes", () => {
	it("drops every framework prefix and tag in front of the words", () => {
		expect(
			stripFailurePrefixes(
				"Tool failed: @maple/mcp/errors/McpQueryError: @maple/http/errors/IntegrationsUpstreamError: GitHub App is not configured",
			),
		).toBe("GitHub App is not configured")
		expect(stripFailurePrefixes("Model response failed: Upstream error from NextBit: nope")).toBe(
			"Upstream error from NextBit: nope",
		)
		expect(stripFailurePrefixes("[Error] Timeout exceeded: elapsed 5014 ms, maximum: 5000 ms")).toBe(
			"Timeout exceeded: elapsed 5014 ms, maximum: 5000 ms",
		)
	})

	it("leaves a message with no prefix alone", () => {
		expect(stripFailurePrefixes("exit 1")).toBe("exit 1")
	})

	it("strips a tag chain of any length", () => {
		const chain = Array.from({ length: 12 }, (_, index) => `@maple/errors/E${index}: `).join("")
		expect(stripFailurePrefixes(`${chain}real text`)).toBe("real text")
	})

	it("closes the schema wrapper it opened, hint and all", () => {
		expect(
			stripFailurePrefixes(
				'Tool failed: Invalid parameters: SchemaError(boom happened). Check the "sandbox_grep" tool schema for valid parameter names.',
			),
		).toBe("boom happened")
		expect(stripFailurePrefixes("SchemaError(Expected a number (not a string))")).toBe(
			"Expected a number (not a string)",
		)
	})
})

describe("describeSchemaFailure", () => {
	it("names the last key of a missing-key path", () => {
		expect(describeSchemaFailure('Missing key\n  at [2]["params"]["report"]["suspectedCause"]')).toBe(
			"missing key `suspectedCause`",
		)
	})

	it("carries what was expected of a present key", () => {
		expect(describeSchemaFailure('Expected <filter>\n  at [2]["params"]["incidentStartedAt"]')).toBe(
			"`incidentStartedAt`: expected <filter>",
		)
	})

	it("reads through the tool-parameter wrapping", () => {
		expect(
			describeSchemaFailure(
				'Tool failed: Invalid parameters: SchemaError(Missing key\n  at ["pattern"]). Check the "sandbox_grep" tool schema for valid parameter names.',
			),
		).toBe("missing key `pattern`")
	})

	it("is nothing for a message that is not a schema failure", () => {
		expect(describeSchemaFailure("connection reset")).toBeUndefined()
		expect(describeSchemaFailure("Missing key somewhere")).toBeUndefined()
	})
})

describe("incompleteRunTool / toolNamedBySchemaError", () => {
	it("names the completion tool a run stopped without", () => {
		expect(
			incompleteRunTool(
				"ModelProtocolError: Model stopped without required completion Tool submit_plan",
			),
		).toBe("submit_plan")
		expect(incompleteRunTool("Model stopped")).toBeUndefined()
	})

	it("names the tool a parameter error points at", () => {
		expect(
			toolNamedBySchemaError('Check the "sandbox_grep" tool schema for valid parameter names.'),
		).toBe("sandbox_grep")
		expect(toolNamedBySchemaError("no tool here")).toBeUndefined()
	})
})

describe("rawFailureText / failureDetailText", () => {
	it("prefers the recorded result over a framework's generic status message", () => {
		const span = toolSpan({
			spanId: "t",
			startMs: 0,
			durationMs: 1,
			statusCode: "Error",
			statusMessage: "effect-agent.execute_tool: Tool execution reached a failed terminal state",
			genAi: { toolCallResult: { result: "Tool failed: shard 3 is locked" } },
		})
		expect(rawFailureText(span)).toBe("Tool failed: shard 3 is locked")
		expect(failureDetailText(span)).toBe("shard 3 is locked")
	})

	it("falls back to the generic message when the result is empty too", () => {
		const span = toolSpan({
			spanId: "t",
			startMs: 0,
			durationMs: 1,
			statusCode: "Error",
			statusMessage: "Tool execution failed",
		})
		expect(failureDetailText(span)).toBe("Tool execution failed")
	})

	it("says nothing for a span that recorded nothing", () => {
		const span = llmSpan({ spanId: "l", startMs: 0, durationMs: 1, statusCode: "Error" })
		expect(failureDetailText(span)).toBeUndefined()
	})

	it("says nothing when the status message only repeats the error type", () => {
		const span = toolSpan({
			spanId: "t",
			startMs: 0,
			durationMs: 1,
			statusCode: "Error",
			statusMessage: "tool_error",
			genAi: { errorType: "tool_error" },
		})
		expect(rawFailureText(span)).toBeUndefined()
		expect(failureDetailText(span)).toBeUndefined()
	})

	it("keeps a stack's first line and clips it", () => {
		const span = toolSpan({
			spanId: "t",
			startMs: 0,
			durationMs: 1,
			statusCode: "Error",
			statusMessage: `${"x".repeat(200)}\n    at Object.<anonymous>`,
		})
		const detail = failureDetailText(span)!
		expect(detail).toHaveLength(140)
		expect(detail.endsWith("…")).toBe(true)
		expect(detail.includes("\n")).toBe(false)
	})
})
