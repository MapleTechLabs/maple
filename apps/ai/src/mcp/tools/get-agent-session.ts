import { Effect, Order, Schema, Array as Arr } from "effect"
import { formatWarehouseDateTime, parseWarehouseDateTime, warehouseDateTimeToIso } from "@maple/query-engine"
import {
	AI_EVALUATION_SESSION_MAX_TRACES,
	AI_EVALUATION_SESSION_SCORES_TAIL_MS,
	GetAiSessionEvaluationsRequest,
	type AiEvaluationScore,
	type AiSessionSpan,
	type TenantContext,
} from "@maple/domain/http"
import { AiEvaluationReadService } from "@maple/backend/services/ai-evaluations/AiEvaluationReadService"
import { SESSION_CHECK_SOURCE } from "@maple/backend/services/ai-evaluations/session-check-scores"
import {
	buildSessionChecks,
	buildSessionFindings,
	buildSessionSummary,
	buildSessionTurns,
	formatCost,
} from "@maple/agent-sessions"
import { GetAgentSessionOutput } from "@maple/domain/mcp-outputs"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../tenant"
import { formatDurationFromMs, formatNumber, tableCell, truncate } from "../lib/format"
import {
	loadAgentSessionSpans,
	loadSummary,
	sessionTooLarge,
	sessionWindowFrom,
	sessionWindowParams,
	truncationNote,
} from "../lib/agent-sessions"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"

/** Table ceilings: a session with hundreds of turns is read through its spans, not through a
 *  table of every row. */
const MAX_FINDINGS = 10
const MAX_TOOLS = 15
const MAX_SCORES = 20

/** Characters kept of captured text the output carries (the opening message, a turn's label). */
const CAPTURED_TEXT_CHARS = 500

/** What to do about a session whose first page of spans no read can carry. */
const TRACE_ID = /^[0-9a-f]{32}$/

const WHOLE_SESSION_TOO_LARGE =
	"Read part of it instead: pass a start_time/end_time narrower than the session's own bounds."

type Output = typeof GetAgentSessionOutput.Type

/** Failing scores first, then the rest; each group newest first, as the read returns them. */
const failingFirst = Order.mapInput(Order.Number, (score: AiEvaluationScore) =>
	score.verdict === "fail" ? 0 : 1,
)

/**
 * The session's evaluation scores other than Maple's own checks, or none: an org outside the
 * `llmEvals` rollout has no scores to show, and a failed score read never fails the session read.
 */
