import { describe, expect, it } from "vitest"
import { summarizeIndexFailures, type IndexFailedSpan } from "./index-failures"

const failed = (overrides: Partial<IndexFailedSpan> & { spanId: string }): IndexFailedSpan => ({
	traceId: "trace-1",
	isToolCall: false,
	isLlmCall: true,
	errorType: "",
	toolName: "",
	vendorId: "eve",
	statusMessage: "",
	failedToolCallResult: "",
	responseId: "",
	atMs: 1_000,
	...overrides,
})

describe("summarizeIndexFailures", () => {
	it("classifies index rows the way the detail page classifies spans, and grades them by the one rule", () => {
		const rows = summarizeIndexFailures(
			[
				failed({ spanId: "a", statusMessage: "429 Too Many Requests", atMs: 1_000 }),
				failed({ spanId: "b", statusMessage: "429 Too Many Requests", atMs: 2_000 }),
				failed({
					spanId: "c",
					isToolCall: true,
					isLlmCall: false,
					toolName: "run_tests",
					errorType: "tool_error",
					statusMessage: "Tool execution failed",
					failedToolCallResult: '{"error":"exit code 1"}',
					atMs: 3_000,
				}),
				failed({
					spanId: "d",
					errorType: "context_length_exceeded",
					statusMessage: "prompt is too long: 210000 tokens > 200000 maximum",
					atMs: 4_000,
				}),
			],
			{ traceId: "trace-1", turnFailed: false },
		)
		expect(rows).toEqual([
			{
				kind: "contextExceeded",
				label: "context_length_exceeded",
				tool: undefined,
				count: 1,
				severity: "failure",
				terminal: false,
			},
			{
				kind: "rateLimited",
				label: "rate_limit",
				tool: undefined,
				count: 2,
				severity: "anomaly",
				terminal: false,
			},
			{
				kind: "error",
				label: "tool_error · run_tests",
				tool: "run_tests",
				count: 1,
				severity: "anomaly",
				terminal: false,
			},
		])
	})

	it("marks the last failure of the last trace terminal when that trace's turn failed, and reds it", () => {
		const rows = summarizeIndexFailures(
			[
				failed({ spanId: "early", traceId: "trace-1", statusMessage: "rate limit", atMs: 1_000 }),
				failed({ spanId: "late", traceId: "trace-2", errorType: "provider_error", atMs: 9_000 }),
				failed({ spanId: "later", traceId: "trace-2", statusMessage: "rate limit", atMs: 9_500 }),
			],
			{ traceId: "trace-2", turnFailed: true },
		)
		// The rate limit the run died on leads, red; the provider error it
		// survived is amber even though it is in the same trace.
		expect(rows.map((row) => [row.label, row.severity, row.terminal, row.count])).toEqual([
			["rate_limit", "failure", true, 2],
			["provider_error", "anomaly", false, 1],
		])
	})

	it("leaves a survived last trace amber whatever it failed on", () => {
		const rows = summarizeIndexFailures(
			[
				failed({
					spanId: "tool",
					isToolCall: true,
					isLlmCall: false,
					toolName: "grep",
					errorType: "tool_error",
				}),
			],
			{ traceId: "trace-1", turnFailed: false },
		)
		expect(rows).toEqual([
			{
				kind: "error",
				label: "tool_error · grep",
				tool: "grep",
				count: 1,
				severity: "anomaly",
				terminal: false,
			},
		])
	})

	it("counts a call the app and a gateway mirror both observed once, keeping the observation that named the cause", () => {
		const rows = summarizeIndexFailures(
			[
				failed({ spanId: "app", responseId: "gen-1", errorType: "provider_error", atMs: 1_000 }),
				failed({
					spanId: "mirror",
					traceId: "mirror-trace",
					vendorId: "openrouter",
					responseId: "gen-1",
					statusMessage: "Provider overloaded, retry later",
					atMs: 1_001,
				}),
			],
			{ traceId: "mirror-trace", turnFailed: false },
		)
		expect(rows).toEqual([
			{
				kind: "rateLimited",
				label: "rate_limit",
				tool: undefined,
				count: 1,
				severity: "anomaly",
				terminal: false,
			},
		])
	})

	it("reads a row that predates migration 0032 as a plain error", () => {
		const rows = summarizeIndexFailures([failed({ spanId: "old" })], {
			traceId: "trace-1",
			turnFailed: false,
		})
		expect(rows).toEqual([
			{
				kind: "error",
				label: "error",
				tool: undefined,
				count: 1,
				severity: "anomaly",
				terminal: false,
			},
		])
	})
})
