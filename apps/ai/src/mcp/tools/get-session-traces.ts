import { Effect, Schema } from "effect"
import { GetSessionTracesOutput } from "@maple/domain/mcp-outputs"
import { getSessionTraces } from "@maple/query-engine/observability"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerGetSessionTracesTool(server: McpToolRegistrar) {
	server.define({
		name: "get_session_traces",
		description:
			"The backend traces a browser session replay observed (session id from `search_sessions`; not an AI agent session), with the session's client, user and error summary. Use it to jump from a user's session to the requests behind it; `inspect_trace` opens one.",
		parameters: Schema.Struct({
			session_id: P.text("The session id to read (from search_sessions)"),
			limit: P.limit({ default: 50, max: 100, noun: "traces" }),
		}),
		output: GetSessionTracesOutput,
		hints: { readOnly: true },
		phrases: ["Loading session traces"],
		handler: Effect.fn("McpTool.getSessionTraces")(function* ({ session_id, limit }) {
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, sessionId: session_id, limit })

			const { session, traces, totalTraceCount } = yield* withTenantExecutor(
				getSessionTraces({ sessionId: session_id, limit }),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("get_session_traces")))

			if (!session) {
				return yield* new McpInvalidInputError({
					message: `No browser session ${session_id} found (it may predate replay capture or be outside retention).`,
					parameter: "session_id",
				})
			}
			yield* Effect.annotateCurrentSpan("traceCount", traces.length)

			// ClickHouse serializes integer aggregates as JSON strings while Tinybird returns numbers
			// (see the facets handler in session-replay.http.ts); coerce every numeric at the edge.
			return {
				session: {
					sessionId: session.sessionId,
					startTime: session.startTime,
					endTime: session.endTime,
					durationMs: session.durationMs != null ? Number(session.durationMs) : null,
					status: session.status,
					userId: session.userId,
					urlInitial: truncate(session.urlInitial, 256),
					browserName: session.browserName,
					osName: session.osName,
					deviceType: session.deviceType,
					country: session.country,
					serviceName: session.serviceName,
					pageViews: Number(session.pageViews),
					clickCount: Number(session.clickCount),
					errorCount: Number(session.errorCount),
					activeTimeMs: session.activeTimeMs != null ? Number(session.activeTimeMs) : null,
					idleTimeMs: session.idleTimeMs != null ? Number(session.idleTimeMs) : null,
				},
				totalTraceCount: Number(totalTraceCount),
				traces: traces.map((t) => ({
					traceId: t.traceId,
					startTime: t.startTime,
					durationMs: Number(t.durationMs),
					rootSpanName: t.rootSpanName,
					rootServiceName: t.rootServiceName,
					spanCount: Number(t.spanCount),
					hasError: Number(t.hasError) === 1,
				})),
			}
		}),
		render: ({ session, traces, totalTraceCount }) => {
			const device = [session.browserName, session.osName, session.deviceType]
				.filter(Boolean)
				.join(" / ")
			const summary = [
				device || "unknown client",
				session.country || undefined,
				session.errorCount > 0 ? `${session.errorCount} errors` : "no errors",
				session.durationMs !== null ? `${Math.round(session.durationMs)}ms total` : undefined,
				session.activeTimeMs !== null ? `${Math.round(session.activeTimeMs)}ms active` : undefined,
				session.idleTimeMs !== null ? `${Math.round(session.idleTimeMs)}ms idle` : undefined,
			].filter((part): part is string => part !== undefined)
			// Drill-down hints: errored traces first, then the rest.
			const ranked = [...traces].sort((a, b) => Number(b.hasError) - Number(a.hasError))
			return {
				title: `Session ${session.sessionId}`,
				scope: [
					["Entry URL", session.urlInitial ? truncate(session.urlInitial, 120) : undefined],
					["User", session.userId || undefined],
				],
				...(traces.length === 0
					? { empty: { message: "This session observed no backend traces." } }
					: undefined),
				blocks: [
					doc.text(summary.join(" · ")),
					...(traces.length === 0
						? []
						: [
								doc.heading("Backend traces"),
								doc.table(
									["Trace ID", "Root span", "Service", "Duration", "Error", "Spans"],
									traces.map((t) => [
										t.traceId,
										truncate(t.rootSpanName || "—", 40),
										truncate(t.rootServiceName || "—", 30),
										`${Math.round(t.durationMs)}ms`,
										t.hasError ? "✕" : "",
										String(t.spanCount),
									]),
								),
							]),
				],
				...(totalTraceCount > traces.length
					? { truncation: { shown: traces.length, total: totalTraceCount, noun: "traces" } }
					: undefined),
				next: ranked
					.slice(0, 3)
					.map((t) =>
						doc.next(
							"inspect_trace",
							{ trace_id: t.traceId, timestamp: t.startTime },
							`${t.hasError ? "errored " : ""}${t.rootSpanName || "trace"} in ${t.rootServiceName || "?"}`,
						),
					),
			}
		},
	})
}
