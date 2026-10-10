import { Effect, Schema } from "effect"
import { AI_SESSION_SEARCH_MAX_CHARS, AI_SESSION_SORT_KEYS, ListAiSessionsRequest } from "@maple/domain/http"
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
	models: filters.models,
	agents: filters.agents,
	tools: filters.tools,
	search: filters.search,
	has_errors: filters.hasErrors,
	sort_by: filters.sortBy,
	sort_dir: filters.sortDir,
})

export function registerListAgentSessionsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_agent_sessions",
		title: "List Agent Sessions",
		description:
			"List AI agent sessions: LLM agent traces carrying gen_ai/maple_ai attributes. Not browser session replays: those are `search_sessions`. One row per session with its agent, vendor, models, LLM and tool calls, failures, tokens and reported cost. Open one with the `get_agent_session` call the result suggests; it carries the session's window, which makes that read a seek.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			vendors: P.optionalList(
				"Vendor ids to match (e.g. eve, vercel_ai_sdk): a row's Vendor column is one",
			),
			services: P.optionalList("Service names to match"),
			models: P.optionalList("Model names to match"),
			agents: P.optionalList("Agent names to match"),
			tools: P.optionalList(
				"Only sessions that called any of these tools (names as `get_agent_tools_overview` lists them)",
			),
			search: boundedText(
				"Part of a session id (matched anywhere in it), or a trace id prefix",
				AI_SESSION_SEARCH_MAX_CHARS,
			),
			has_errors: P.optionalFlag("Only sessions with at least one failed agent span"),
			sort_by: P.optionalOneOf(AI_SESSION_SORT_KEYS, "Sort key (default startTime)"),
			sort_dir: P.optionalOneOf(["asc", "desc"], "Sort direction (default desc)"),
			limit: P.limit({ default: 25, max: 100, noun: "sessions" }),
			offset: P.offset({ max: 10_000 }),
		}),
		// Agents sort rather than bound: the page's min/max and environment filters stay off the tool.
		aliases: { service: "services" },
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
				models: listFilter(params.models),
				agents: listFilter(params.agents),
				tools: listFilter(params.tools),
			}

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.sort_by": sortBy,
				"maple.ai.limit": limit,
				"maple.ai.offset": offset,
			})

			const page = yield* listAiSessions(
				tenant,
				new ListAiSessionsRequest({
					startTime: st,
					endTime: et,
					limit,
					offset,
					vendorIds: lists.vendors,
					serviceNames: lists.services,
					models: lists.models,
					agentNames: lists.agents,
					toolNames: lists.tools,
					search: params.search,
					hasErrors: params.has_errors,
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
					...(lists.models === undefined ? undefined : { models: lists.models }),
					...(lists.agents === undefined ? undefined : { agents: lists.agents }),
					...(lists.tools === undefined ? undefined : { tools: lists.tools }),
					...(params.search === undefined ? undefined : { search: params.search }),
					...(params.has_errors === undefined ? undefined : { hasErrors: params.has_errors }),
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
