import {
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { clampLimit } from "@/mcp/lib/limits"
import { formatDurationFromMs, formatNumber, formatTable, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { createDualContent } from "@/mcp/lib/structured-output"
import {
	catchSessionTooLarge,
	offsetLabel,
	requiredIdOf,
	sessionWindowOf,
	sessionWindowParams,
	spanCategoryLabel,
	windowHint,
} from "@/mcp/lib/agent-sessions"
import { Effect, Option, Schema } from "effect"
import { AiSessionSpanCursor, AiSessionSpanScope, GetAiSessionSpansRequest } from "@maple/domain/http"
import { spanModel, spanStartMs, spanTokenBuckets, spanFailed } from "@maple/agent-sessions"
import { readAiSessionSpans } from "@/services/ai-sessions/ai-session-reads"
import { warehouseReadToMcpHandlers } from "@/mcp/lib/map-warehouse-error"

const decodeCursor = Schema.decodeUnknownOption(AiSessionSpanCursor)

/** What to do about a page the read cannot carry. */
const PAGE_TOO_LARGE = "Pass a smaller `limit`."

export function registerListAgentSessionSpansTool(server: McpToolRegistrar) {
	server.tool(
		"list_agent_session_spans",
		"List one page of an AI agent session's spans (an LLM agent trace, not a browser session replay), oldest first: category, name, service, duration, status, model or tool, tokens, and the span/parent/trace ids. Use it to find the span behind a finding, or to walk a session too large for `get_agent_session`. `scope` picks the agent's own spans (`ai`), the app's spans sharing its traces (`app`), or both (`all`). Inspect one with `inspect_agent_session_span`.",
		Schema.Struct({
			session_id: requiredStringParam("The agent session id, from `list_agent_sessions`"),
			...sessionWindowParams,
			scope: Schema.optional(AiSessionSpanScope).annotate({
				description:
					"Which spans: all (default), ai (the agent's own), or app (the service's own work in the same traces)",
			}),
			after_timestamp: optionalStringParam(
				"Keyset cursor: the `timestamp` from a previous page's nextCursor (pass with after_span_id)",
			),
			after_span_id: optionalStringParam(
				"Keyset cursor: the `spanId` from a previous page's nextCursor",
			),
			limit: optionalNumberParam("Max spans to return (default 100, max 500)"),
		}),
		Effect.fn("McpTool.listAgentSessionSpans")(function* (params) {
			const windowInput = sessionWindowOf(params)
			if (windowInput._tag === "invalid") return windowInput.result
			const idInput = requiredIdOf(params.session_id, "session_id", 'session_id="wrun_01KZ…"')
			if (idInput._tag === "invalid") return idInput.result
			const sessionId = idInput.id

			// Published as an enum, so an unknown scope is a parameter error the
			// model is told how to fix rather than a branch here.
			const scope = params.scope ?? "all"

			const hasCursorHalf = params.after_timestamp !== undefined || params.after_span_id !== undefined
			const cursor =
				params.after_timestamp !== undefined && params.after_span_id !== undefined
					? decodeCursor({ timestamp: params.after_timestamp, spanId: params.after_span_id })
					: Option.none()
			if (hasCursorHalf && Option.isNone(cursor)) {
				return validationError(
					"after_timestamp and after_span_id are a pair, copied verbatim from a previous page's next-page hint (the timestamp keeps its nanoseconds).",
				)
			}

			const limit = clampLimit(params.limit, { defaultValue: 100, max: 500 })
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				sessionId,
				scope,
				limit,
			})

			const page = yield* readAiSessionSpans(
				tenant,
				new GetAiSessionSpansRequest({
					sessionId,
					scope,
					limit,
					...(windowInput.window !== undefined && windowInput.window),
					...(Option.isSome(cursor) && { after: cursor.value }),
				}),
			).pipe(Effect.catchTags(warehouseReadToMcpHandlers("list_agent_session_spans")))

			const spans = page.data
			yield* Effect.annotateCurrentSpan("result.rowCount", spans.length)
			if (spans.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No ${scope === "all" ? "" : `${scope} `}spans for AI agent session ${sessionId}${
								windowInput.window === undefined ? "" : " in the given window"
							}. Check the id with \`list_agent_sessions\`.`,
						},
					],
				}
			}

			// Offsets are from this page's first span: a page reached by cursor has
			// no view of where the session began.
			const baseMs = spanStartMs(spans[0])
			const rows = spans.map((span) => {
				const tokens = spanTokenBuckets(span)
				return [
					offsetLabel(spanStartMs(span) - baseMs),
					spanCategoryLabel(span),
					truncate(span.spanName, 60),
					span.serviceName,
					formatDurationFromMs(span.durationMs),
					spanFailed(span) ? "FAILED" : span.statusCode,
					span.genAi.toolName ?? spanModel(span) ?? "—",
					tokens === undefined || tokens.total === 0 ? "—" : formatNumber(tokens.total),
					span.spanId,
					span.parentSpanId || "—",
					span.traceId,
				]
			})

			const lines: string[] = [
				`## AI agent session ${sessionId} — ${spans.length} spans (scope ${scope})`,
				`Oldest first; offsets are from the first span on this page.`,
				``,
				formatTable(
					[
						"At",
						"Kind",
						"Name",
						"Service",
						"Duration",
						"Status",
						"Model/Tool",
						"Tokens",
						"Span",
						"Parent",
						"Trace",
					],
					rows,
				),
			]

			const hint = windowInput.window === undefined ? "" : ` ${windowHint(windowInput.window)}`
			const nextSteps: string[] = []
			if (page.nextCursor !== undefined) {
				nextSteps.push(
					`\`list_agent_session_spans session_id="${sessionId}"${hint} scope="${scope}" after_timestamp="${page.nextCursor.timestamp}" after_span_id="${page.nextCursor.spanId}"\` — next page`,
				)
			}
			const interesting = spans.find(spanFailed) ?? spans[0]
			nextSteps.push(
				`\`inspect_agent_session_span session_id="${sessionId}" trace_id="${interesting.traceId}" span_id="${interesting.spanId}"${hint}\` — messages and tool calls on ${
					spanFailed(interesting) ? "the first failed span" : "a span"
				}`,
			)
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "list_agent_session_spans",
					data: {
						sessionId,
						scope,
						spans: spans.map((span) => {
							const tokens = spanTokenBuckets(span)
							return {
								timestamp: span.timestamp,
								traceId: span.traceId,
								spanId: span.spanId,
								parentSpanId: span.parentSpanId,
								name: span.spanName,
								category: spanCategoryLabel(span),
								serviceName: span.serviceName,
								durationMs: span.durationMs,
								statusCode: span.statusCode,
								failed: spanFailed(span),
								model: spanModel(span) ?? null,
								toolName: span.genAi.toolName ?? null,
								totalTokens: tokens?.total ?? null,
							}
						}),
						nextCursor:
							page.nextCursor === undefined
								? undefined
								: { timestamp: page.nextCursor.timestamp, spanId: page.nextCursor.spanId },
					},
				}),
			}
		}, catchSessionTooLarge(PAGE_TOO_LARGE)),
	)
}
