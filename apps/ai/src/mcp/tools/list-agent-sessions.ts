import { Effect, Schema } from "effect"
import {
	AI_SESSION_SEARCH_MAX_CHARS,
	AI_SESSION_SORT_KEYS,
	CountBound,
	ListAiSessionsRequest,
	RangeBound,
} from "@maple/domain/http"
import { ListAgentSessionsOutput } from "@maple/domain/mcp-outputs"
import { formatCost } from "@maple/agent-sessions"
import { listAiSessions } from "@maple/backend/services/ai-sessions/ai-session-reads"
import type { McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { formatDurationFromMs, formatNumber, truncate } from "../lib/format"
import { paddedWindowArgs } from "../lib/agent-sessions"
import { boundedText } from "../lib/agent-tool-analytics"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const WINDOW = P.timeWindow({ defaultHours: 24, maxHours: MCP_SEARCH_MAX_HOURS })

/** The bounds reach a column comparison, so the request refuses a negative one and a fractional
 *  count; declared here, they are a parameter error instead. */
const rangeBound = (description: string) =>
	P.optionalNumber(description).pipe(Schema.decodeTo(Schema.optional(RangeBound)))
const countBound = (description: string) =>
	P.optionalNumber(description).pipe(Schema.decodeTo(Schema.optional(CountBound)))

/** A list filter, trimmed; an empty list is no filter. */
const listFilter = (values: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined => {
	const entries = (values ?? []).map((value) => value.trim()).filter((value) => value !== "")
	return entries.length === 0 ? undefined : entries
}

type Filters = typeof ListAgentSessionsOutput.Type.filters

/** The filters as the parameters that set them, so a next page repeats the call. */
const filterArgs = (filters: Filters) => ({
	vendors: filters.vendors,
	services: filters.services,
	environments: filters.environments,
	models: filters.models,
	agents: filters.agents,
	tools: filters.tools,
	search: filters.search,
	has_errors: filters.hasErrors,
	exclude_trace_sessions: filters.excludeTraceSessions,
	duration_min_ms: filters.durationMinMs,
	duration_max_ms: filters.durationMaxMs,
	cost_min: filters.costMin,
	cost_max: filters.costMax,
	tokens_min: filters.tokensMin,
	tokens_max: filters.tokensMax,
	llm_calls_min: filters.llmCallsMin,
	llm_calls_max: filters.llmCallsMax,
	tool_calls_min: filters.toolCallsMin,
	tool_calls_max: filters.toolCallsMax,
	sort_by: filters.sortBy,
	sort_dir: filters.sortDir,
})

export function registerListAgentSessionsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_agent_sessions",
		description:
			"List AI agent sessions (LLM agent traces stamped with gen_ai/maple_ai attributes, NOT browser session replays, which `search_sessions` serves). Each row is one agent session: its agent, vendor, models, LLM and tool calls, failures, tokens and reported cost. Filter by vendor/service/environment/model/agent/tool, by an id prefix (`search`), by whether it errored, and by duration/cost/token/call ranges. Follow up with the `get_agent_session` call suggested for a row: it carries the session's start_time/end_time, which turns the session read into a seek.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			vendors: P.optionalList(
				"Vendor ids to match (e.g. eve, vercel_ai_sdk): a row's Vendor column is one",
			),
			services: P.optionalList("Service names to match"),
			environments: P.optionalList("Deployment environments to match"),
			models: P.optionalList("Model names to match"),
			agents: P.optionalList("Agent names to match"),
			tools: P.optionalList("Tool names the session called"),
			search: boundedText(
				"Session id or trace id, or its leading characters (prefix match)",
				AI_SESSION_SEARCH_MAX_CHARS,
			),
			has_errors: P.optionalFlag("Only sessions with at least one failed agent span"),
			exclude_trace_sessions: P.optionalFlag(
				"Drop `trace:<id>` sessions: traces whose vendor exposed no session key",
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
			sort_by: P.optionalOneOf(AI_SESSION_SORT_KEYS, "Sort key (default startTime)"),
			sort_dir: P.optionalOneOf(["asc", "desc"], "Sort direction (default desc)"),
			limit: P.limit({ default: 25, max: 100, noun: "sessions" }),
			offset: P.offset({ max: 10_000 }),
		}),
		output: ListAgentSessionsOutput,
		hints: { readOnly: true },
		phrases: ["Listing agent sessions"],
		handler: Effect.fn("McpTool.listAgentSessions")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "list_agent_sessions")
			const sortBy = params.sort_by ?? "startTime"
			const sortDir = params.sort_dir ?? "desc"
			const { limit, offset } = params
			const lists = {
				vendors: listFilter(params.vendors),
				services: listFilter(params.services),
				environments: listFilter(params.environments),
				models: listFilter(params.models),
				agents: listFilter(params.agents),
				tools: listFilter(params.tools),
			}

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, sortBy, limit, offset })

			const page = yield* listAiSessions(
				tenant,
				new ListAiSessionsRequest({
					startTime: st,
					endTime: et,
					limit,
					offset,
					vendorIds: lists.vendors,
					serviceNames: lists.services,
					deploymentEnvs: lists.environments,
					models: lists.models,
					agentNames: lists.agents,
					toolNames: lists.tools,
					search: params.search,
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
			// A full page may have more behind it; the client pages the same way.
			const hasMore = sessions.length === limit
			return {
				timeRange: { start: st, end: et },
				sessions,
				pagination: {
					offset,
					limit,
					hasMore,
					...(hasMore ? { nextOffset: offset + sessions.length } : undefined),
				},
				filters: {
					...(lists.vendors === undefined ? undefined : { vendors: lists.vendors }),
					...(lists.services === undefined ? undefined : { services: lists.services }),
					...(lists.environments === undefined ? undefined : { environments: lists.environments }),
					...(lists.models === undefined ? undefined : { models: lists.models }),
					...(lists.agents === undefined ? undefined : { agents: lists.agents }),
					...(lists.tools === undefined ? undefined : { tools: lists.tools }),
					...(params.search === undefined ? undefined : { search: params.search }),
					...(params.has_errors === undefined ? undefined : { hasErrors: params.has_errors }),
					...(params.exclude_trace_sessions === undefined
						? undefined
						: { excludeTraceSessions: params.exclude_trace_sessions }),
					...(params.duration_min_ms === undefined
						? undefined
						: { durationMinMs: params.duration_min_ms }),
					...(params.duration_max_ms === undefined
						? undefined
						: { durationMaxMs: params.duration_max_ms }),
					...(params.cost_min === undefined ? undefined : { costMin: params.cost_min }),
					...(params.cost_max === undefined ? undefined : { costMax: params.cost_max }),
					...(params.tokens_min === undefined ? undefined : { tokensMin: params.tokens_min }),
					...(params.tokens_max === undefined ? undefined : { tokensMax: params.tokens_max }),
					...(params.llm_calls_min === undefined
						? undefined
						: { llmCallsMin: params.llm_calls_min }),
					...(params.llm_calls_max === undefined
						? undefined
						: { llmCallsMax: params.llm_calls_max }),
					...(params.tool_calls_min === undefined
						? undefined
						: { toolCallsMin: params.tool_calls_min }),
					...(params.tool_calls_max === undefined
						? undefined
						: { toolCallsMax: params.tool_calls_max }),
					sortBy,
					sortDir,
				},
			}
		}),
		render: (output) => {
			const { sessions, pagination } = output
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			return {
				title: "AI agent sessions",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Rows", pagination.offset > 0 ? `from ${pagination.offset + 1}` : undefined],
				],
				...(sessions.length === 0
					? {
							empty: {
								message: "No AI agent sessions matched the filters.",
								hints: ["Widen start_time/end_time, or drop some filters."],
							},
						}
					: undefined),
				blocks:
					sessions.length === 0
						? []
						: [
								doc.text(
									"Every figure is over the session's AGENT spans; the app's own spans in the same traces are not counted. Errors are agent/tool/turn.",
								),
								doc.table(
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
									sessions.map((session) => [
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
									]),
								),
							],
				...(pagination.nextOffset === undefined
					? undefined
					: {
							truncation: {
								shown: sessions.length,
								noun: "sessions (the page is full; more may match)",
								next: doc.next(
									"list_agent_sessions",
									{
										...window,
										...filterArgs(output.filters),
										limit: pagination.limit,
										offset: pagination.nextOffset,
									},
									"next page",
								),
							},
						}),
				next: sessions
					.slice(0, 3)
					.map((session) =>
						doc.next(
							"get_agent_session",
							{ session_id: session.sessionId, ...paddedWindowArgs(session) },
							`what happened in ${session.firstAgentName || "this session"}`,
						),
					),
			}
		},
	})
}
