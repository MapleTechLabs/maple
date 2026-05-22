import {
	optionalNumberParam,
	optionalStringParam,
	McpQueryError,
	type McpToolRegistrar,
} from "./types"
import { withTenantExecutor, resolveTenant } from "../lib/query-tinybird"
import { resolveTimeRange, formatClampNote } from "../lib/time"
import { clampLimit, clampOffset } from "../lib/limits"
import { formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { createDualContent } from "../lib/structured-output"
import { searchSessions } from "@maple/query-engine/observability"

export function registerSearchSessionsTool(server: McpToolRegistrar) {
	server.tool(
		"search_sessions",
		"Find browser session replays by what happened inside them — errors, failed network requests, console messages, or visited URLs. Returns matching sessions; follow up with `get_session_transcript` to read one. Filters are combined (a single event must match all of them), so pass a coherent set (e.g. event_type=network + http_status_min=500).",
		Schema.Struct({
			start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			event_type: optionalStringParam(
				"Event type to match: navigation, click, input, console, network, or error",
			),
			level: optionalStringParam("Console/error level (e.g. error, warn)"),
			http_status_min: optionalNumberParam("Match network requests with status >= this (e.g. 500)"),
			url_contains: optionalStringParam("Substring match on the event/page URL"),
			message_contains: optionalStringParam("Substring match on console/error message text"),
			trace_id: optionalStringParam("Only sessions that observed this trace id"),
			offset: optionalNumberParam("Offset for pagination (default 0)"),
			limit: optionalNumberParam("Max results (default 25)"),
		}),
		Effect.fn("McpTool.searchSessions")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, { maxHours: 24 * 7 })
			const { st, et } = range
			const lim = clampLimit(params.limit, { defaultValue: 25, max: 200 })
			const off = clampOffset(params.offset, { max: 10_000 })

			const tenant = yield* resolveTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				eventType: params.event_type ?? "any",
				limit: lim,
				offset: off,
			})

			const sessions = yield* withTenantExecutor(
				searchSessions({
					startTime: st,
					endTime: et,
					type: params.event_type ?? undefined,
					level: params.level ?? undefined,
					minStatus: params.http_status_min ?? undefined,
					urlSearch: params.url_contains ?? undefined,
					messageSearch: params.message_contains ?? undefined,
					traceId: params.trace_id ?? undefined,
					limit: lim,
					offset: off,
				}),
			).pipe(
				Effect.catchTag("@maple/query-engine/errors/ObservabilityError", (e) =>
					Effect.fail(
						new McpQueryError({ message: e.message, pipe: e.pipe ?? "search_sessions", cause: e }),
					),
				),
			)

			yield* Effect.annotateCurrentSpan("resultCount", sessions.length)
			if (sessions.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: `No sessions matched the filters (${st} — ${et}).` },
					],
				}
			}

			const lines: string[] = [
				`## Matching sessions (showing ${off + 1}–${off + sessions.length})`,
				`Time range: ${st} — ${et}${formatClampNote(range)}`,
				``,
				formatTable(
					["Session ID", "Matches", "First", "Last"],
					sessions.map((s) => [
						s.sessionId,
						String(s.matchCount),
						s.firstTimestamp,
						s.lastTimestamp,
					]),
				),
			]

			const nextSteps = pipe(
				sessions,
				Arr.take(3),
				Arr.map((s) => `\`get_session_transcript session_id="${s.sessionId}"\` — read the session`),
			)
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "search_sessions",
					data: {
						timeRange: { start: st, end: et },
						sessions: pipe(
							sessions,
							Arr.map((s) => ({
								sessionId: s.sessionId,
								matchCount: s.matchCount,
								firstTimestamp: s.firstTimestamp,
								lastTimestamp: s.lastTimestamp,
							})),
						),
					},
				}),
			}
		}),
	)
}
