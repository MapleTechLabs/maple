import { requiredStringParam, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatDurationFromMs, formatNumber, formatTable, tableCell, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import {
	catchSessionTooLarge,
	loadAgentSessionSpans,
	offsetLabel,
	sessionWindowFrom,
	sessionWindowPairCheck,
	sessionWindowParams,
	truncationNote,
} from "../lib/agent-sessions"
import { Effect, Match, Schema } from "effect"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import {
	buildSessionChecks,
	buildSessionFindings,
	buildSessionSummary,
	buildSessionTurns,
	formatCost,
	turnOrdinal,
} from "@maple/agent-sessions"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"

/** Table ceilings — a session with hundreds of turns is read through its spans,
 *  not through a table of every row. */
const MAX_FINDINGS = 10
const MAX_TOOLS = 15
const MAX_TURNS = 25

/** A `###` table section, absent when it has no rows. */
const tableSection = (title: string, headers: string[], rows: string[][]): string[] =>
	rows.length === 0 ? [] : [``, `### ${title}`, formatTable(headers, rows)]

/** What to do about a session whose first page of spans no read can carry. */
const WHOLE_SESSION_TOO_LARGE =
	"Read part of it instead: pass a start_time/end_time narrower than the session's own bounds."

export function registerGetAgentSessionTool(server: McpToolRegistrar) {
	server.tool(
		"get_agent_session",
		"Read one AI agent session (an LLM agent trace, not a browser session replay): its verdict, the checks it failed or passed with what to do about each, its findings, wall/active/idle time, agent time by kind, turn and call counts, token buckets, reported cost, the models and tools it used, its failure groups and its turns. Derived from the session's own spans, exactly as the Agent Sessions page derives them — up to 10000 of them, past which it says so and every figure covers the spans it loaded. Pass start_time/end_time exactly as the `get_agent_session` line under a `list_agent_sessions` row prints them — that makes the read a seek. Follow up with `inspect_span` for what one span actually said.",
		Schema.Struct({
			session_id: requiredStringParam(
				"The agent session id, as `list_agent_sessions` reports it (a vendor id, or `trace:<traceId>`)",
			).check(Schema.isMinLength(1)),
			...sessionWindowParams,
		}).check(sessionWindowPairCheck),
		Effect.fn("McpTool.getAgentSession")(
			function* (params) {
				const sessionId = params.session_id
				const window = sessionWindowFrom(params)

				const tenant = yield* CurrentMcpTenant
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.ai.session.id": sessionId })

				const loaded = yield* loadAgentSessionSpans(tenant, { sessionId, window })
				yield* Effect.annotateCurrentSpan("result.rowCount", loaded.spans.length)
				if (loaded.spans.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No spans for AI agent session ${sessionId}${
									window === undefined
										? '. Check the id — `list_agent_sessions search="<prefix>"` finds it.'
										: " in the given window. Drop start_time/end_time to resolve the session's own bounds, or check the id with `list_agent_sessions`."
								}`,
							},
						],
					}
				}

				const turns = buildSessionTurns(loaded.spans)
				const summary = buildSessionSummary({ spans: loaded.spans, turns })
				const report = buildSessionFindings(turns, summary)
				const checks = buildSessionChecks(turns, summary, report)

				const tokens = summary.tokens
				const findings = report.findings.slice(0, MAX_FINDINGS)
				const tools = summary.tools.slice(0, MAX_TOOLS)
				const shownTurns = turns.slice(0, MAX_TURNS)

				const lines: string[] = [
					`## AI agent session ${sessionId}`,
					`Vendor ${summary.vendorIds.join(", ") || "—"} · agents ${
						summary.agentNames.join(", ") || "—"
					} · services ${summary.serviceNames.join(", ") || "—"} · models ${
						summary.models.map((usage) => usage.model).join(", ") || "—"
					}`,
					...(summary.title !== undefined
						? [`Opening message: ${truncate(summary.title, 200)}`]
						: []),
					...(loaded.window !== undefined
						? [`Window: ${loaded.window.startTime} — ${loaded.window.endTime}`]
						: []),
					...truncationNote(loaded),
					``,
					`### Verdict: ${Match.value(report.verdict.status).pipe(
						Match.when("failed", () => `Failed — ${checks.headline}`),
						Match.whenOr("attention", "clean", () => `Completed ${checks.headline}`),
						Match.exhaustive,
					)}${report.verdict.spanId !== undefined ? ` (span ${report.verdict.spanId})` : ""}`,
				]

				// The checks are the reading a caller can act on; the findings below
				// them are the evidence rows, span by span. The heading and its
				// counts stay even when nothing needs attention — that is the
				// answer, not an empty section.
				const { counts } = checks
				// The verdict and the counts are what a read of a session answers;
				// on the span they say how often a read lands on a failing session.
				yield* Effect.annotateCurrentSpan({
					"maple.ai.session.verdict": report.verdict.status,
					"checks.failed": counts.failed,
					"checks.warning": counts.warning,
				})
				const attention = checks.checks.filter(
					(check) => check.status === "failed" || check.status === "warning",
				)
				lines.push(
					``,
					`### Checks (${counts.failed} failed · ${counts.warning} ${counts.warning === 1 ? "warning" : "warnings"} · ${counts.passed} passed · ${counts.skipped} not checked)`,
					...(attention.length === 0
						? ["Nothing needs attention."]
						: [
								formatTable(
									["Status", "Check", "What happened", "Do"],
									attention.map((check) => [
										check.status,
										check.name,
										tableCell(check.headline, 160),
										check.action === undefined ? "—" : tableCell(check.action, 120),
									]),
								),
							]),
					...checks.checks
						.filter((check) => check.status === "passed" || check.status === "skipped")
						.map((check) => `- ${check.name} (${check.status}): ${check.headline}`),
				)

				lines.push(
					...tableSection(
						`Findings (${report.findings.length})`,
						["Severity", "What", "×", "Where", "Detail", "Span"],
						findings.map((finding) => [
							finding.severity,
							tableCell(finding.label, 60),
							String(finding.count),
							tableCell(finding.turnText),
							finding.detail === undefined ? "—" : tableCell(finding.detail, 120),
							finding.spanId,
						]),
					),
				)

				lines.push(
					``,
					`### Vitals`,
					`- Wall clock ${formatDurationFromMs(summary.wallClockMs)} · active ${formatDurationFromMs(
						summary.activeMs,
					)} · idle ${formatDurationFromMs(summary.idleMs)} over ${summary.idleGaps.length} gap(s)`,
					`- Agent time ${formatDurationFromMs(summary.agentTime.totalMs)} (${
						summary.agentTime.segments
							.map((segment) => `${segment.kind} ${formatDurationFromMs(segment.ms)}`)
							.join(", ") || "unbroken"
					}), peak parallel ${summary.agentTime.peakParallel}`,
					``,
					`### Work`,
					`- ${summary.work.turns} turns · ${summary.work.llmCalls} LLM calls · ${summary.work.toolCalls} tool calls · ${summary.spanCount} spans · ${summary.traceCount} traces`,
					``,
					`### Tokens (reported ${summary.tokenReporting})`,
					`- input ${formatNumber(tokens.input)} · cache read ${formatNumber(
						tokens.cacheRead,
					)} · cache write ${formatNumber(tokens.cacheWrite)} · output ${formatNumber(
						tokens.output,
					)} · reasoning ${formatNumber(tokens.reasoning)} · total ${formatNumber(tokens.total)}`,
					`- Cost ${summary.cost === undefined ? "not reported" : formatCost(summary.cost)}`,
				)

				lines.push(
					...tableSection(
						`Models`,
						["Model", "LLM calls", "Tokens", "Cost"],
						summary.models.map((usage) => [
							tableCell(usage.model),
							formatNumber(usage.llmCalls),
							formatNumber(usage.tokens.total),
							usage.cost === undefined ? "—" : formatCost(usage.cost),
						]),
					),
				)

				lines.push(
					...tableSection(
						`Tools (${summary.tools.length})`,
						["Tool", "Calls", "Failed", "Total", "Slowest"],
						tools.map((tool) => [
							tableCell(tool.name),
							formatNumber(tool.calls),
							tool.failed > 0 ? String(tool.failed) : "—",
							formatDurationFromMs(tool.totalMs),
							formatDurationFromMs(tool.slowestMs),
						]),
					),
				)

				lines.push(
					...tableSection(
						`Failure groups`,
						["Kind", "Label", "Count"],
						summary.failureGroups.map((group) => [
							group.kind,
							tableCell(group.label, 80),
							String(group.count),
						]),
					),
				)

				lines.push(
					``,
					`### Turns (${turns.length}${shownTurns.length < turns.length ? `, showing ${shownTurns.length}` : ""})`,
					formatTable(
						["Turn", "Anchor", "Agent", "Start", "Duration", "Spans", "Failed", "Opened with"],
						shownTurns.map((turn) => [
							turnOrdinal(turn),
							turn.anchorKind,
							turn.agentName === undefined ? "—" : tableCell(turn.agentName),
							offsetLabel(turn.startMs - summary.startMs),
							formatDurationFromMs(turn.durationMs),
							String(turn.spans.length),
							turn.failed ? "yes" : "",
							turn.label === undefined ? "—" : tableCell(turn.label, 80),
						]),
					),
				)

				// The findings carry a span id but no trace id; the loaded spans have
				// both, and the span's own timestamp is what prunes `inspect_span`'s
				// scan to the day the session ran on.
				const evidenceSpanId = report.verdict.spanId ?? findings[0]?.spanId
				const evidence = loaded.spans.find((span) => span.spanId === evidenceSpanId)
				if (evidence !== undefined) {
					lines.push(
						formatNextSteps([
							`\`inspect_span trace_id="${evidence.traceId}" span_id="${evidence.spanId}" timestamp="${warehouseDateTimeToIso(
								evidence.timestamp,
							)}"\` — the messages and tool calls of the span behind the verdict`,
						]),
					)
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }] }
			},
			Effect.catchTags(warehouseReadToMcpHandlers("get_agent_session")),
			catchSessionTooLarge(WHOLE_SESSION_TOO_LARGE),
		),
	)
}
