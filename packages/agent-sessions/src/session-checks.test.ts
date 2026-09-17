import { describe, expect, it } from "vitest"

import { buildSessionChecks, type SessionCheck } from "./session-checks"
import { buildSessionSummary } from "./session-summary"
import { buildSessionTurns } from "./session-turns"
import { agentSpan, llmSpan, toolSpan } from "./span-test-support"

const SECOND = 1000
const MINUTE = 60 * SECOND

type Spans = Parameters<typeof buildSessionTurns>[0]

function checks(spans: Spans) {
	const turns = buildSessionTurns(spans)
	return buildSessionChecks(turns, buildSessionSummary({ spans, turns }))
}

function byId(report: ReturnType<typeof checks>, id: string): SessionCheck {
	const found = report.checks.find((check) => check.id === id)
	if (found === undefined) throw new Error(`no check ${id}`)
	return found
}

/** A clean opening turn, keyed by conversation id so a second turn can follow. */
function firstTurn(): Spans {
	return [
		agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND, genAi: { conversationId: "t1" } }),
		llmSpan({
			spanId: "l1",
			parentSpanId: "a1",
			startMs: SECOND,
			durationMs: SECOND,
			model: "claude-opus-5",
			genAi: {
				conversationId: "t1",
				usageInputTokens: 1000,
				usageOutputTokens: 100,
				responseFinishReasons: ["stop"],
			},
		}),
	]
}

