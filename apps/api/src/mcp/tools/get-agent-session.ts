import { requiredStringParam, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { formatDurationFromMs, formatNumber, formatTable, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { createDualContent } from "@/mcp/lib/structured-output"
import {
	catchSessionTooLarge,
	loadAgentSessionSpans,
	MCP_AGENT_SESSION_MAX_SPANS,
	offsetLabel,
	requiredIdOf,
	sessionWindowOf,
	sessionWindowParams,
	windowHint,
} from "@/mcp/lib/agent-sessions"
import { Effect, Schema } from "effect"
import { GetAiSessionSummaryRequest, type GetAiSessionSummaryResponse } from "@maple/domain/http"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import {
	buildSessionFindings,
	buildSessionSummary,
	buildSessionTurns,
	formatCost,
	turnOrdinal,
} from "@maple/agent-sessions"
import { readAiSessionSummary } from "@/services/ai-sessions/ai-session-reads"
import { warehouseReadToMcpHandlers } from "@/mcp/lib/map-warehouse-error"

/** Table ceilings — a session with hundreds of turns is read through the
 *  transcript, not through a table of every row. */
const MAX_FINDINGS = 10
const MAX_TOOLS = 15
const MAX_TURNS = 25

/** What to do about a session whose spans no read can carry. */
const WHOLE_SESSION_TOO_LARGE =
	"The session is too large to load whole; read it with `list_agent_session_spans` and a small `limit`."

export function registerGetAgentSessionTool(server: McpToolRegistrar) {
	server.tool(
		"get_agent_session",
		"Read one AI agent session (an LLM agent trace, not a browser session replay): its verdict and findings, wall/active/idle time, agent time by kind, turn and call counts, token buckets, reported cost, the models and tools it used, its failure groups and its turns. Derived from the session's own spans, exactly as the Agent Sessions page derives them — up to 10000 of them, past which it says so and reports the warehouse's exact totals for the whole session. Pass start_time/end_time from `list_agent_sessions` to make the read a seek. Follow up with `list_agent_session_spans` for the spans themselves, and `inspect_span` for what one of them actually said.",
		Schema.Struct({
			session_id: requiredStringParam(
				"The agent session id, as `list_agent_sessions` reports it (a vendor id, or `trace:<traceId>`)",
			),
			...sessionWindowParams,
		}),
		Effect.fn("McpTool.getAgentSession")(function* (params) {
			const windowInput = sessionWindowOf(params)
			if (windowInput._tag === "invalid") return windowInput.result
			const idInput = requiredIdOf(params.session_id, "session_id", 'session_id="wrun_01KZ…"')
			if (idInput._tag === "invalid") return idInput.result
			const sessionId = idInput.id

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				sessionId,
				windowSource: windowInput.window === undefined ? "resolved" : "client",
			})

			const loaded = yield* loadAgentSessionSpans(tenant, {
				sessionId,
				window: windowInput.window,
				scope: "all",
			}).pipe(Effect.catchTags(warehouseReadToMcpHandlers("get_agent_session")))

			yield* Effect.annotateCurrentSpan({
				"result.spanCount": loaded.spans.length,
				"result.truncated": loaded.truncatedBy !== undefined,
				...(loaded.truncatedBy !== undefined && { "result.truncated_by": loaded.truncatedBy }),
			})
			if (loaded.spans.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No spans for AI agent session ${sessionId}${
								windowInput.window === undefined
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

			// The warehouse's own totals, which hold for the whole session: worth a
			// second read only when the loaded spans no longer cover it.
			let exact: GetAiSessionSummaryResponse | undefined
			if (loaded.truncatedBy !== undefined) {
				exact = yield* readAiSessionSummary(
					tenant,
					// The window the spans were read under, which covers the whole
					// session — not the loaded spans' extent, which would ask the
					// warehouse about its beginning alone.
					new GetAiSessionSummaryRequest({
						sessionId,
						...(loaded.window !== undefined && {
							startTime: loaded.window.startTime,
							endTime: loaded.window.endTime,
						}),
					}),
				).pipe(Effect.catchTags(warehouseReadToMcpHandlers("get_agent_session")))
			}

			const spanOf = new Map(loaded.spans.map((span) => [span.spanId, span] as const))
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
				...(summary.title !== undefined ? [`Opening message: ${truncate(summary.title, 200)}`] : []),
				...(loaded.window !== undefined
					? [`Window: ${loaded.window.startTime} — ${loaded.window.endTime}`]
					: []),
				...(loaded.truncatedBy === undefined
					? []
					: [
							``,
							`**Only the first ${formatNumber(loaded.spans.length)} spans were loaded** (${
								loaded.truncatedBy === "content"
									? "the session's captured content exceeded the load budget"
									: `the cap is ${formatNumber(MCP_AGENT_SESSION_MAX_SPANS)} spans`
							}), oldest first — the END of this session is missing, so everything derived below describes its beginning. The exact warehouse totals are printed under Work.`,
						]),
				``,
				`### Verdict: ${report.verdict.status}${
					report.verdict.label !== undefined ? ` — ${report.verdict.label}` : ""
				}${report.verdict.spanId !== undefined ? ` (span ${report.verdict.spanId})` : ""}`,
			]

			if (findings.length > 0) {
				lines.push(
					``,
					`### Findings (${report.findings.length})`,
					formatTable(
						["Severity", "What", "×", "Where", "Detail", "Span"],
						findings.map((finding) => [
							finding.severity,
							truncate(finding.label, 60),
							String(finding.count),
							finding.turnText,
							finding.detail === undefined ? "—" : truncate(finding.detail, 120),
							finding.spanId,
						]),
					),
				)
			}

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
				...(exact !== undefined
					? [
							`- Warehouse totals for the WHOLE session: ${exact.spanCount} spans (${exact.aiSpanCount} agent), ${exact.traceCount} traces, ${exact.llmCalls} LLM calls, ${exact.toolCalls} tool calls, ${exact.errorSpanCount} failed spans, ${formatDurationFromMs(exact.durationMs)}`,
						]
					: []),
				``,
				`### Tokens (reported ${summary.tokenReporting})`,
				`- input ${formatNumber(tokens.input)} · cache read ${formatNumber(
					tokens.cacheRead,
				)} · cache write ${formatNumber(tokens.cacheWrite)} · output ${formatNumber(
					tokens.output,
				)} · reasoning ${formatNumber(tokens.reasoning)} · total ${formatNumber(tokens.total)}`,
				`- Cost ${summary.cost === undefined ? "not reported" : formatCost(summary.cost)}`,
			)

			if (summary.models.length > 0) {
				lines.push(
					``,
					`### Models`,
					formatTable(
						["Model", "LLM calls", "Tokens", "Cost"],
						summary.models.map((usage) => [
							usage.model,
							formatNumber(usage.llmCalls),
							formatNumber(usage.tokens.total),
							usage.cost === undefined ? "—" : formatCost(usage.cost),
						]),
					),
				)
			}

			if (tools.length > 0) {
				lines.push(
					``,
					`### Tools (${summary.tools.length})`,
					formatTable(
						["Tool", "Calls", "Failed", "Total", "Slowest"],
						tools.map((tool) => [
							tool.name,
							formatNumber(tool.calls),
							tool.failed > 0 ? String(tool.failed) : "—",
							formatDurationFromMs(tool.totalMs),
							formatDurationFromMs(tool.slowestMs),
						]),
					),
				)
			}

			if (summary.failureGroups.length > 0) {
				lines.push(
					``,
					`### Failure groups`,
					formatTable(
						["Kind", "Label", "Count"],
						summary.failureGroups.map((group) => [
							group.kind,
							truncate(group.label, 80),
							String(group.count),
						]),
					),
				)
			}

			lines.push(
				``,
				`### Turns (${turns.length}${shownTurns.length < turns.length ? `, showing ${shownTurns.length}` : ""})`,
				formatTable(
					["Turn", "Anchor", "Agent", "Start", "Duration", "Spans", "Failed", "Opened with"],
					shownTurns.map((turn) => [
						turnOrdinal(turn),
						turn.anchorKind,
						turn.agentName ?? "—",
						offsetLabel(turn.startMs - summary.startMs),
						formatDurationFromMs(turn.durationMs),
						String(turn.spans.length),
						turn.failed ? "yes" : "",
						turn.label === undefined ? "—" : truncate(turn.label, 80),
					]),
				),
			)

			const hint = loaded.window === undefined ? "" : ` ${windowHint(loaded.window)}`
			const nextSteps = [
				`\`list_agent_session_spans session_id="${sessionId}"${hint}\` — every span, paged`,
			]
			// The findings carry a span id but no trace id; the loaded spans have
			// both, and the span's own timestamp is what prunes `inspect_span`'s
			// scan to the day the session ran on.
			const evidence = spanOf.get(report.verdict.spanId ?? findings[0]?.spanId ?? "")
			if (evidence !== undefined) {
				nextSteps.push(
					`\`inspect_span trace_id="${evidence.traceId}" span_id="${evidence.spanId}" timestamp="${warehouseDateTimeToIso(
						evidence.timestamp,
					)}"\` — the messages and tool calls of the span behind the verdict`,
				)
			}
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_agent_session",
					data: {
						sessionId,
						window:
							loaded.window === undefined
								? undefined
								: { start: loaded.window.startTime, end: loaded.window.endTime },
						truncated: loaded.truncatedBy !== undefined,
						verdict: {
							status: report.verdict.status,
							label: report.verdict.label ?? null,
							spanId: report.verdict.spanId ?? null,
						},
						findings: report.findings.map((finding) => ({
							severity: finding.severity,
							label: finding.label,
							count: finding.count,
							turnText: finding.turnText,
							detail: finding.detail ?? null,
							spanId: finding.spanId,
							traceId: spanOf.get(finding.spanId)?.traceId ?? null,
						})),
						vitals: {
							startTime: loaded.window?.startTime ?? "",
							wallClockMs: summary.wallClockMs,
							activeMs: summary.activeMs,
							idleMs: summary.idleMs,
							agentTimeMs: summary.agentTime.totalMs,
							peakParallel: summary.agentTime.peakParallel,
							agentTimeSegments: summary.agentTime.segments.map((segment) => ({
								kind: segment.kind,
								ms: segment.ms,
							})),
						},
						work: {
							turns: summary.work.turns,
							llmCalls: summary.work.llmCalls,
							toolCalls: summary.work.toolCalls,
							spanCount: summary.spanCount,
							traceCount: summary.traceCount,
						},
						exactTotals:
							exact === undefined
								? undefined
								: {
										spanCount: exact.spanCount,
										aiSpanCount: exact.aiSpanCount,
										traceCount: exact.traceCount,
										llmCalls: exact.llmCalls,
										toolCalls: exact.toolCalls,
										errorSpanCount: exact.errorSpanCount,
										durationMs: exact.durationMs,
									},
						tokens: {
							input: tokens.input,
							cacheRead: tokens.cacheRead,
							cacheWrite: tokens.cacheWrite,
							output: tokens.output,
							reasoning: tokens.reasoning,
							total: tokens.total,
							reporting: summary.tokenReporting,
						},
						cost: summary.cost ?? null,
						models: summary.models.map((usage) => ({
							model: usage.model,
							llmCalls: usage.llmCalls,
							totalTokens: usage.tokens.total,
							cost: usage.cost ?? null,
						})),
						tools: summary.tools.map((tool) => ({
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
						turns: turns.map((turn) => ({
							index: turn.index,
							anchorKind: turn.anchorKind,
							agentName: turn.agentName ?? null,
							startOffsetMs: turn.startMs - summary.startMs,
							durationMs: turn.durationMs,
							spanCount: turn.spans.length,
							failed: turn.failed,
							label: turn.label ?? null,
						})),
					},
				}),
			}
		}, catchSessionTooLarge(WHOLE_SESSION_TOO_LARGE)),
	)
}
