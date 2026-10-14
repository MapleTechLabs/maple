import { describe, expect, it } from "vitest"

import { buildSessionChecks } from "./session-checks"
import { buildSessionSummary } from "./session-summary"
import { buildTranscript } from "./session-transcript"
import { buildSessionTurns } from "./session-turns"
import { sessionToolResults } from "./span-detail"
import { agentSpan, llmSpan, makeSpan, toolSpan, userMessages } from "./span-test-support"

const SECOND = 1000
const RUN_STATUS = "<run-status>turn 1/100 · tool-calls 0/100 · elapsed 0s/240s</run-status>"

/**
 * The shape of a Maple pr-review session: the orchestrator delegates through a
 * `review_files` tool, and the runtime spawns each worker under the app's own
 * spans, so every worker is an agent root. Three start in the same millisecond;
 * two are stopped by the framework on a budget.
 */
function prReviewSpans() {
	const worker = (n: number, opts: { statusMessage?: string; durationMs: number }) => {
		const id = `worker-${n}`
		return [
			makeSpan({
				spanId: `spawn-${n}`,
				parentSpanId: "turn",
				spanName: "SubagentRuntime.review_files",
				startMs: 5 * SECOND,
				durationMs: opts.durationMs,
				isAiSpan: false,
			}),
			agentSpan({
				spanId: id,
				parentSpanId: `spawn-${n}`,
				agentName: "pr-review-worker",
				startMs: 5 * SECOND,
				durationMs: opts.durationMs,
				statusCode: opts.statusMessage === undefined ? "Unset" : "Error",
				statusMessage: opts.statusMessage ?? "",
			}),
			// The runtime wraps every model call in an app span of its own, which restates
			// the run's failure when the run is stopped mid-call.
			makeSpan({
				spanId: `${id}-model`,
				parentSpanId: id,
				spanName: "AgentRuntime.model",
				startMs: 5 * SECOND + 100 * n,
				durationMs: SECOND,
				isAiSpan: false,
				statusCode: opts.statusMessage === undefined ? "Unset" : "Error",
				statusMessage: opts.statusMessage ?? "",
			}),
			llmSpan({
				spanId: `${id}-chat`,
				parentSpanId: `${id}-model`,
				startMs: 5 * SECOND + 100 * n,
				durationMs: SECOND,
				model: "deepseek",
				genAi: {
					inputMessages: [
						...userMessages(`Review files batch ${n}`),
						{ role: "user", parts: [{ type: "text", content: RUN_STATUS }] },
					],
				},
			}),
			toolSpan({
				spanId: `${id}-read`,
				parentSpanId: id,
				toolName: "sandbox_read_file",
				startMs: 7 * SECOND + 100 * n,
				durationMs: SECOND,
			}),
		]
	}
	return [
		makeSpan({
			spanId: "turn",
			spanName: "chat.turn",
			startMs: 0,
			durationMs: 300 * SECOND,
			isAiSpan: false,
		}),
		agentSpan({
			spanId: "orchestrator",
			parentSpanId: "turn",
			agentName: "pr-review",
			startMs: SECOND,
			durationMs: 290 * SECOND,
		}),
		llmSpan({
			spanId: "orchestrator-chat",
			parentSpanId: "orchestrator",
			startMs: 2 * SECOND,
			durationMs: SECOND,
			genAi: {
				inputMessages: [
					{ role: "user", parts: [{ type: "text", content: `${RUN_STATUS}\n\nReview PR #42` }] },
				],
			},
		}),
		toolSpan({
			spanId: "delegate",
			parentSpanId: "orchestrator",
			toolName: "review_files",
			startMs: 5 * SECOND,
			durationMs: 240 * SECOND,
		}),
		...worker(1, { durationMs: 240 * SECOND, statusMessage: "Agent exceeded its 4m duration limit" }),
		...worker(2, {
			durationMs: 90 * SECOND,
			statusMessage: "Agent reached its 3 consecutive Tool Call failure limit",
		}),
		...worker(3, { durationMs: 200 * SECOND }),
		...worker(4, { durationMs: 240 * SECOND, statusMessage: "Agent exceeded its 4m duration limit" }),
		// The orchestrator's own rejected delegation: an app span under the request, no agent above it.
		makeSpan({
			spanId: "rejected-delegation",
			parentSpanId: "turn",
			spanName: "SubagentRuntime.review_files",
			startMs: 6 * SECOND,
			durationMs: 5,
			isAiSpan: false,
			statusCode: "Error",
			statusMessage: "review_files takes 1 to 12 paths per group; got 15",
		}),
		toolSpan({
			spanId: "worker-3-bad-args",
			parentSpanId: "worker-3",
			toolName: "sandbox_read_file",
			startMs: 9 * SECOND,
			durationMs: 10,
			statusCode: "Error",
			genAi: {
				operationName: "execute_tool",
				toolName: "sandbox_read_file",
				errorType: "ToolCallFailed",
				toolCallResult: {
					result: "Invalid parameters for `sandbox_read_file`:\n- Missing required `repository` (string): Connected repository in owner/name form",
				},
			},
		}),
	]
}