describe("buildSessionChecks", () => {
	// The five-second answer for a session with nothing wrong: every check
	// passed and says what it measured, so the page reads as inspected.
	it("passes a clean session with the facts each check measured", () => {
		const report = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 10 * SECOND,
				genAi: { conversationId: "t2" },
			}),
			toolSpan({
				spanId: "t2-read",
				parentSpanId: "a2",
				startMs: 5 * MINUTE + SECOND,
				durationMs: 2 * SECOND,
				toolName: "read_file",
				genAi: { conversationId: "t2" },
			}),
		])

		expect(report.verdict.status).toBe("clean")
		expect(report.counts.failed).toBe(0)
		expect(report.counts.warning).toBe(0)
		expect(report.headline).toBe(`cleanly — ${report.counts.passed} checks passed across 2 turns`)
		expect(report.checks.find((check) => check.id === "completion")).toBeUndefined()
		expect(byId(report, "context-window").headline).toBe("The prompt peaked at 1.0K tokens")
		expect(byId(report, "tool-timeouts").headline).toBe(
			"No tool call timed out; the slowest was `read_file` at 2s",
		)
		expect(byId(report, "tool-errors").headline).toBe("1 tool call, none failed")
		// Nothing reported cache usage, so the cache check says so rather than passing.
		expect(byId(report, "prompt-cache").status).toBe("skipped")
		// Passed and skipped rows carry no fix tag: there is nothing to fix.
		expect(report.checks.every((check) => check.status !== "passed" || check.fixArea === undefined)).toBe(
			true,
		)
	})

	it("names the cause of death in the headline, and the cause's own check carries the action", () => {
		const report = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 10 * SECOND,
				statusCode: "Error",
				statusMessage: "prompt is too long: 214832 tokens > 200000 maximum",
				genAi: { conversationId: "t2", errorType: "context_length_exceeded" },
			}),
			llmSpan({
				spanId: "l2",
				parentSpanId: "a2",
				startMs: 5 * MINUTE + SECOND,
				durationMs: SECOND,
				model: "claude-opus-5",
				statusCode: "Error",
				statusMessage: "prompt is too long: 214832 tokens > 200000 maximum",
				genAi: {
					conversationId: "t2",
					errorType: "context_length_exceeded",
					usageInputTokens: 214832,
					usageOutputTokens: 0,
				},
			}),
		])

		expect(report.verdict.status).toBe("failed")
		expect(report.headline).toBe("the final turn died on the context window")
		// The cause leads the list; the outcome is the headline, not a row.
		expect(report.checks[0].id).toBe("context-window")

		const context = byId(report, "context-window")
		expect(context.status).toBe("failed")
		expect(context.headline).toBe(
			"The prompt outgrew the model's context window on turn 2 (final); the prompt grew 1.0K → 214.8K tokens over the session",
		)
		expect(context.action).toMatch(/^Compact or summarise/)
		expect(context.fixArea).toBe("prompt")
		expect(context.findings.map((finding) => finding.spanId)).toEqual(["l2"])
		expect(report.counts.failed).toBe(1)
	})

	it("warns on a failure the session carried past, and says so", () => {
		const report = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 10 * SECOND,
				genAi: { conversationId: "t2" },
			}),
			llmSpan({
				spanId: "l2",
				parentSpanId: "a2",
				startMs: 5 * MINUTE + SECOND,
				durationMs: SECOND,
				model: "claude-opus-5",
				statusCode: "Error",
				statusMessage: "429 Too Many Requests",
				genAi: { conversationId: "t2", errorType: "429" },
			}),
			llmSpan({
				spanId: "l3",
				parentSpanId: "a2",
				startMs: 5 * MINUTE + 3 * SECOND,
				durationMs: SECOND,
				model: "claude-opus-5",
				genAi: { conversationId: "t2", usageInputTokens: 1200, usageOutputTokens: 80 },
			}),
		])

		expect(report.verdict.status).toBe("attention")
		expect(report.headline).toBe("with 1 warning")
		const limits = byId(report, "rate-limits")
		expect(limits.status).toBe("warning")
		expect(limits.headline).toBe("1 model call was rate-limited on turn 2; the session carried on")
		expect(limits.fixArea).toBe("provider")
		expect(report.checks[0].id).toBe("rate-limits")
	})

	// A tool that cannot run needs fixing whether or not the run survived it,
	// and the fix is an integration, not the prompt.
	it("fails tool availability outright and names the integration as the fix", () => {
		const report = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 10 * SECOND,
				genAi: { conversationId: "t2" },
			}),
			toolSpan({
				spanId: "t2-grep",
				parentSpanId: "a2",
				startMs: 5 * MINUTE + SECOND,
				durationMs: SECOND,
				toolName: "sandbox_grep",
				statusCode: "Error",
				statusMessage: "GitHub App not configured for this organisation",
				genAi: { conversationId: "t2", errorType: "tool_error" },
			}),
		])

		expect(report.headline).toBe("but 1 check failed")
		const availability = byId(report, "tool-availability")
		expect(availability.status).toBe("failed")
		expect(availability.headline).toBe(
			"`sandbox_grep` could not run on turn 2: GitHub App not configured for this organisation; the session carried on",
		)
		expect(availability.fixArea).toBe("integration")
	})

	it("lists several failed tools in one headline, in the order they failed", () => {
		const report = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 20 * SECOND,
				genAi: { conversationId: "t2" },
			}),
			toolSpan({
				spanId: "t2-tests",
				parentSpanId: "a2",
				startMs: 5 * MINUTE + SECOND,
				durationMs: SECOND,
				toolName: "run_tests",
				statusCode: "Error",
				statusMessage: "exit 1",
				genAi: { conversationId: "t2", errorType: "tool_error" },
			}),
			toolSpan({
				spanId: "t2-shard",
				parentSpanId: "a2",
				startMs: 5 * MINUTE + 5 * SECOND,
				durationMs: SECOND,
				toolName: "reindex_shard",
				statusCode: "Error",
				statusMessage: "shard 3 is locked by a running merge",
				genAi: { conversationId: "t2", errorType: "SHARD_LOCKED" },
			}),
			llmSpan({
				spanId: "l2",
				parentSpanId: "a2",
				startMs: 5 * MINUTE + 8 * SECOND,
				durationMs: SECOND,
				model: "claude-opus-5",
				genAi: { conversationId: "t2" },
			}),
		])

		const errors = byId(report, "tool-errors")
		expect(errors.status).toBe("warning")
		expect(errors.headline).toBe(
			"2 tool calls failed: `run_tests` (exit 1, turn 2), `reindex_shard` (shard 3 is locked by a running merge, turn 2); the session carried on",
		)
		expect(errors.findings).toHaveLength(2)
	})

	// Three identical calls in a row is a loop however few calls the tool made
	// in total; a re-run with something between them is not.
	it("warns on the same call repeated back to back, and not on a re-run after other work", () => {
		const read = (spanId: string, startMs: number, path: string) =>
			toolSpan({
				spanId,
				parentSpanId: "a2",
				startMs,
				durationMs: SECOND,
				toolName: "read_file",
				genAi: { conversationId: "t2", toolCallArguments: { path, start_line: 1 } },
			})
		const looped = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 20 * SECOND,
				genAi: { conversationId: "t2" },
			}),
			read("r1", 5 * MINUTE + SECOND, "src/retry.ts"),
			read("r2", 5 * MINUTE + 3 * SECOND, "src/retry.ts"),
			read("r3", 5 * MINUTE + 5 * SECOND, "src/retry.ts"),
		])
		const repetition = byId(looped, "repetition")
		expect(repetition.status).toBe("warning")
		expect(repetition.headline).toBe(
			"`read_file` was called 3× within one turn, 3 in a row with identical arguments on turn 2",
		)
		expect(repetition.findings[0].spanId).toBe("r1")

		const rerun = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 20 * SECOND,
				genAi: { conversationId: "t2" },
			}),
			read("r1", 5 * MINUTE + SECOND, "src/retry.ts"),
			read("r2", 5 * MINUTE + 3 * SECOND, "src/other.ts"),
			read("r3", 5 * MINUTE + 5 * SECOND, "src/retry.ts"),
		])
		expect(byId(rerun, "repetition").status).toBe("passed")

		// Another tool between two identical reads is work between them too.
		const interleaved = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 20 * SECOND,
				genAi: { conversationId: "t2" },
			}),
			read("r1", 5 * MINUTE + SECOND, "src/retry.ts"),
			toolSpan({
				spanId: "w1",
				parentSpanId: "a2",
				startMs: 5 * MINUTE + 2 * SECOND,
				durationMs: SECOND,
				toolName: "write_file",
				genAi: { conversationId: "t2", toolCallArguments: { path: "src/retry.ts" } },
			}),
			read("r2", 5 * MINUTE + 4 * SECOND, "src/retry.ts"),
			read("r3", 5 * MINUTE + 6 * SECOND, "src/retry.ts"),
		])
		expect(byId(interleaved, "repetition").status).toBe("passed")
	})

	// One unchanged retry after a failure is how a transient error is handled;
	// two is the retry that learned nothing — and it is the failing run the row
	// names, not an earlier run of the same length that succeeded.
	it("names the run that kept retrying after a failure, not the equal run that worked", () => {
		const run = (spanId: string, startMs: number, suite: string, failed = false) =>
			toolSpan({
				spanId,
				parentSpanId: "a2",
				startMs,
				durationMs: SECOND,
				toolName: "run_tests",
				statusCode: failed ? "Error" : "Unset",
				statusMessage: failed ? "exit 1" : "",
				genAi: { conversationId: "t2", toolCallArguments: { suite } },
			})
		const once = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 30 * SECOND,
				genAi: { conversationId: "t2" },
			}),
			run("t1", 5 * MINUTE + SECOND, "webhooks", true),
			run("t2", 5 * MINUTE + 3 * SECOND, "webhooks"),
		])
		expect(byId(once, "repetition").status).toBe("passed")

		const looped = checks([
			...firstTurn(),
			agentSpan({
				spanId: "a2",
				startMs: 5 * MINUTE,
				durationMs: 30 * SECOND,
				genAi: { conversationId: "t2" },
			}),
			run("ok1", 5 * MINUTE + SECOND, "billing"),
			run("ok2", 5 * MINUTE + 2 * SECOND, "billing"),
			run("ok3", 5 * MINUTE + 3 * SECOND, "billing"),
			run("f1", 5 * MINUTE + 5 * SECOND, "webhooks", true),
			run("f2", 5 * MINUTE + 7 * SECOND, "webhooks", true),
			run("f3", 5 * MINUTE + 9 * SECOND, "webhooks", true),
		])
		const repetition = byId(looped, "repetition")
		expect(repetition.headline).toBe("`run_tests` was retried 2× unchanged after it failed on turn 2")
		expect(repetition.findings[0].spanId).toBe("f1")
	})

	it("reads the prompt cache off the calls after the first, and skips when nothing reported one", () => {
		const call = (spanId: string, startMs: number, cacheRead: number) =>
			llmSpan({
				spanId,
				parentSpanId: "a1",
				startMs,
				durationMs: SECOND,
				model: "claude-opus-5",
				genAi: {
					conversationId: "t1",
					// Inclusive of the cache read, as the default convention counts it.
					usageInputTokens: 10_000,
					usageCacheReadInputTokens: cacheRead,
					usageOutputTokens: 100,
				},
			})
		const cold = checks([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: MINUTE, genAi: { conversationId: "t1" } }),
			call("c1", SECOND, 0),
			call("c2", 5 * SECOND, 1_000),
			call("c3", 10 * SECOND, 0),
			call("c4", 15 * SECOND, 2_000),
		])
		const cache = byId(cold, "prompt-cache")
		expect(cache.status).toBe("warning")
		expect(cache.headline).toBe("Cache hit rate 10% over 3 calls; 3 missed the cache")
		expect(cache.action).toMatch(/prompt prefix stable/)

		const warm = checks([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: MINUTE, genAi: { conversationId: "t1" } }),
			call("c1", SECOND, 0),
			call("c2", 5 * SECOND, 9_000),
			call("c3", 10 * SECOND, 9_000),
			call("c4", 15 * SECOND, 8_000),
		])
		expect(byId(warm, "prompt-cache").headline).toBe("Cache hit rate 87% over 3 calls")

		expect(byId(checks(firstTurn()), "prompt-cache").status).toBe("skipped")
	})

	it("reports what the instrumentation captured, so a skipped check can say what to turn on", () => {
		const report = checks([
			...firstTurn(),
			toolSpan({
				spanId: "t1-read",
				parentSpanId: "a1",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				toolName: "read_file",
				genAi: { conversationId: "t1" },
			}),
		])

		expect(report.coverage).toEqual({
			messages: false,
			toolPayloads: false,
			usage: "per-call",
			cost: false,
			// One conversation id alone is no turn key; the agent root opens the turn.
			turns: "agent-root",
		})
	})
})
