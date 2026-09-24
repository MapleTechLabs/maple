import { Effect, Schema } from "effect"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import {
	buildSessionChecks,
	buildSessionFindings,
	buildSessionSummary,
	buildSessionTurns,
	formatCost,
	turnOrdinal,
} from "@maple/agent-sessions"
import { GetAgentSessionOutput } from "@maple/domain/mcp-outputs"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatDurationFromMs, formatNumber, tableCell, truncate } from "../lib/format"
import {
	loadAgentSessionSpans,
	loadSummary,
	offsetLabel,
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
const MAX_TURNS = 25

/** Characters kept of captured text the output carries (the opening message, a turn's label). */
const CAPTURED_TEXT_CHARS = 500

/** What to do about a session whose first page of spans no read can carry. */
const WHOLE_SESSION_TOO_LARGE =
	"Read part of it instead: pass a start_time/end_time narrower than the session's own bounds."

type Output = typeof GetAgentSessionOutput.Type

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
		description:
			"Read one AI agent session (an LLM agent trace; not a browser session replay, see `get_session_transcript`): its verdict, the checks it failed or passed and what to do about each, findings, wall/active/idle time, turns, LLM and tool calls, tokens, reported cost, models, tools and failure groups. Everything is derived from the session's own spans, up to 10000; past that it says so and every figure covers the spans loaded. `inspect_span` opens the span behind the verdict.",
		parameters: Schema.Struct({
			session_id: P.text(
				"The agent session id, as `list_agent_sessions` reports it (a vendor id, or `trace:<traceId>`)",
			).check(Schema.isMinLength(1)),
			...sessionWindowParams,
		}),
		output: GetAgentSessionOutput,
		hints: { readOnly: true },
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
					checks: checks.checks.map((check) => ({
						id: check.id,
						name: check.name,
						status: check.status,
						headline: check.headline,
						...(check.action === undefined ? undefined : { action: check.action }),
						...(check.fixArea === undefined ? undefined : { fixArea: check.fixArea }),
					})),
					findingCount: report.findings.length,
					findings: report.findings.slice(0, MAX_FINDINGS).map((finding) => ({
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
						agentTimeSegments: summary.agentTime.segments.map((segment) => ({
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
					models: summary.models.map((usage) => ({
						model: usage.model,
						llmCalls: usage.llmCalls,
						totalTokens: usage.tokens.total,
						...(usage.cost === undefined ? undefined : { cost: usage.cost }),
					})),
					toolCount: summary.tools.length,
					tools: summary.tools.slice(0, MAX_TOOLS).map((tool) => ({
						name: tool.name,
						calls: tool.calls,
						failed: tool.failed,
						totalMs: tool.totalMs,
						slowestMs: tool.slowestMs,
					})),
					failureGroups: summary.failureGroups.map((group) => ({
						kind: group.kind,
						label: group.label,
						count: group.count,
					})),
					turnCount: turns.length,
					turns: turns.slice(0, MAX_TURNS).map((turn) => ({
						ordinal: turnOrdinal(turn),
						anchorKind: turn.anchorKind,
						...(turn.agentName === undefined ? undefined : { agentName: turn.agentName }),
						offsetMs: turn.startMs - summary.startMs,
						durationMs: turn.durationMs,
						spanCount: turn.spans.length,
						failed: turn.failed,
						...(turn.label === undefined
							? undefined
							: { label: truncate(turn.label, CAPTURED_TEXT_CHARS) }),
					})),
					...(evidence === undefined
						? undefined
						: {
								evidence: {
									traceId: evidence.traceId,
									spanId: evidence.spanId,
									timestamp: warehouseDateTimeToIso(evidence.timestamp),
								},
							}),
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
			const attention = output.checks.filter(
				(check) => check.status === "failed" || check.status === "warning",
			)
			const settled = output.checks.filter(
				(check) => check.status === "passed" || check.status === "skipped",
			)
			const note = truncationNote(output.load)
			const orDash = (values: ReadonlyArray<string>) => values.join(", ") || "—"
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
						)} · models ${orDash(output.models.map((usage) => usage.model))}`,
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
								attention.map((check) => [
									check.status,
									check.name,
									truncate(check.headline, 160),
									check.action === undefined ? "—" : truncate(check.action, 120),
								]),
							),
					...(settled.length === 0
						? []
						: [
								doc.list(
									settled.map(
										(check) =>
											`${check.name} (${check.status}): ${tableCell(check.headline, 200)}`,
									),
								),
							]),
					...tableSection(
						`Findings (${output.findingCount})`,
						["Severity", "What", "×", "Where", "Detail", "Span"],
						output.findings.map((finding) => [
							finding.severity,
							truncate(finding.label, 60),
							String(finding.count),
							finding.turnText,
							finding.detail === undefined ? "—" : truncate(finding.detail, 120),
							finding.spanId,
						]),
					),
					doc.heading("Vitals"),
					doc.list([
						`Wall clock ${formatDurationFromMs(output.vitals.wallClockMs)} · active ${formatDurationFromMs(
							output.vitals.activeMs,
						)} · idle ${formatDurationFromMs(output.vitals.idleMs)} over ${output.vitals.idleGapCount} gap(s)`,
						`Agent time ${formatDurationFromMs(output.vitals.agentTimeMs)} (${
							output.vitals.agentTimeSegments
								.map((segment) => `${segment.kind} ${formatDurationFromMs(segment.ms)}`)
								.join(", ") || "unbroken"
						})`,
					]),
					doc.heading("Work"),
					doc.list([
						`${output.work.turns} turns · ${output.work.llmCalls} LLM calls · ${output.work.toolCalls} tool calls · ${output.work.spans} spans · ${output.work.traces} traces`,
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
						output.models.map((usage) => [
							usage.model,
							formatNumber(usage.llmCalls),
							formatNumber(usage.totalTokens),
							usage.cost === undefined ? "—" : formatCost(usage.cost),
						]),
					),
					...tableSection(
						`Tools (${output.toolCount})`,
						["Tool", "Calls", "Failed", "Total", "Slowest"],
						output.tools.map((tool) => [
							tool.name,
							formatNumber(tool.calls),
							tool.failed > 0 ? String(tool.failed) : "—",
							formatDurationFromMs(tool.totalMs),
							formatDurationFromMs(tool.slowestMs),
						]),
					),
					...tableSection(
						"Failure groups",
						["Kind", "Label", "Count"],
						output.failureGroups.map((group) => [
							group.kind,
							truncate(group.label, 80),
							String(group.count),
						]),
					),
					doc.heading(
						`Turns (${output.turnCount}${output.turns.length < output.turnCount ? `, showing ${output.turns.length}` : ""})`,
					),
					doc.table(
						["Turn", "Anchor", "Agent", "Start", "Duration", "Spans", "Failed", "Opened with"],
						output.turns.map((turn) => [
							turn.ordinal,
							turn.anchorKind,
							turn.agentName ?? "—",
							offsetLabel(turn.offsetMs),
							formatDurationFromMs(turn.durationMs),
							String(turn.spanCount),
							turn.failed ? "yes" : "",
							turn.label === undefined ? "—" : truncate(turn.label, 80),
						]),
					),
				],
				next:
					output.evidence === undefined
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
							],
			}
		},
	})
}
