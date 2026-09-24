import { Effect, Schema } from "effect"
import { SearchSessionsOutput } from "@maple/domain/mcp-outputs"
import { searchSessions } from "@maple/query-engine/observability"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_SEARCH_MAX_HOURS })

type Filters = typeof SearchSessionsOutput.Type.filters

/** The filters as the parameters that set them, so a next page repeats the call. */
const filterArgs = (filters: Filters) => ({
	user_id: filters.userId,
	user_search: filters.userSearch,
	group_name: filters.groupName,
	service: filters.service,
	browser: filters.browser,
	country: filters.country,
	device_type: filters.deviceType,
	has_errors: filters.hasErrors,
	duration_min_ms: filters.durationMinMs,
	duration_max_ms: filters.durationMaxMs,
	active_min_ms: filters.activeMinMs,
	active_max_ms: filters.activeMaxMs,
	event_type: filters.eventType,
	level: filters.level,
	http_status_min: filters.httpStatusMin,
	url_contains: filters.urlContains,
	message_contains: filters.messageContains,
	trace_id: filters.traceId,
})

export function registerSearchSessionsTool(server: McpToolRegistrar) {
	server.define({
		name: "search_sessions",
		description:
			"Browser session replays (end-user web sessions), not AI agent sessions: for those use `list_agent_sessions`. List and filter browser session replays. Filter by WHO (user_id: the app's end-user id; user_search: their name or email; group_name: their company/team), by client (browser, country, device_type), by whether the session errored (has_errors), by how long it lasted (duration/active bounds), and/or by WHAT HAPPENED inside it (event_type, level, http_status_min, url_contains, message_contains, trace_id). Returns each session's metadata including the end-user id. All filters are ANDed. Follow up with `get_session_transcript` to read a session's events or `get_session_traces` to see the backend traces it produced.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			// Session metadata filters (who / where / how long)
			user_id: P.optionalText("Exact match on the session's end-user id (e.g. 4632)"),
			user_search: P.optionalText(
				"Case-insensitive substring match on the identified user's name or email (e.g. ada, @acme.com)",
			),
			group_name: P.optionalText(
				"Exact match on the identified group (company / team) name (e.g. Acme Inc)",
			),
			service: P.service("Exact match on the session's service name"),
			browser: P.optionalText("Exact match on browser name (e.g. Chrome)"),
			country: P.optionalText("Exact match on country"),
			device_type: P.optionalText("Exact match on device type (e.g. desktop, mobile)"),
			has_errors: P.optionalFlag("Only sessions with at least one recorded error"),
			duration_min_ms: P.optionalNumber("Only sessions at least this long (ms)"),
			duration_max_ms: P.optionalNumber("Only sessions at most this long (ms)"),
			active_min_ms: P.optionalNumber(
				"Only sessions with at least this much active (non-idle) time (ms)",
			),
			active_max_ms: P.optionalNumber("Only sessions with at most this much active time (ms)"),
			// In-session event refinement (what happened)
			event_type: P.optionalOneOf(
				["navigation", "click", "input", "console", "network", "error"],
				"Match sessions that contain this event type",
			),
			level: P.optionalText("Console/error level to match (e.g. error, warn)"),
			http_status_min: P.optionalNumber(
				"Match sessions with a network request status >= this (e.g. 500)",
			),
			url_contains: P.optionalText("Substring match on an in-session event/page URL"),
			message_contains: P.optionalText("Substring match on an in-session console/error message"),
			trace_id: P.optionalText("Only sessions that observed this trace id"),
			offset: P.offset({ max: 10_000 }),
			limit: P.limit({ default: 25, max: 200, noun: "sessions" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: SearchSessionsOutput,
		hints: { readOnly: true },
		phrases: ["Searching sessions"],
		handler: Effect.fn("McpTool.searchSessions")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "search_sessions")
			const lim = params.limit
			const off = params.offset

			// Whether any in-session event predicate is active: drives the Matches column. Uses
			// `!== undefined` to match the query layer's `needsEventFilter`, so `http_status_min=0`
			// applies the INNER JOIN in SQL and the column alike.
			const eventFiltered =
				params.event_type !== undefined ||
				params.level !== undefined ||
				params.http_status_min !== undefined ||
				params.url_contains !== undefined ||
				params.message_contains !== undefined ||
				params.trace_id !== undefined

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				userId: params.user_id ?? "any",
				eventType: params.event_type ?? "any",
				limit: lim,
				offset: off,
			})

			const sessions = yield* withTenantExecutor(
				searchSessions({
					startTime: st,
					endTime: et,
					userId: params.user_id,
					userSearch: params.user_search,
					groupName: params.group_name,
					serviceName: params.service,
					browser: params.browser,
					country: params.country,
					deviceType: params.device_type,
					hasErrors: params.has_errors,
					durationMinMs: params.duration_min_ms,
					durationMaxMs: params.duration_max_ms,
					activeTimeMinMs: params.active_min_ms,
					activeTimeMaxMs: params.active_max_ms,
					eventType: params.event_type,
					eventLevel: params.level,
					eventMinStatus: params.http_status_min,
					eventUrlSearch: params.url_contains,
					eventMessageSearch: params.message_contains,
					eventTraceId: params.trace_id,
					limit: lim,
					offset: off,
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("search_sessions")))

			yield* Effect.annotateCurrentSpan("result.rowCount", sessions.length)

			const hasMore = sessions.length === lim
			return {
				timeRange: { start: st, end: et },
				// ClickHouse serializes 64-bit integer aggregates as JSON strings while Tinybird returns
				// numbers; coerce every numeric at the edge.
				sessions: sessions.map((s) => ({
					sessionId: s.sessionId,
					userId: s.userId,
					userName: s.userName,
					userEmail: s.userEmail,
					groupId: s.groupId,
					groupName: s.groupName,
					startTime: s.startTime,
					durationMs: s.durationMs != null ? Number(s.durationMs) : null,
					status: s.status,
					browserName: s.browserName,
					osName: s.osName,
					deviceType: s.deviceType,
					country: s.country,
					serviceName: s.serviceName,
					pageViews: Number(s.pageViews),
					clickCount: Number(s.clickCount),
					errorCount: Number(s.errorCount),
					traceCount: Number(s.traceCount),
					urlInitial: truncate(s.urlInitial, 256),
					...(eventFiltered ? { matchCount: Number(s.matchCount ?? 0) } : undefined),
				})),
				pagination: {
					offset: off,
					limit: lim,
					hasMore,
					...(hasMore ? { nextOffset: off + lim } : undefined),
				},
				filters: {
					...(params.user_id === undefined ? undefined : { userId: params.user_id }),
					...(params.user_search === undefined ? undefined : { userSearch: params.user_search }),
					...(params.group_name === undefined ? undefined : { groupName: params.group_name }),
					...(params.service === undefined ? undefined : { service: params.service }),
					...(params.browser === undefined ? undefined : { browser: params.browser }),
					...(params.country === undefined ? undefined : { country: params.country }),
					...(params.device_type === undefined ? undefined : { deviceType: params.device_type }),
					...(params.has_errors === undefined ? undefined : { hasErrors: params.has_errors }),
					...(params.duration_min_ms === undefined
						? undefined
						: { durationMinMs: params.duration_min_ms }),
					...(params.duration_max_ms === undefined
						? undefined
						: { durationMaxMs: params.duration_max_ms }),
					...(params.active_min_ms === undefined
						? undefined
						: { activeMinMs: params.active_min_ms }),
					...(params.active_max_ms === undefined
						? undefined
						: { activeMaxMs: params.active_max_ms }),
					...(params.event_type === undefined ? undefined : { eventType: params.event_type }),
					...(params.level === undefined ? undefined : { level: params.level }),
					...(params.http_status_min === undefined
						? undefined
						: { httpStatusMin: params.http_status_min }),
					...(params.url_contains === undefined ? undefined : { urlContains: params.url_contains }),
					...(params.message_contains === undefined
						? undefined
						: { messageContains: params.message_contains }),
					...(params.trace_id === undefined ? undefined : { traceId: params.trace_id }),
				},
				eventFiltered,
			}
		}),
		render: (output) => {
			const { sessions, pagination, eventFiltered } = output
			const headers = [
				"User",
				"Started",
				"Duration",
				"Browser",
				"Device",
				"Country",
				"Errors",
				"Entry URL",
			]
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			return {
				title: "Sessions",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Rows", pagination.offset > 0 ? `from ${pagination.offset + 1}` : undefined],
				],
				...(sessions.length === 0
					? {
							empty: {
								message: "No sessions matched the filters.",
								hints: ["Widen start_time/end_time, or drop some filters (they are ANDed)."],
							},
						}
					: undefined),
				blocks:
					sessions.length === 0
						? []
						: [
								doc.table(
									eventFiltered ? [...headers, "Matches"] : headers,
									sessions.map((s) => {
										const device = [s.osName, s.deviceType].filter(Boolean).join(" / ")
										const row = [
											// Same fallback chain as the web list: a name beats an opaque id.
											s.userName || s.userEmail || s.userId || "Anonymous",
											s.startTime,
											s.durationMs !== null ? `${Math.round(s.durationMs)}ms` : "—",
											s.browserName || "—",
											device || "—",
											s.country || "—",
											s.errorCount > 0 ? String(s.errorCount) : "",
											truncate(s.urlInitial, 60),
										]
										return eventFiltered ? [...row, String(s.matchCount ?? 0)] : row
									}),
								),
							],
				...(pagination.nextOffset === undefined
					? undefined
					: {
							truncation: {
								shown: sessions.length,
								noun: "sessions",
								next: doc.next(
									"search_sessions",
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
					.map((s) =>
						doc.next(
							"get_session_transcript",
							{ session_id: s.sessionId },
							`read ${s.userId ? `${s.userId}'s` : "the"} session`,
						),
					),
			}
		},
	})
}
