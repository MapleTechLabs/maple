import { optionalNumberParam, optionalStringParam, requiredStringParam, type McpToolRegistrar } from "./types"
import { warehouseReadToMcpHandlers, warehouseToMcpHandlers } from "@/mcp/lib/map-warehouse-error"
import { CurrentMcpTenant, withTenantExecutor } from "@/mcp/lib/query-warehouse"
import { clampLimit } from "@/mcp/lib/limits"
import { truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { catchSessionTooLarge } from "@/mcp/lib/agent-sessions"
import { hasAiSignal, renderAiSpan } from "@/mcp/lib/render-ai-span"
import { spanDetail } from "@maple/query-engine/observability"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { AI_SESSION_SPANS_MAX_SPANS, GetAiSessionSpansRequest, TraceIdHex } from "@maple/domain/http"
import { readAiSessionSpans } from "@/services/ai-sessions/ai-session-reads"

/** Half-width of the window the AI read is bounded by. A trace is a single
 *  agent turn's worth of work, so an hour either side of the span covers it. */
const TRACE_WINDOW_MS = 60 * 60 * 1000

/** What to do about a trace whose spans no read can carry. */
const TRACE_TOO_LARGE =
	"Read the spans a page at a time with `list_agent_session_spans` and a small `limit` — `session_id` is the span's `maple_ai.session.id`, or `trace:<trace_id>` where it has none."

/**
 * The AI read pins the trace id into a warehouse param, so it must be the
 * 32-hex shape the domain requires; a span in a trace stored under any other
 * id shape still gets its raw attributes, just not the decoded view.
 */
const isTraceIdHex = Schema.is(TraceIdHex)

export function registerInspectSpanTool(server: McpToolRegistrar) {
	server.tool(
		"inspect_span",
		"Get the full attribute set for a single span (use after `inspect_trace`, which shows only a trimmed set of attributes per span). Pass the `span_id` shown in the trace tree. Pass `timestamp` (any timestamp from the trace) to prune ClickHouse partitions. For an AI agent span (an LLM call, a tool execution, an agent invocation) it also decodes the gen_ai attributes, the messages the span captured and the tool calls it made or executed, with each call's result resolved from the rest of its trace.",
		Schema.Struct({
			trace_id: requiredStringParam("The trace ID the span belongs to"),
			span_id: requiredStringParam("The span ID to inspect (from `inspect_trace` output)"),
			timestamp: optionalStringParam(
				"ISO-8601 timestamp of the span (e.g. from `search_traces` results). Narrows the ClickHouse scan to a ±1h window.",
			),
			payload_chars: optionalNumberParam(
				"AI spans only: characters of each captured message and payload to show (default 2000, max 20000)",
			),
		}),
		Effect.fn("McpTool.inspectSpan")(function* ({ trace_id, span_id, timestamp, payload_chars }) {
			yield* Effect.annotateCurrentSpan({ traceId: trace_id, spanId: span_id })

			const timestampHint = timestamp ? new Date(timestamp) : undefined
			if (timestampHint && Number.isNaN(timestampHint.getTime())) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Invalid timestamp: ${timestamp}. Expected ISO-8601 (e.g. 2026-04-15T14:30:00Z).`,
						},
					],
				}
			}

			const result = yield* withTenantExecutor(
				spanDetail({ traceId: trace_id, spanId: span_id, timestampHint }),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("span_detail")))

			if (!result.found) {
				const hint = timestampHint
					? ""
					: " Pass `timestamp` from the trace if the span is older than the default scan window."
				return {
					content: [
						{
							type: "text" as const,
							text: `Span ${span_id} not found in trace ${trace_id}.${hint}`,
						},
					],
				}
			}

			// The decoded view needs the whole trace, not this span alone: the
			// results of the tool calls a model span requested are captured on the
			// tool spans that ran them.
			const isAiSpan = hasAiSignal(result.spanAttributes)
			yield* Effect.annotateCurrentSpan("maple.ai.span", isAiSpan)
			const ai =
				isAiSpan && isTraceIdHex(trace_id)
					? yield* decodeAiSpan({
							traceId: trace_id,
							spanId: span_id,
							startTime: result.startTime,
							payloadChars: clampLimit(payload_chars, { defaultValue: 2_000, max: 20_000 }),
						})
					: undefined

			const renderAttrs = (label: string, attrs: Record<string, string>): string[] => {
				const entries = Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))
				if (entries.length === 0) return []
				return [
					``,
					`### ${label} (${entries.length})`,
					...entries.map(([k, v]) => `- \`${k}\`: ${truncate(String(v), 500)}`),
				]
			}

			const lines: string[] = [
				`## Span ${span_id} (trace ${trace_id})`,
				...(ai?._tag === "decoded" ? ai.lines : []),
				...(ai?._tag === "partial"
					? [
							``,
							`This is an AI agent span, but only the first ${ai.readSpans} spans of trace ${trace_id} were read and it is not among them, so its messages and tool calls are not decoded below. ${TRACE_TOO_LARGE}`,
						]
					: []),
				...renderAttrs("Span attributes", result.spanAttributes),
				...renderAttrs("Resource attributes", result.resourceAttributes),
			]

			if (
				Object.keys(result.spanAttributes).length === 0 &&
				Object.keys(result.resourceAttributes).length === 0
			) {
				lines.push(``, `This span has no attributes recorded.`)
			}

			lines.push(
				formatNextSteps([
					`\`inspect_trace trace_id="${trace_id}"\` — see the full span tree`,
					`\`search_logs trace_id="${trace_id}" span_id="${span_id}"\` — logs for this span`,
					// A vendor that exposed no session key still has a session: the
					// trace itself, under the id the session model synthesises for it.
					...(ai?._tag === "decoded"
						? [
								`\`get_agent_session session_id="${ai.sessionId ?? `trace:${trace_id}`}"\` — the agent session this span ran in`,
							]
						: []),
				]),
			)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "inspect_span",
					data: {
						traceId: trace_id,
						spanId: span_id,
						found: result.found,
						attributes: result.spanAttributes,
						resourceAttributes: result.resourceAttributes,
						...(ai?._tag === "decoded" && { ai: ai.data }),
					},
				}),
			}
		}, catchSessionTooLarge(TRACE_TOO_LARGE)),
	)
}