describe("a sub-agent fan-out", () => {
	const spans = prReviewSpans()
	const turns = buildSessionTurns(spans)
	const summary = buildSessionSummary({ spans, turns })
	const report = buildSessionChecks(turns, summary)

	it("gives every worker its own turn, holding its own spans", () => {
		expect(turns.map((turn) => turn.agentName)).toEqual([
			"pr-review",
			"pr-review-worker",
			"pr-review-worker",
			"pr-review-worker",
			"pr-review-worker",
		])
		for (const n of [1, 2, 3, 4]) {
			const turn = turns.find((candidate) => candidate.anchor.spanId === `worker-${n}`)
			expect(turn, `worker-${n}`).toBeDefined()
			const ids = turn!.spans.map((span) => span.spanId)
			expect(ids).toContain(`worker-${n}-chat`)
			expect(ids).toContain(`worker-${n}-read`)
			// No other worker's work landed here.
			expect(ids.filter((id) => id.startsWith("worker-") && !id.startsWith(`worker-${n}`))).toEqual([])
		}
	})

	it("fails the turns whose run was stopped", () => {
		const failed = Object.fromEntries(turns.map((turn) => [turn.anchor.spanId, turn.failed]))
		expect(failed).toEqual({
			orchestrator: false,
			"worker-1": true,
			"worker-2": true,
			"worker-3": false,
			"worker-4": true,
		})
	})

	it("names each budget the framework stopped a run on, as a failed check", () => {
		const limits = report.checks.find((check) => check.id === "agent-limits")
		expect(limits?.status).toBe("failed")
		expect(limits?.headline).toContain("duration limit")
		expect(limits?.headline).toContain("consecutive tool call failure limit")
		expect(limits?.findings.map((finding) => finding.label).sort()).toEqual([
			"agent_limit · consecutive tool call failure limit",
			"agent_limit · duration limit",
		])
	})

	it("keeps the reason a tool rejected its arguments, not just the heading over it", () => {
		const args = report.checks.find((check) => check.id === "tool-arguments")
		expect(args?.headline).toContain("Missing required `repository`")
	})

	it("labels turns by what was asked, not the framework's status block", () => {
		expect(turns[0]?.label).toBe("Review PR #42")
		expect(turns[1]?.label).toBe("Review files batch 1")
		expect(summary.title).not.toContain("<run-status>")
	})
})

describe("a sub-agent fan-out, read closely", () => {
	const spans = prReviewSpans()
	const turns = buildSessionTurns(spans)
	const summary = buildSessionSummary({ spans, turns })
	const report = buildSessionChecks(turns, summary)
	const turnOf = (spanId: string) => turns.find((turn) => turn.spans.some((span) => span.spanId === spanId))

	it("counts every stopped run, though the runtime's wrapper restates the failure", () => {
		const duration = report.checks
			.find((check) => check.id === "agent-limits")
			?.findings.find((finding) => finding.label === "agent_limit · duration limit")
		expect(duration?.count).toBe(2)
	})

	it("files spans no agent is above under the run open around them, not the last sub-agent", () => {
		expect(turnOf("rejected-delegation")?.anchor.spanId).toBe("orchestrator")
		expect(turnOf("spawn-1")?.anchor.spanId).toBe("orchestrator")
		// So a worker's turn measures the worker, not the spawns beside it.
		expect(turnOf("worker-2")?.durationMs).toBe(90 * SECOND)
	})

	it("judges the session by the turn that ended last: the orchestrator outlived its workers", () => {
		expect(summary.failed).toBe(false)
	})

	it("reads a worker's model call before its tool calls, through the runtime's wrapper", () => {
		const worker = turnOf("worker-1")!
		const rows = buildTranscript({
			turns: [worker],
			toolResults: sessionToolResults(spans),
			query: "",
			showThinking: false,
			hasMore: false,
			collapsedTurns: new Set(),
		})
		const kinds = rows.map((row) => row.kind).filter((kind) => kind === "user" || kind === "tool")
		expect(kinds[0]).toBe("user")
		const user = rows.find((row) => row.kind === "user")
		expect(user?.kind === "user" ? user.text : "").toBe("Review files batch 1")
	})
})

describe("a sub-agent fan-out's headline", () => {
	it("names the sub-agent runs that failed rather than calling the session completed with failed checks", () => {
		const spans = prReviewSpans()
		const turns = buildSessionTurns(spans)
		const report = buildSessionChecks(turns, buildSessionSummary({ spans, turns }))
		expect(report.headline).toBe("but 3 of 4 sub-agent runs failed")
	})
})
