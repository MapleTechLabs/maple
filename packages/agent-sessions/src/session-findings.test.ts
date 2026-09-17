import { describe, expect, it } from "vitest"

import { buildSessionFindings } from "./session-findings"
import { buildSessionSummary } from "./session-summary"
import { buildSessionTurns } from "./session-turns"
import { agentSpan, llmSpan, makeSpan, toolSpan } from "./span-test-support"

const SECOND = 1000
const MINUTE = 60 * SECOND

function report(spans: Parameters<typeof buildSessionTurns>[0]) {
	const turns = buildSessionTurns(spans)
	return buildSessionFindings(turns, buildSessionSummary({ spans, turns }))
}

/** Two conversation-keyed turns so a failure can be terminal or recovered. */
function twoTurns(secondTurn: readonly Parameters<typeof buildSessionTurns>[0][number][]) {
	return [
		agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND, genAi: { conversationId: "t1" } }),
		llmSpan({
			spanId: "l1",
			parentSpanId: "a1",
			startMs: SECOND,
			durationMs: SECOND,
			model: "claude-opus-5",
			genAi: { conversationId: "t1", usageInputTokens: 1000, usageOutputTokens: 100 },
		}),
		...secondTurn,
	]
}

describe("buildSessionFindings", () => {
	it("calls a clean session clean, with no findings and every turn clean", () => {
		const clean = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		expect(clean.verdict.status).toBe("clean")
		expect(clean.findings).toEqual([])
	})

	it("names the span the final turn died on, not the retry before it", () => {
		const failed = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					statusCode: "Error",
					statusMessage: "prompt is too long",
					genAi: { conversationId: "t2", errorType: "context_length_exceeded" },
				}),
				llmSpan({
					spanId: "l-429",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "429 Too Many Requests",
					genAi: { conversationId: "t2" },
				}),
				llmSpan({
					spanId: "l-ctx",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + 3 * SECOND,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "prompt is too long",
					genAi: {
						conversationId: "t2",
						errorType: "context_length_exceeded",
						usageInputTokens: 190_000,
					},
				}),
			]),
		)

		expect(failed.verdict).toEqual({
			status: "failed",
			label: "context_length_exceeded",
			spanId: "l-ctx",
		})
		// The terminal failure leads the list; the rate limit is its own finding.
		expect(failed.findings[0]!.label).toBe("context_length_exceeded")
		expect(failed.findings[0]!.severity).toBe("failure")
		expect(failed.findings[0]!.turnText).toBe("Turn 2 (final)")
		expect(failed.findings.some((finding) => finding.label === "rate_limit")).toBe(true)
	})

	it("tells the context story as prompt growth across the session's calls", () => {
		const failed = report(
			twoTurns([
				llmSpan({
					spanId: "l-ctx",
					startMs: 5 * MINUTE,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "prompt is too long",
					genAi: {
						conversationId: "t2",
						errorType: "context_length_exceeded",
						usageInputTokens: 190_000,
					},
				}),
			]),
		)

		expect(failed.findings[0]!.detail).toBe("prompt grew 1.0K → 190.0K tokens across the session")
	})

	it("groups a tool's failures into one finding, counted, with the error text", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 20 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				toolSpan({
					spanId: "t-1",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					toolName: "run_tests",
					statusCode: "Error",
					statusMessage: "exit 1",
					genAi: { conversationId: "t2" },
				}),
				toolSpan({
					spanId: "t-2",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + 4 * SECOND,
					durationMs: SECOND,
					toolName: "run_tests",
					statusCode: "Error",
					statusMessage: "exit 1",
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		// The last turn's root closed cleanly, so the session completed — with the
		// failures on record.
		expect(result.verdict.status).toBe("attention")
		const finding = result.findings.find((entry) => entry.label === "error · run_tests")!
		expect(finding.severity).toBe("failure")
		expect(finding.count).toBe(2)
		expect(finding.detail).toBe("exit 1")
		expect(finding.spanId).toBe("t-1")
	})

	// The shape Maple's own agent emits: a failed tool call is a VALUE on an Ok
	// span — `error.type: tool_error`, the message in `gen_ai.tool.call.result`,
	// and no status message at all.
	it("reads the error from the tool call's recorded result when status says nothing", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				toolSpan({
					spanId: "t-silent",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					toolName: "query_data",
					genAi: {
						conversationId: "t2",
						errorType: "tool_error",
						toolCallResult: "Query failed: unknown table trace_spans",
					},
				}),
			]),
		)

		// "unknown table" is the model naming a table that does not exist: the
		// tool refused its arguments, and the label says so.
		const finding = result.findings.find((entry) => entry.label === "tool_arguments · query_data")!
		expect(finding.detail).toBe("Query failed: unknown table trace_spans")
		expect(finding.severity).toBe("anomaly")
	})

	// The exact shape Maple's `toolCallJson` records for a failing tool: the
	// error string wrapped as `{result}`.
	it("unwraps the {result} envelope Maple's own agent records", () => {
		const result = report(
			twoTurns([
				toolSpan({
					spanId: "t-envelope",
					startMs: 5 * MINUTE,
					durationMs: SECOND,
					toolName: "query_data",
					genAi: {
						conversationId: "t2",
						errorType: "tool_error",
						toolCallResult: {
							result: 'Tool failed: Invalid parameters: SchemaError(Expected a number, or omit the parameter (an empty string is not a number)\n  at ["apdex_threshold_ms"])',
						},
					},
				}),
			]),
		)

		// A parameter schema error is the model's arguments failing the tool's
		// schema: the row names the parameter rather than quoting the JSON path.
		const finding = result.findings.find((entry) => entry.label === "tool_arguments · query_data")!
		expect(finding.detail).toBe(
			"invalid arguments: `apdex_threshold_ms`: expected a number, or omit the parameter (an empty string is not a number)",
		)
	})

	it("digs a wrapped error message out of a structured tool result", () => {
		const result = report(
			twoTurns([
				toolSpan({
					spanId: "t-wrapped",
					startMs: 5 * MINUTE,
					durationMs: SECOND,
					toolName: "query_data",
					genAi: {
						conversationId: "t2",
						errorType: "tool_error",
						toolCallResult: {
							isError: true,
							content: [{ type: "text", text: "shard 3 is locked" }],
						},
					},
				}),
			]),
		)

		const finding = result.findings.find((entry) => entry.label === "tool_error · query_data")!
		expect(finding.detail).toBe("shard 3 is locked")
	})

	it("marks a recovered rate limit as an anomaly, not a failure", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				llmSpan({
					spanId: "l-429",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "429 Too Many Requests",
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		expect(result.verdict.status).toBe("attention")
		const finding = result.findings.find((entry) => entry.label === "rate_limit")!
		expect(finding.severity).toBe("anomaly")
	})

	it("flags a cut-off reply once, at the deepest span that said so", () => {
		const result = report(
			twoTurns([
				// The framework copies the model call's finish reason onto the agent
				// span wrapping it: one truncation, not two.
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2", responseFinishReasons: ["length"] },
				}),
				llmSpan({
					spanId: "l-cut",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					genAi: { conversationId: "t2", responseFinishReasons: ["length"] },
				}),
			]),
		)

		const finding = result.findings.find((entry) => entry.label === "stop length")!
		expect(finding.count).toBe(1)
		expect(finding.spanId).toBe("l-cut")
		expect(finding.severity).toBe("anomaly")
	})

	it("flags the same tool called eight times within one turn, and not seven", () => {
		const callsOf = (count: number) =>
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 60 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				...Array.from({ length: count }, (_, index) =>
					toolSpan({
						spanId: `loop-${index}`,
						parentSpanId: "a2",
						startMs: 5 * MINUTE + index * SECOND,
						durationMs: 500,
						toolName: "search",
						genAi: { conversationId: "t2" },
					}),
				),
			])

		const flagged = report(callsOf(8)).findings.find((entry) => entry.label === "search")
		expect(flagged?.detail).toBe("called 8× within one turn")
		expect(flagged?.spanId).toBe("loop-0")

		expect(report(callsOf(7)).findings).toEqual([])
	})

	it("flags a stall inside a turn, never the pause between turns", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 2 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				// 58s hole inside turn 2, after the anchor closed.
				toolSpan({
					spanId: "t-late",
					startMs: 6 * MINUTE,
					durationMs: SECOND,
					toolName: "read_file",
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		const stall = result.findings.find((entry) => entry.label.startsWith("idle"))!
		expect(stall.label).toBe("idle 58s")
		expect(stall.turnText).toBe("Turn 2")
		// The five-minute pause between the turns is the user thinking: no finding.
		expect(result.findings.filter((entry) => entry.label.startsWith("idle"))).toHaveLength(1)
	})

	// The shape effect-agent records for a failed tool: a generic status message
	// on the tool span, the real reason in the recorded result, and the app's own
	// service and client spans under it each errored with a variant of the text.
	it("reads a tool failure off its recorded result, not the framework's generic message, and counts it once", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				toolSpan({
					spanId: "t-grep",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					toolName: "sandbox_grep",
					statusCode: "Error",
					statusMessage:
						"effect-agent.execute_tool: Tool execution reached a failed terminal state",
					genAi: {
						conversationId: "t2",
						toolCallResult: {
							result: "Tool failed: @maple/mcp/errors/McpQueryError: @maple/http/errors/IntegrationsUpstreamError: GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
						},
					},
				}),
				makeSpan({
					spanId: "app-registry",
					parentSpanId: "t-grep",
					spanName: "McpToolRegistry.execute",
					startMs: 5 * MINUTE + SECOND,
					durationMs: 900,
					isAiSpan: false,
					statusCode: "Error",
					statusMessage:
						"@maple/http/errors/IntegrationsUpstreamError: GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
				}),
				makeSpan({
					spanId: "app-vcs",
					parentSpanId: "app-registry",
					spanName: "VcsSourceService.resolveCheckout",
					startMs: 5 * MINUTE + SECOND,
					durationMs: 800,
					isAiSpan: false,
					statusCode: "Error",
					statusMessage:
						"GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
				}),
			]),
		)

		expect(result.findings.map((finding) => [finding.label, finding.count])).toEqual([
			["tool_unavailable · sandbox_grep", 1],
		])
		expect(result.findings[0]!.detail).toBe(
			"GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
		)
		expect(result.findings[0]!.severity).toBe("failure")
	})

	it("names the tool a parameter error is about, not the sibling stamped on the span", () => {
		const result = report(
			twoTurns([
				toolSpan({
					spanId: "t-misnamed",
					startMs: 5 * MINUTE,
					durationMs: SECOND,
					toolName: "inspect_span",
					statusCode: "Error",
					statusMessage:
						'Tool failed: Invalid parameters: SchemaError(Missing key\n  at ["pattern"]). Check the "sandbox_grep" tool schema for valid parameter names.',
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		expect(result.findings.map((finding) => [finding.label, finding.detail])).toEqual([
			["tool_arguments · sandbox_grep", "invalid arguments: missing key `pattern`"],
		])
	})

	it("reads a rejected structured output as the field the model left out", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				llmSpan({
					spanId: "l-schema",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage:
						'LanguageModel.streamText: Invalid output: Missing key\n  at [2]["params"]["suggestedActions"]',
					genAi: { conversationId: "t2", errorType: "invalid_output" },
				}),
			]),
		)

		const finding = result.findings.find((entry) => entry.label === "invalid_output")!
		expect(finding.detail).toBe("output rejected by schema: missing key `suggestedActions`")
		expect(finding.severity).toBe("failure")
	})

	// OpenRouter Broadcast: one generation, a child span per provider it tried,
	// each failed attempt stamped with its status and provider. The generation
	// succeeded, so the attempts are a retry row — never `error ×11`.
	it("rolls a gateway's failed provider attempts into one retry row when the call recovered", () => {
		const attempt = (id: string, status: number, provider: string, startMs: number) =>
			llmSpan({
				spanId: id,
				parentSpanId: "gen",
				traceId: "mirror",
				vendorId: "openrouter",
				spanName: `provider attempt ${id.slice(-1)}: ${provider}`,
				startMs,
				durationMs: 200,
				statusCode: "Error",
				genAi: {
					attemptIndex: Number(id.slice(-1)),
					attemptStatusCode: status,
					attemptProvider: provider,
				},
			})
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				llmSpan({
					spanId: "gen",
					traceId: "mirror",
					vendorId: "openrouter",
					spanName: "LLM Generation",
					startMs: 5 * MINUTE + SECOND,
					durationMs: 2 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				attempt("att-0", 429, "Fireworks", 5 * MINUTE + SECOND),
				attempt("att-1", 429, "Crusoe", 5 * MINUTE + SECOND + 300),
				attempt("att-2", 502, "Friendli", 5 * MINUTE + SECOND + 600),
			]),
		)

		expect(result.verdict.status).toBe("attention")
		expect(result.findings.map((finding) => [finding.label, finding.count, finding.severity])).toEqual([
			["provider_retry", 3, "anomaly"],
		])
		expect(result.findings[0]!.detail).toBe(
			"429 ×2 · 502 ×1 — Crusoe, Fireworks, Friendli · all recovered",
		)
		expect(result.findings[0]!.spanId).toBe("att-0")
	})

	it("keeps the generation that ran out of providers as its own provider_error", () => {
		const result = report(
			twoTurns([
				llmSpan({
					spanId: "gen",
					traceId: "mirror",
					vendorId: "openrouter",
					spanName: "LLM Generation",
					startMs: 5 * MINUTE,
					durationMs: 2 * SECOND,
					statusCode: "Error",
					statusMessage: "Provider returned error",
					genAi: { conversationId: "t2" },
				}),
				llmSpan({
					spanId: "att-0",
					parentSpanId: "gen",
					traceId: "mirror",
					vendorId: "openrouter",
					spanName: "provider attempt 1: Together",
					startMs: 5 * MINUTE,
					durationMs: 200,
					statusCode: "Error",
					genAi: { attemptIndex: 0, attemptStatusCode: 503, attemptProvider: "Together" },
				}),
			]),
		)

		expect(result.findings.map((finding) => [finding.label, finding.detail])).toEqual([
			["provider_error", "Provider returned error"],
			["provider_retry", "503 ×1 — Together · 1 of 1 calls did not recover"],
		])
	})

	// The app's own traffic in the agent's traces: an MCP client probing the
	// server with a GET it answers 405 to, nine times. Not the agent failing.
	it("never reads the app's failed client spans as the agent's failures", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				// Both spellings the warehouse uses for the kind.
				...[0, 1, 2].map((index) =>
					makeSpan({
						spanId: `probe-${index}`,
						parentSpanId: "a2",
						spanName: "GET",
						spanKind: index === 0 ? "SPAN_KIND_CLIENT" : "Client",
						startMs: 5 * MINUTE + index * SECOND,
						durationMs: 100,
						isAiSpan: false,
						statusCode: "Error",
					}),
				),
			]),
		)

		expect(result.verdict.status).toBe("clean")
		expect(result.findings).toEqual([])
	})

	it("keeps an app failure no agent span restates, as the only record of it", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				makeSpan({
					spanId: "store",
					parentSpanId: "a2",
					spanName: "SessionStore.load",
					startMs: 5 * MINUTE + SECOND,
					durationMs: 100,
					isAiSpan: false,
					statusCode: "Error",
					statusMessage: "connection reset",
				}),
			]),
		)

		expect(result.findings.map((finding) => [finding.label, finding.detail])).toEqual([
			["error", "connection reset"],
		])
	})

	// A run that ended without its required completion tool, recorded on the
	// framework's run span rather than on any AI span.
	it("names the completion tool a run ended without calling", () => {
		const result = report(
			twoTurns([
				makeSpan({
					spanId: "run",
					spanName: "AgentRuntime.run",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					isAiSpan: false,
					statusCode: "Error",
					statusMessage:
						"ModelProtocolError: Model stopped without required completion Tool submit_plan",
					genAi: { conversationId: "t2" },
				}),
				llmSpan({
					spanId: "l-ok",
					parentSpanId: "run",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		expect(result.findings.map((finding) => [finding.label, finding.detail])).toEqual([
			["incomplete", "ended without calling `submit_plan`"],
		])
	})

	it("reads a provider's failure as provider_error, with the framework's prefix dropped", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				llmSpan({
					spanId: "l-prov",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage:
						"Model response failed: Upstream error from NextBit: upstream model did not return a valid response",
					genAi: { conversationId: "t2", errorType: "provider_error", responseStatus: "failed" },
				}),
			]),
		)

		expect(result.findings.map((finding) => [finding.label, finding.detail])).toEqual([
			["provider_error", "Upstream error from NextBit: upstream model did not return a valid response"],
		])
	})

	// The app observes a call and a gateway mirrors it: two failed spans, one
	// response id. The one that says why is the one that stays.
	it("counts a failed call observed by the app and by a gateway mirror once", () => {
		const result = report(
			twoTurns([
				llmSpan({
					spanId: "l-app",
					startMs: 5 * MINUTE,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "Model response failed: Network connection lost.",
					genAi: { conversationId: "t2", errorType: "provider_error", responseId: "gen-1" },
				}),
				llmSpan({
					spanId: "l-mirror",
					traceId: "mirror",
					vendorId: "openrouter",
					spanName: "LLM Generation",
					startMs: 5 * MINUTE,
					durationMs: SECOND,
					statusCode: "Error",
					genAi: { responseId: "gen-1" },
				}),
			]),
		)

		expect(result.findings.map((finding) => [finding.label, finding.count, finding.detail])).toEqual([
			["provider_error", 1, "Network connection lost."],
		])
	})
})
