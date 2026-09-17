import {
	optionalBooleanParam,
	optionalNumberParam,
	optionalNumericParam,
	optionalStringParam,
	optionalTimeParam,
	type McpToolRegistrar,
} from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS, rangeExceededResult, resolveTimeRange } from "../lib/time"
import { clampLimit, clampOffset, optionalText } from "../lib/limits"
import { formatDurationFromMs, formatNumber, formatTable, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { windowHint } from "../lib/agent-sessions"
import { Effect, Schema } from "effect"
import {
	AI_SESSION_SEARCH_MAX_CHARS,
	AiSessionSortDir,
	AiSessionSortKey,
	CountBound,
	ListAiSessionsRequest,
	RangeBound,
} from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import type { AiSessionFailureSummary } from "@maple/domain/http"
import { splitCsv } from "@maple/domain/where-clause"
import { listAiSessions } from "@maple/backend/services/ai-sessions/ai-session-reads"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"

const csvFilter = (value: string | undefined): string[] | undefined => {
	const entries = value === undefined ? [] : splitCsv(value)
	return entries.length === 0 ? undefined : entries
}

/** The bounds reach a column comparison, so the request refuses a negative one
 *  and a fractional count — declared here, they are a parameter error instead. */
const rangeBound = (description: string) => optionalNumericParam(RangeBound, description)
const countBound = (description: string) => optionalNumericParam(CountBound, description)

export function registerListAgentSessionsTool(server: McpToolRegistrar) {
	server.tool(
		"list_agent_sessions",
		"List AI agent sessions (LLM agent traces stamped with gen_ai/maple_ai attributes — NOT browser session replays, which `search_sessions` serves). Each row is one agent session: its agent, vendor, models, LLM and tool calls, failures, tokens and reported cost. Filter by vendor/service/environment/model/agent/tool, by an id prefix (`search`), by whether it errored, and by duration/cost/token/call ranges. Follow up with `get_agent_session`, passing the start_time/end_time printed on its line below the table — that turns the session read into a seek.",
		Schema.Struct({
			start_time: optionalTimeParam("Start of time range (YYYY-MM-DD HH:mm:ss UTC, default: 24h ago)"),
			end_time: optionalTimeParam("End of time range (YYYY-MM-DD HH:mm:ss UTC, default: now)"),
			vendors: optionalStringParam(
				"Comma-separated vendor ids to match (e.g. eve,vercel_ai_sdk) — a row's Vendor column is one",
			),
			services: optionalStringParam("Comma-separated service names to match"),
			environments: optionalStringParam("Comma-separated deployment environments to match"),
			models: optionalStringParam("Comma-separated model names to match"),
			agents: optionalStringParam("Comma-separated agent names to match"),
			tools: optionalStringParam("Comma-separated tool names the session called"),
			search: Schema.optional(
				Schema.String.check(Schema.isMaxLength(AI_SESSION_SEARCH_MAX_CHARS)),
			).annotate({
				description: "Session id or trace id, or its leading characters (prefix match)",
			}),
			has_errors: optionalBooleanParam("Only sessions with at least one failed agent span"),
			exclude_trace_sessions: optionalBooleanParam(
				"Drop `trace:<id>` sessions — traces whose vendor exposed no session key",
			),
			duration_min_ms: rangeBound("Only sessions at least this long (ms)"),
			duration_max_ms: rangeBound("Only sessions at most this long (ms)"),
			cost_min: rangeBound("Only sessions costing at least this much (USD, as reported)"),
			cost_max: rangeBound("Only sessions costing at most this much (USD)"),
			tokens_min: countBound("Only sessions with at least this many total tokens"),
			tokens_max: countBound("Only sessions with at most this many total tokens"),
			llm_calls_min: countBound("Only sessions with at least this many model calls"),
			llm_calls_max: countBound("Only sessions with at most this many model calls"),
			tool_calls_min: countBound("Only sessions with at least this many tool calls"),
			tool_calls_max: countBound("Only sessions with at most this many tool calls"),
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
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, sortBy, limit, offset })

			const page = yield* listAiSessions(
				tenant,
				new ListAiSessionsRequest({
					startTime: st,
					endTime: et,
					limit,
					offset,
					vendorIds: csvFilter(params.vendors),
					serviceNames: csvFilter(params.services),
					deploymentEnvs: csvFilter(params.environments),
					models: csvFilter(params.models),
					agentNames: csvFilter(params.agents),
					toolNames: csvFilter(params.tools),
					search: optionalText(params.search),
					hasErrors: params.has_errors,
					excludeTraceSessions: params.exclude_trace_sessions,
					durationMinMs: params.duration_min_ms,
					durationMaxMs: params.duration_max_ms,
					costMin: params.cost_min,
					costMax: params.cost_max,
					tokensMin: params.tokens_min,
					tokensMax: params.tokens_max,
					llmCallsMin: params.llm_calls_min,
					llmCallsMax: params.llm_calls_max,
					toolCallsMin: params.tool_calls_min,
					toolCallsMax: params.tool_calls_max,
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
				failuresCell(session.failures) ??
					`${session.errorSpanCount}/${session.toolErrorCount}/${session.turnErrorCount}`,
				formatNumber(session.totalTokens),
				session.cost > 0 ? formatCost(session.cost) : "—",
				truncate(session.models.join(", "), 40),
				truncate(session.serviceNames.join(", "), 40),
			])

			const lines: string[] = [
				`## AI agent sessions (showing ${offset + 1}–${offset + sessions.length})`,
				`Time range: ${st} — ${et}`,
				`Every figure is over the session's AGENT spans; the app's own spans in the same traces are not counted. Failures are by label, ×count; "!" marks one that needs a fix (the run died on it, or its kind always does), the rest were survived. A bare a/b/c is errored agent/tool/turn spans the index could not classify.`,
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
						"Failures",
						"Tokens",
						"Cost",
						"Models",
						"Services",
					],
					rows,
				),
				...(sessions.length === limit
					? [
							``,
							`The page is full; more sessions may match — call again with offset=${offset + sessions.length}.`,
						]
					: []),
				formatNextSteps(
					sessions.slice(0, 3).map(
						(session) =>
							`\`get_agent_session session_id="${session.sessionId}" ${windowHint({
								startTime: session.startTime,
								endTime: session.endTime,
							})}\` — what happened in ${session.firstAgentName || "this session"}`,
					),
				),
			]

			return { content: [{ type: "text" as const, text: lines.join("\n") }] }
		}),
	)
}

/** `!context_length_exceeded, tool_error · run_tests ×2` — the row's failures
 *  by label, a `!` on each one that needs a fix. `undefined` when the index
 *  classified none, and the raw counts say what it saw. */
function failuresCell(failures: ReadonlyArray<AiSessionFailureSummary>): string | undefined {
	if (failures.length === 0) return undefined
	return truncate(
		failures
			.map(
				(failure) =>
					`${failure.severity === "failure" ? "!" : ""}${failure.label}${failure.count > 1 ? ` ×${failure.count}` : ""}`,
			)
			.join(", "),
		80,
	)
}