/**
 * The span's trace, read as agent spans and decoded.
 *
 * The read is keyed on the trace and bounded by a window around the span's own
 * timestamp — `trace_detail_spans` is partitioned by day, so an unbounded trace
 * lookup seeks every partition. The session id only labels the read; it is the
 * span's own stamp where it has one, and the `trace:<id>` form the session
 * model uses for a vendor that exposed no session key otherwise.
 */
const decodeAiSpan = Effect.fn("mcp.inspectSpan.decodeAi")(function* (opts: {
	readonly traceId: string
	readonly spanId: string
	readonly startTime: string
	readonly payloadChars: number
}) {
	const tenant = yield* CurrentMcpTenant
	const atMs = parseWarehouseDateTime(opts.startTime)
	const page = yield* readAiSessionSpans(
		tenant,
		new GetAiSessionSpansRequest({
			sessionId: `trace:${opts.traceId}`,
			startTime: formatWarehouseDateTime(atMs - TRACE_WINDOW_MS),
			endTime: formatWarehouseDateTime(atMs + TRACE_WINDOW_MS),
			traceIds: [opts.traceId],
			limit: AI_SESSION_SPANS_MAX_SPANS,
		}),
	).pipe(Effect.catchTags(warehouseReadToMcpHandlers("inspect_span")))

	const span = page.data.find((candidate) => candidate.spanId === opts.spanId)
	if (span === undefined) {
		// A page that ended on a cursor read only the FIRST spans of the trace,
		// so absence from it is not absence from the trace. Either way the raw
		// attributes below still answer the question the caller asked.
		return { _tag: "partial" as const, readSpans: page.data.length }
	}
	const rendered = renderAiSpan(span, page.data, opts.payloadChars)
	return {
		_tag: "decoded" as const,
		lines: rendered.lines,
		data: rendered.data,
		sessionId: rendered.data.sessionId,
	}
})