const readScores = (
	tenant: TenantContext,
	sessionId: string,
	spans: ReadonlyArray<AiSessionSpan>,
): Effect.Effect<Output["scores"], never, AiEvaluationReadService> =>
	Effect.gen(function* () {
		const traceIds = Arr.take(
			Arr.dedupe(
				Arr.filter(
					Arr.map(spans, (span) => span.traceId),
					(id) => TRACE_ID.test(id),
				),
			),
			AI_EVALUATION_SESSION_MAX_TRACES,
		)
		const times = Arr.map(spans, (span) => parseWarehouseDateTime(span.timestamp))
		const startMs = Arr.reduce(times, Infinity, (min, ms) => Math.min(min, ms))
		const endMs = Arr.reduce(times, -Infinity, (max, ms) => Math.max(max, ms))
		if (traceIds.length === 0 || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined
		const reads = yield* AiEvaluationReadService
		const result = yield* reads.session(
			tenant,
			new GetAiSessionEvaluationsRequest({
				sessionId,
				traceIds,
				startTime: formatWarehouseDateTime(startMs),
				endTime: formatWarehouseDateTime(endMs + AI_EVALUATION_SESSION_SCORES_TAIL_MS),
			}),
		)
		const external = Arr.filter(result.scores, (score) => score.source !== SESSION_CHECK_SOURCE)
		return {
			total: external.length,
			items: Arr.map(Arr.take(Arr.sort(external, failingFirst), MAX_SCORES), (score) => ({
				name: score.name,
				verdict: score.verdict,
				label: score.label,
				...(score.value === undefined ? undefined : { value: score.value }),
				explanation: truncate(score.explanation, CAPTURED_TEXT_CHARS),
				source: score.source,
				traceId: score.traceId,
				spanId: score.spanId,
			})),
		}
	}).pipe(
		Effect.catch((error) =>
			error._tag === "@maple/http/ai-evaluations/LlmEvalsDisabledError"
				? Effect.undefined
				: Effect.logWarning("get_agent_session could not read the session's scores").pipe(
						Effect.annotateLogs({ error: error.message }),
						Effect.as(undefined),
					),
		),
	)

/** A `###` table section, absent when it has no rows. */
const tableSection = (
	title: string,
	headers: ReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<DocBlock> => (rows.length === 0 ? [] : [doc.heading(title), doc.table(headers, rows)])

const verdictLine = (verdict: Output["verdict"]): string => {
	// Headlines carry span-derived text (tool names, error types), so they are collapsed to one
	// line: no forged heading from a newline in an attribute.
	const headline = tableCell(verdict.headline, 200)
	const line = verdict.status === "failed" ? `Failed: ${headline}` : `Completed ${headline}`
	return `${line}${verdict.spanId !== undefined ? ` (span ${verdict.spanId})` : ""}`
}

export function registerGetAgentSessionTool(server: McpToolRegistrar) {
	server.define({
		name: "get_agent_session",
		title: "Get Agent Session",
		description:
			"Read one AI agent session (an LLM agent trace; not a browser session replay, see `get_session_transcript`): its verdict, the checks it failed (and what to do about each), findings, wall/active/idle time, turn counts, LLM and tool calls, tokens, reported cost, models and tools. Turn by turn is `get_agent_session_transcript`. Everything is derived from the session's own spans, up to 10000; past that it says so and every figure covers the spans loaded. `inspect_span` opens the span behind the verdict.",
		parameters: Schema.Struct({
			session_id: P.text(
				"The agent session id, as `list_agent_sessions` reports it (a vendor id, or `trace:<traceId>`)",
			).check(Schema.isMinLength(1)),
			...sessionWindowParams,
		}),
		untrustedOutput: true,
		hints: { readOnly: true },
		permission: "telemetry:read",
		phrases: ["Opening an agent session"],
		handler: Effect.fn("McpTool.getAgentSession")(
			function* (params) {
				const sessionId = params.session_id
				const window = yield* sessionWindowFrom(params)

				const tenant = yield* CurrentMcpTenant
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.ai.session.id": sessionId })

				const loaded = yield* loadAgentSessionSpans(tenant, { sessionId, window })
				yield* Effect.annotateCurrentSpan("result.rowCount", loaded.spans.length)
				if (loaded.spans.length === 0) {
					return yield* new McpInvalidInputError({
						message: `No spans for AI agent session ${sessionId}${
							window === undefined
								? '. Check the id: `list_agent_sessions search="<prefix>"` finds it.'
								: " in the given window. Drop start_time/end_time to resolve the session's own bounds, or check the id with `list_agent_sessions`."
						}`,
						parameter: "session_id",
					})
				}

				const turns = buildSessionTurns(loaded.spans)
				const summary = buildSessionSummary({ spans: loaded.spans, turns })
				const report = buildSessionFindings(turns, summary)
				const checks = buildSessionChecks(turns, summary, report)
				const { counts } = checks

				// The verdict and the counts are what a read of a session answers; on the span they say
				// how often a read lands on a failing session.
				yield* Effect.annotateCurrentSpan({
					"maple.ai.session.verdict": report.verdict.status,
					"maple.ai.checks.failed": counts.failed,
					"maple.ai.checks.warning": counts.warning,
				})

				// The findings carry a span id but no trace id; the loaded spans have both, and the span's
				// own timestamp is what prunes `inspect_span`'s scan to the day the session ran on.
				const evidenceSpanId = report.verdict.spanId ?? report.findings[0]?.spanId
				const evidence = loaded.spans.find((span) => span.spanId === evidenceSpanId)
				const scores = yield* readScores(tenant, sessionId, loaded.spans)

				const output: Output = {
					sessionId,
					...(loaded.window === undefined
						? undefined
						: { window: { start: loaded.window.startTime, end: loaded.window.endTime } }),
					load: loadSummary(loaded),
					vendorIds: summary.vendorIds,
					agentNames: summary.agentNames,
					serviceNames: summary.serviceNames,
					...(summary.title === undefined
						? undefined
						: { title: truncate(summary.title, CAPTURED_TEXT_CHARS) }),
					verdict: {
						status: report.verdict.status,
						headline: checks.headline,
						...(report.verdict.spanId === undefined
							? undefined
							: { spanId: report.verdict.spanId }),
					},
					checkCounts: {
						failed: counts.failed,
						warning: counts.warning,
						passed: counts.passed,
						skipped: counts.skipped,
					},
					// Only what needs attention carries its sentence; a passed check is its name.
					checks: Arr.map(
						Arr.filter(checks.checks, (check) => check.status !== "passed"),
						(check) => ({
							id: check.id,
							name: check.name,
							status: check.status,
							headline: check.headline,
							...(check.action === undefined ? undefined : { action: check.action }),
							...(check.fixArea === undefined ? undefined : { fixArea: check.fixArea }),
						}),
					),
					passedChecks: Arr.map(
						Arr.filter(checks.checks, (check) => check.status === "passed"),
						(check) => check.name,
					),
					findingCount: report.findings.length,
					findings: Arr.map(report.findings.slice(0, MAX_FINDINGS), (finding) => ({
						kind: finding.kind,
						severity: finding.severity,
						label: finding.label,
						count: finding.count,
						turnText: finding.turnText,
						...(finding.detail === undefined ? undefined : { detail: finding.detail }),
						spanId: finding.spanId,
					})),
					vitals: {
						wallClockMs: summary.wallClockMs,
						activeMs: summary.activeMs,
						idleMs: summary.idleMs,
						idleGapCount: summary.idleGaps.length,
						agentTimeMs: summary.agentTime.totalMs,
						agentTimeSegments: Arr.map(summary.agentTime.segments, (segment) => ({
							kind: segment.kind,
							ms: segment.ms,
						})),
					},
					work: {
						turns: summary.work.turns,
						llmCalls: summary.work.llmCalls,
						toolCalls: summary.work.toolCalls,
						spans: summary.spanCount,
						traces: summary.traceCount,
					},
					tokens: summary.tokens,
					tokenReporting: summary.tokenReporting,
					...(summary.cost === undefined ? undefined : { cost: summary.cost }),
					models: Arr.map(summary.models, (usage) => ({
						model: usage.model,
						llmCalls: usage.llmCalls,
						totalTokens: usage.tokens.total,
						...(usage.cost === undefined ? undefined : { cost: usage.cost }),
					})),
					toolCount: summary.tools.length,
					tools: Arr.map(summary.tools.slice(0, MAX_TOOLS), (tool) => ({
						name: tool.name,
						calls: tool.calls,
						failed: tool.failed,
						totalMs: tool.totalMs,
						slowestMs: tool.slowestMs,
					})),
					// Turn by turn is the transcript's index; this read says how many, and how many failed.
					turnCount: turns.length,
					failedTurnCount: Arr.filter(turns, (turn) => turn.failed).length,
					...(evidence === undefined
						? undefined
						: {
								evidence: {
									traceId: evidence.traceId,
									spanId: evidence.spanId,
									timestamp: warehouseDateTimeToIso(evidence.timestamp),
								},
							}),
					...(scores === undefined ? undefined : { scores }),
				}
				return output
			},
			Effect.catchTags(warehouseReadToMcpHandlers("get_agent_session")),
			Effect.catchTag(
				"@maple/http/ai-sessions/AiSessionTooLargeError",
				sessionTooLarge("get_agent_session", WHOLE_SESSION_TOO_LARGE),
			),
		),
		render: (output) => {
			const { tokens, checkCounts } = output
			const attention = Arr.filter(
				output.checks,
				(check) => check.status === "failed" || check.status === "warning",
			)
			const settled = Arr.filter(
				output.checks,
				(check) => check.status === "passed" || check.status === "skipped",
			)
			const note = truncationNote(output.load)
			const orDash = (values: ReadonlyArray<string>) => Arr.join(values, ", ") || "—"
			return {
				title: `AI agent session ${output.sessionId}`,
				scope: [
					[
						"Window",
						output.window === undefined
							? undefined
							: `${output.window.start} to ${output.window.end}`,
					],
				],
				blocks: [
					doc.text(
						`Vendor ${orDash(output.vendorIds)} · agents ${orDash(output.agentNames)} · services ${orDash(
							output.serviceNames,
						)} · models ${orDash(Arr.map(output.models, (usage) => usage.model))}`,
					),
					...(output.title === undefined
						? []
						: [doc.text(`Opening message: ${truncate(output.title, 200)}`)]),
					...(note === undefined ? [] : [doc.text(note)]),
					doc.heading(`Verdict: ${verdictLine(output.verdict)}`),
					// The checks are the reading a caller can act on; the findings below them are the
					// evidence, span by span. The heading and its counts stay when nothing needs attention.
					doc.heading(
						`Checks (${checkCounts.failed} failed · ${checkCounts.warning} ${checkCounts.warning === 1 ? "warning" : "warnings"} · ${checkCounts.passed} passed · ${checkCounts.skipped} not checked)`,
					),
					attention.length === 0
						? doc.text("Nothing needs attention.")
						: doc.table(
								["Status", "Check", "What happened", "Do"],
								Arr.map(attention, (check) => [
									check.status,
									check.name,
									truncate(check.headline, 160),
									check.action === undefined ? "—" : truncate(check.action, 120),
								]),
							),
					...(output.passedChecks.length === 0
						? []
						: [doc.text(`Passed: ${Arr.join(output.passedChecks, ", ")}.`)]),
					...(settled.length === 0
						? []
						: [
								doc.list(
									Arr.map(
										settled,
										(check) =>
											`${check.name} (${check.status}): ${tableCell(check.headline, 200)}`,
									),
								),
							]),
					...tableSection(
						`Findings (${output.findingCount})`,
						["Severity", "What", "×", "Where", "Detail", "Span"],
						Arr.map(output.findings, (finding) => [
							finding.severity,
							truncate(finding.label, 60),
							String(finding.count),
							finding.turnText,
							finding.detail === undefined ? "—" : truncate(finding.detail, 120),
							finding.spanId,
						]),
					),
					...(output.scores === undefined || output.scores.total === 0
						? []
						: tableSection(
								`Evaluation scores (${output.scores.total}${output.scores.total > output.scores.items.length ? `, ${output.scores.items.length} shown` : ""})`,
								["Evaluator", "Verdict", "Score", "Why", "Span"],
								Arr.map(output.scores.items, (score) => [
									tableCell(score.name, 80),
									score.verdict || "—",
									score.value === undefined
										? tableCell(score.label, 40) || "—"
										: String(score.value),
									score.explanation === "" ? "—" : tableCell(score.explanation, 160),
									score.spanId || "—",
								]),
							)),
					doc.heading("Vitals"),
					doc.list([
						`Wall clock ${formatDurationFromMs(output.vitals.wallClockMs)} · active ${formatDurationFromMs(
							output.vitals.activeMs,
						)} · idle ${formatDurationFromMs(output.vitals.idleMs)} over ${output.vitals.idleGapCount} gap(s)`,
						`Agent time ${formatDurationFromMs(output.vitals.agentTimeMs)} (${
							Arr.join(
								Arr.map(
									output.vitals.agentTimeSegments,
									(segment) => `${segment.kind} ${formatDurationFromMs(segment.ms)}`,
								),
								", ",
							) || "unbroken"
						})`,
					]),
					doc.heading("Work"),
					doc.list([
						`${output.work.turns} turns${output.failedTurnCount > 0 ? ` (${output.failedTurnCount} failed)` : ""} · ${output.work.llmCalls} LLM calls · ${output.work.toolCalls} tool calls · ${output.work.spans} spans · ${output.work.traces} traces`,
					]),
					doc.heading(`Tokens (reported ${output.tokenReporting})`),
					doc.list([
						`input ${formatNumber(tokens.input)} · cache read ${formatNumber(tokens.cacheRead)} · cache write ${formatNumber(
							tokens.cacheWrite,
						)} · output ${formatNumber(tokens.output)} · reasoning ${formatNumber(tokens.reasoning)} · total ${formatNumber(tokens.total)}`,
						`Cost ${output.cost === undefined ? "not reported" : formatCost(output.cost)}`,
					]),
					...tableSection(
						"Models",
						["Model", "LLM calls", "Tokens", "Cost"],
						Arr.map(output.models, (usage) => [
							usage.model,
							formatNumber(usage.llmCalls),
							formatNumber(usage.totalTokens),
							usage.cost === undefined ? "—" : formatCost(usage.cost),
						]),
					),
					...tableSection(
						`Tools (${output.toolCount})`,
						["Tool", "Calls", "Failed", "Total", "Slowest"],
						Arr.map(output.tools, (tool) => [
							tool.name,
							formatNumber(tool.calls),
							tool.failed > 0 ? String(tool.failed) : "—",
							formatDurationFromMs(tool.totalMs),
							formatDurationFromMs(tool.slowestMs),
						]),
					),
				],
				next: [
					doc.next(
						"get_agent_session_transcript",
						{
							session_id: output.sessionId,
							...(output.window === undefined
								? undefined
								: { start_time: output.window.start, end_time: output.window.end }),
							...(output.findingCount > 0 ? { failed_only: true } : undefined),
						},
						output.findingCount > 0
							? "every failure in time order, where a cascade starts"
							: "what the agent did, step by step",
					),
					// The findings name turns by number; the transcript's index says which run each is.
					...(output.findingCount > 0 && output.turnCount > 1
						? [
								doc.next(
									"get_agent_session_transcript",
									{
										session_id: output.sessionId,
										...(output.window === undefined
											? undefined
											: {
													start_time: output.window.start,
													end_time: output.window.end,
												}),
									},
									"each turn's agent, outcome and opening, step by step",
								),
							]
						: []),
					...(output.evidence === undefined
						? []
						: [
								doc.next(
									"inspect_span",
									{
										trace_id: output.evidence.traceId,
										span_id: output.evidence.spanId,
										timestamp: output.evidence.timestamp,
									},
									"the messages and tool calls of the span behind the verdict",
								),
							]),
				],
			}
		},
	})
}
