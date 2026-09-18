import { describe, expect, it } from "vitest"
import { summarizeIndexFailures, type IndexFailedSpan } from "./index-failures"
import { failureSeverity } from "./session-findings"
import type { SessionFailureKind } from "./session-summary"

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
			"",
		)
		expect(rows).toEqual([
			{
				kind: "contextExceeded",
				label: "context_length_exceeded",
				count: 1,
				severity: "failure",
				terminal: false,
			},
			{ kind: "rateLimited", label: "rate_limit", count: 2, severity: "anomaly", terminal: false },
			{
				kind: "error",
				label: "tool_error · run_tests",
				tool: "run_tests",
				count: 1,
				severity: "anomaly",
				terminal: false,
			},
		])
		// No `tool` key at all on the rows without one: the wire schema's
		// `optionalKey` rejects a present `undefined`.
		expect(Object.hasOwn(rows[0]!, "tool")).toBe(false)
	})

	it("marks the group holding the terminal span, and reds it whatever its kind", () => {
		const rows = summarizeIndexFailures(
			[
				failed({ spanId: "early", traceId: "trace-1", statusMessage: "rate limit", atMs: 1_000 }),
				failed({ spanId: "late", traceId: "trace-2", errorType: "provider_error", atMs: 9_000 }),
				failed({ spanId: "later", traceId: "trace-2", statusMessage: "rate limit", atMs: 9_500 }),
			],
			"later",
		)
		// The rate limit the run died on leads, red, its count whole; the
		// provider error it survived is amber even though it is in the same trace.
		expect(rows.map((row) => [row.label, row.severity, row.terminal, row.count])).toEqual([
			["rate_limit", "failure", true, 2],
			["provider_error", "anomaly", false, 1],
		])
	})

	it("leaves everything amber when the last turn closed cleanly, whatever failed", () => {
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
			"",
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

	it("marks nothing for a terminal span it was not shipped", () => {
		const rows = summarizeIndexFailures(
			[failed({ spanId: "shipped", statusMessage: "rate limit" })],
			"dropped",
		)
		expect(rows.map((row) => [row.severity, row.terminal])).toEqual([["anomaly", false]])
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
			"",
		)
		expect(rows).toEqual([
			{ kind: "rateLimited", label: "rate_limit", count: 1, severity: "anomaly", terminal: false },
		])
	})

	it("finds the terminal span under whichever observation the dedupe kept", () => {
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
			// The query resolved the app's trace as the last one; the mirror's
			// observation is the one the dedupe kept.
			"app",
		)
		expect(rows.map((row) => [row.label, row.severity, row.terminal])).toEqual([
			["rate_limit", "failure", true],
		])
	})

	it("reads a failed tool call's result as the span carries it, JSON where it parses", () => {
		const rows = summarizeIndexFailures(
			[
				failed({
					spanId: "t",
					isToolCall: true,
					isLlmCall: false,
					toolName: "submit_findings",
					errorType: "tool_error",
					failedToolCallResult: JSON.stringify({
						result: 'Invalid tool input: Missing key\n  at ["evidence"][0]["traceIds"]',
					}),
				}),
			],
			"",
		)
		expect(rows.map((row) => row.label)).toEqual(["tool_arguments · submit_findings"])
	})

	it("orders the same rows the same whatever order they arrive in", () => {
		const a = failed({ spanId: "a", statusMessage: "rate limit", atMs: 5_000 })
		const b = failed({ spanId: "b", errorType: "provider_error", atMs: 5_000 })
		expect(summarizeIndexFailures([a, b], "")).toEqual(summarizeIndexFailures([b, a], ""))
	})

	it("reads a row that predates migration 0032 as a plain error", () => {
		const rows = summarizeIndexFailures([failed({ spanId: "old" })], "")
		expect(rows).toEqual([
			{ kind: "error", label: "error", count: 1, severity: "anomaly", terminal: false },
		])
	})
})

describe("failureSeverity", () => {
	it("is the one rule both surfaces grade on", () => {
		const kinds: readonly SessionFailureKind[] = [
			"error",
			"rateLimited",
			"contextExceeded",
			"refusal",
			"providerError",
			"invalidOutput",
			"toolArguments",
			"toolUnavailable",
			"toolTimeout",
			"incomplete",
		]
		expect(Object.fromEntries(kinds.map((kind) => [kind, failureSeverity(kind, false)]))).toEqual({
			error: "anomaly",
			rateLimited: "anomaly",
			contextExceeded: "failure",
			refusal: "anomaly",
			providerError: "anomaly",
			invalidOutput: "failure",
			toolArguments: "anomaly",
			toolUnavailable: "failure",
			toolTimeout: "anomaly",
			incomplete: "failure",
		})
		for (const kind of kinds) expect(failureSeverity(kind, true)).toBe("failure")
	})
})
