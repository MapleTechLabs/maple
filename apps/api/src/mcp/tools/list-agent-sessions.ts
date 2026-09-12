import {
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	optionalTimeParam,
	type McpToolRegistrar,
} from "./types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS, rangeExceededResult, resolveTimeRange } from "@/mcp/lib/time"
import { clampLimit, clampOffset } from "@/mcp/lib/limits"
import { formatDurationFromMs, formatNumber, formatTable, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { createDualContent } from "@/mcp/lib/structured-output"
import { windowHint } from "@/mcp/lib/agent-sessions"
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { AiSessionSortDir, AiSessionSortKey, ListAiSessionsRequest } from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import { listAiSessions } from "@/services/ai-sessions/ai-session-reads"
import { warehouseReadToMcpHandlers } from "@/mcp/lib/map-warehouse-error"

const splitCsv = (value: string | undefined): string[] | undefined => {
	if (value === undefined) return undefined
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
	return entries.length === 0 ? undefined : entries
}

/** The `search` ceiling the domain's own check enforces. */
const SEARCH_MAX_CHARS = 200

/** A filter the domain refuses when blank (`isMinLength(1)`) and bounds at its
 *  own ceiling. `""` is how an LLM says "no filter", and a `Schema.Class`
 *  constructor answers a refused field by THROWING. */
const optionalText = (value: string | undefined, max: number): string | undefined => {
	const trimmed = value?.trim()
	return trimmed === undefined || trimmed === "" ? undefined : trimmed.slice(0, max)
}

// The request refuses a negative bound and a fractional count — they reach a
// column comparison. A model's sloppy value is normalized here rather than
// thrown as a decode defect the caller cannot act on.
const measureBound = (value: number | undefined) => (value === undefined ? undefined : Math.max(0, value))
const countBound = (value: number | undefined) =>
	value === undefined ? undefined : Math.max(0, Math.trunc(value))

export function registerListAgentSessionsTool(server: McpToolRegistrar) {
	server.tool(
		"list_agent_sessions",
		"List AI agent sessions (LLM agent traces stamped with gen_ai/maple_ai attributes — NOT browser session replays, which `search_sessions` serves). Each row is one agent session: its agent, vendor, models, LLM and tool calls, failures, tokens and reported cost. Filter by vendor/service/environment/model/agent/tool, by an id prefix (`search`), by whether it errored, and by duration/cost/token/call ranges. Follow up with `get_agent_session` — pass the row's start_time/end_time, which turns the session read into a seek.",
		Schema.Struct({
			start_time: optionalTimeParam("Start of time range (YYYY-MM-DD HH:mm:ss UTC, default: 24h ago)"),
			end_time: optionalTimeParam("End of time range (YYYY-MM-DD HH:mm:ss UTC, default: now)"),
			vendors: optionalStringParam(
				"Comma-separated vendor ids to match (e.g. eve,vercel_ai_sdk) — see `get_agent_sessions_overview`",
			),
			services: optionalStringParam("Comma-separated service names to match"),
			environments: optionalStringParam("Comma-separated deployment environments to match"),
			models: optionalStringParam("Comma-separated model names to match"),
			agents: optionalStringParam("Comma-separated agent names to match"),
			tools: optionalStringParam("Comma-separated tool names the session called"),
			search: optionalStringParam("Session id or trace id, or its leading characters (prefix match)"),
			has_errors: optionalBooleanParam("Only sessions with at least one failed agent span"),
			exclude_trace_sessions: optionalBooleanParam(
				"Drop `trace:<id>` sessions — traces whose vendor exposed no session key",
			),
			duration_min_ms: optionalNumberParam("Only sessions at least this long (ms)"),
			duration_max_ms: optionalNumberParam("Only sessions at most this long (ms)"),
			cost_min: optionalNumberParam("Only sessions costing at least this much (USD, as reported)"),
			cost_max: optionalNumberParam("Only sessions costing at most this much (USD)"),
			tokens_min: optionalNumberParam("Only sessions with at least this many total tokens"),
			tokens_max: optionalNumberParam("Only sessions with at most this many total tokens"),
			llm_calls_min: optionalNumberParam("Only sessions with at least this many model calls"),
			llm_calls_max: optionalNumberParam("Only sessions with at most this many model calls"),
			tool_calls_min: optionalNumberParam("Only sessions with at least this many tool calls"),
			tool_calls_max: optionalNumberParam("Only sessions with at most this many tool calls"),
			sort_by: Schema.optional(AiSessionSortKey).annotate({
				description: "Sort key (default startTime)",
			}),
			sort_dir: Schema.optional(AiSessionSortDir).annotate({
				description: "Sort direction (default desc)",
			}),
			limit: optionalNumberParam("Max sessions to return (default 25, max 100)"),
			offset: optionalNumberParam("Rows to skip for paging (default 0)"),
		}),
		Effect.fn("McpTool.listAgentSessions")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, {
				defaultHours: 24,
				maxHours: MCP_SEARCH_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "list_agent_sessions")

			// Both publish as enums, so an unknown value is a parameter error the
			// model is told how to fix rather than a branch here.
			const sortBy = params.sort_by ?? "startTime"
			const sortDir = params.sort_dir ?? "desc"

			const limit = clampLimit(params.limit, { defaultValue: 25, max: 100 })
			const offset = clampOffset(params.offset, { max: 10_000 })

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				sortBy,
				limit,
				offset,
			})

			const page = yield* listAiSessions(
				tenant,
				new ListAiSessionsRequest({
					startTime: st,
					endTime: et,
					limit,
					offset,
					vendorIds: splitCsv(params.vendors),
					serviceNames: splitCsv(params.services),
					deploymentEnvs: splitCsv(params.environments),
					models: splitCsv(params.models),
					agentNames: splitCsv(params.agents),
					toolNames: splitCsv(params.tools),
					search: optionalText(params.search, SEARCH_MAX_CHARS),
					hasErrors: params.has_errors,
					excludeTraceSessions: params.exclude_trace_sessions,
					durationMinMs: measureBound(params.duration_min_ms),
					durationMaxMs: measureBound(params.duration_max_ms),
					costMin: measureBound(params.cost_min),
					costMax: measureBound(params.cost_max),
					tokensMin: countBound(params.tokens_min),
					tokensMax: countBound(params.tokens_max),
					llmCallsMin: countBound(params.llm_calls_min),
					llmCallsMax: countBound(params.llm_calls_max),
					toolCallsMin: countBound(params.tool_calls_min),
					toolCallsMax: countBound(params.tool_calls_max),
					sortBy,
					sortDir,
				}),
			).pipe(Effect.catchTags(warehouseReadToMcpHandlers("list_agent_sessions")))

			const sessions = page.data
			yield* Effect.annotateCurrentSpan("result.rowCount", sessions.length)
			if (sessions.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No AI agent sessions matched the filters (${st} — ${et}).`,
						},
					],
				}
			}

			const rows = sessions.map((session) => [
				session.sessionId,
				session.firstAgentName || "—",
				session.vendorId || "—",
				session.startTime,
				formatDurationFromMs(session.durationMs),
				formatNumber(session.llmCalls),
				formatNumber(session.toolCalls),
				`${session.errorSpanCount}/${session.toolErrorCount}/${session.turnErrorCount}`,
				formatNumber(session.totalTokens),
				session.cost > 0 ? formatCost(session.cost) : "—",
				truncate(session.models.join(", "), 40),
				truncate(session.serviceNames.join(", "), 40),
			])

			const lines: string[] = [
				`## AI agent sessions (showing ${offset + 1}–${offset + sessions.length})`,
				`Time range: ${st} — ${et}`,
				`Every figure is over the session's AGENT spans; the app's own spans in the same traces are not counted. Errors are agent/tool/turn.`,
				``,
				formatTable(
					[
						"Session",
						"Agent",
						"Vendor",
						"Started",
						"Duration",
						"LLM calls",
						"Tool calls",
						"Errors",
						"Tokens",
						"Cost",
						"Models",
						"Services",
					],
					rows,
				),
			]

			const nextSteps = pipe(
				sessions,
				Arr.take(3),
				Arr.map(
					(session) =>
						`\`get_agent_session session_id="${session.sessionId}" ${windowHint({
							startTime: session.startTime,
							endTime: session.endTime,
						})}\` — what happened in ${session.firstAgentName || "this session"}`,
				),
			)
			if (sessions.length === limit) {
				// The window and the limit travel with the offset: a bare `offset=`
				// would page a DIFFERENT list — the default 24h window, 25 at a
				// time — and the filters are the caller's to re-pass.
				nextSteps.push(
					`\`list_agent_sessions start_time="${st}" end_time="${et}" limit=${limit} offset=${offset + limit}\` — next page of ${limit} sessions; re-pass the same filters`,
				)
			}
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "list_agent_sessions",
					data: {
						timeRange: { start: st, end: et },
						offset,
						limit,
						sessions: sessions.map((session) => ({
							sessionId: session.sessionId,
							vendorId: session.vendorId,
							agentName: session.firstAgentName,
							agentNames: [...session.agentNames],
							services: [...session.serviceNames],
							models: [...session.models],
							startTime: session.startTime,
							endTime: session.endTime,
							durationMs: session.durationMs,
							traceCount: session.traceCount,
							spanCount: session.spanCount,
							llmCalls: session.llmCalls,
							toolCalls: session.toolCalls,
							errorSpanCount: session.errorSpanCount,
							toolErrorCount: session.toolErrorCount,
							turnErrorCount: session.turnErrorCount,
							totalTokens: session.totalTokens,
							cost: session.cost,
						})),
					},
				}),
			}
		}),
	)
}
