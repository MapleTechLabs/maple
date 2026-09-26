import type { McpToolRegistrar } from "./types"
import { warehouseReadHandlers, warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { CurrentMcpTenant, withTenantExecutor } from "../lib/query-warehouse"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { hasAiSignal, renderAiSpan } from "../lib/render-ai-span"
import { InspectSpanOutput } from "@maple/domain/mcp-outputs"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { spanDetail } from "@maple/query-engine/observability"
import { AI_SESSION_SPANS_MAX_SPANS, GetAiSessionSpansRequest, TraceIdHex } from "@maple/domain/http"
import {
	readAiSessionSpans,
	resolveAiSessionWindow,
} from "@maple/backend/services/ai-sessions/ai-session-reads"
import { padSessionWindow } from "@maple/agent-sessions"

/** What to do about a trace whose spans no read can carry. */
const TRACE_TOO_LARGE =
	"The decode needs the whole trace in one read — use `inspect_trace` for its span tree instead."

/** The same, as the note under a skipped decode. */
const TRACE_TOO_LARGE_NOTE =
	"the trace is too large to read in one call; `inspect_trace` shows it a page at a time."

/**
 * The AI read pins the trace id into a warehouse param, so it must be the
 * 32-hex shape the domain requires; a span in a trace stored under any other
 * id shape still gets its raw attributes, just not the decoded view.
 */
const isTraceIdHex = Schema.is(TraceIdHex)

type Output = typeof InspectSpanOutput.Type

const attributeBlocks = (label: string, attrs: Output["attributes"]): Array<DocBlock> => {
	const entries = Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))
	if (entries.length === 0) return []
	return [
		doc.heading(`${label} (${entries.length})`),
		doc.list(entries.map(([k, v]) => `\`${k}\`: ${truncate(v, 500)}`)),
	]
}

const aiBlocks = (output: Output): Array<DocBlock> => {
	const ai = output.ai
	if (ai === undefined) return []
	switch (ai._tag) {
		case "decoded":
			return [doc.text(ai.markdown)]
		case "partial":
			return [
				doc.text(
					ai.hasMore
						? `This is an AI agent span, but only the first ${ai.readSpans} spans of trace ${output.traceId} were read and it is not among them, so its messages and tool calls are not decoded below. ${TRACE_TOO_LARGE}`
						: "This is an AI agent span, but it is not in the AI index yet, so its messages and tool calls are not decoded below; the raw attributes below are complete.",
				),
			]
		case "undecoded":
			return [doc.text(`AI decode skipped: ${ai.reason}`)]
	}
}

export function registerInspectSpanTool(server: McpToolRegistrar) {
	server.define({
		name: "inspect_span",
		description:
			"Full attribute set for one span; `inspect_trace` shows only a trimmed set per span. For an AI agent span (an LLM call, a tool execution, an agent invocation) it also decodes the captured messages and the tool calls it made or executed, with each call's result resolved from the rest of the trace.",
		parameters: Schema.Struct({
			trace_id: P.text("The trace ID the span belongs to"),
			span_id: P.text("The span ID to inspect (from `inspect_trace` output)"),
			timestamp: P.optionalTimestamp(
				"Timestamp of the span (e.g. from search_traces). Narrows the scan to ±1h and saves an AI span the lookup that resolves its trace's bounds",
			),
			payload_chars: P.limit({
				default: 2_000,
				max: 20_000,
				description: "Max characters per captured message or payload (AI spans only)",
			}),
		}),
		output: InspectSpanOutput,
		hints: { readOnly: true },
		phrases: ["Inspecting a span", "Reading span details"],
		handler: Effect.fn("McpTool.inspectSpan")(function* ({
			trace_id,
			span_id,
			timestamp,
			payload_chars,
		}) {
			yield* Effect.annotateCurrentSpan({ traceId: trace_id, spanId: span_id })
			const timestampMs = timestamp === undefined ? undefined : parseWarehouseDateTime(timestamp)
			const timestampHint = timestampMs === undefined ? undefined : new Date(timestampMs)

			const result = yield* withTenantExecutor(
				spanDetail({ traceId: trace_id, spanId: span_id, timestampHint }),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("span_detail")))

			// The decoded view needs the whole trace, not this span alone: the
			// results of the tool calls a model span requested are captured on the
			// tool spans that ran them.
			const isAiSpan = result.found && hasAiSignal(result.spanAttributes)
			const ai =
				isAiSpan && isTraceIdHex(trace_id)
					? yield* decodeAiSpan({
							traceId: trace_id,
							spanId: span_id,
							timestampMs,
							payloadChars: payload_chars,
						})
					: undefined
			yield* Effect.annotateCurrentSpan({
				"maple.ai.span": isAiSpan,
				"maple.ai.decode": ai?._tag ?? "none",
			})

			return {
				traceId: trace_id,
				spanId: span_id,
				found: result.found,
				attributes: result.spanAttributes,
				resourceAttributes: result.resourceAttributes,
				...(ai === undefined ? undefined : { ai }),
				...(timestamp === undefined ? undefined : { timestamp }),
			}
		}),
		render: (output) => {
			const title = `Span ${output.spanId} (trace ${output.traceId})`
			if (!output.found) {
				return {
					title,
					blocks: [],
					empty: {
						message: `Span ${output.spanId} not found in trace ${output.traceId}.`,
						hints:
							output.timestamp === undefined
								? [
										"Pass `timestamp` from the trace if the span is older than the default scan window.",
									]
								: ["Check the span id against `inspect_trace` output."],
					},
					next: [
						doc.next(
							"inspect_trace",
							{ trace_id: output.traceId, timestamp: output.timestamp },
							"see the full span tree",
						),
					],
				}
			}
			const noAttributes =
				Object.keys(output.attributes).length === 0 &&
				Object.keys(output.resourceAttributes).length === 0
			const ai = output.ai
			return {
				title,
				...(output.timestamp === undefined ? undefined : { scope: [["Around", output.timestamp]] }),
				blocks: [
					...aiBlocks(output),
					...attributeBlocks("Span attributes", output.attributes),
					...attributeBlocks("Resource attributes", output.resourceAttributes),
					...(noAttributes ? [doc.text("This span has no attributes recorded.")] : []),
				],
				next: [
					doc.next(
						"inspect_trace",
						{ trace_id: output.traceId, timestamp: output.timestamp },
						"see the full span tree",
					),
					doc.next(
						"search_logs",
						{ trace_id: output.traceId, span_id: output.spanId },
						"logs for this span",
					),
					// A vendor that exposed no session key still has a session: the
					// trace itself, under the id the session model synthesises for it.
					...(ai?._tag === "decoded"
						? [
								doc.next(
									"get_agent_session",
									{ session_id: ai.sessionId ?? `trace:${output.traceId}` },
									"the agent session this span ran in",
								),
							]
						: []),
				],
			}
		},
	})
}

const undecoded = (reason: string) => Effect.succeed({ _tag: "undecoded" as const, reason })

/**
 * The span's trace, read as agent spans and decoded. The decode is an add-on:
 * the raw attributes above it already answer the question, so a failure of
 * either read below lands as a note rather than as the tool's answer.
 *
 * The read is keyed on the trace and always bounded: `trace_detail_spans` is
 * partitioned by day, so an unbounded lookup seeks every partition. A caller
 * that passed `timestamp` has already named an instant inside the trace, and
 * the pad around it is the one the page reads a session's row with — wide
 * enough that a tool span at the other end of the trace is still inside the
 * window rather than falling out of it and rendering as "not captured".
 * Without a timestamp the trace's own bounds are resolved first, which is the
 * extra seek over `traces` the parameter exists to skip. The session id only
 * labels the read; it is the `trace:<id>` form the session model uses for a
 * vendor that exposed no session key.
 */
const DECODE_LOOKAHEAD_MS = 24 * 60 * 60_000

const decodeAiSpan = Effect.fn("decodeAiSpan")(
	function* (opts: {
		readonly traceId: string
		readonly spanId: string
		readonly timestampMs: number | undefined
		readonly payloadChars: number
	}) {
		const tenant = yield* CurrentMcpTenant
		const sessionId = `trace:${opts.traceId}`
		// With a timestamp the trace's bounds are not resolved: the read looks back
		// an hour and ahead a day, where a tool's result lands after the call that
		// made it; a trace longer than that pages, and the answer says so.
		const window =
			opts.timestampMs === undefined
				? (yield* resolveAiSessionWindow(tenant, sessionId)).window
				: padSessionWindow(opts.timestampMs, opts.timestampMs + DECODE_LOOKAHEAD_MS)
		// No bounds at all: the trace carries nothing the AI reads can key on, so
		// the raw attributes below are the whole answer.
		if (window === undefined) return undefined

		const page = yield* readAiSessionSpans(
			tenant,
			new GetAiSessionSpansRequest({
				sessionId,
				...window,
				traceIds: [opts.traceId],
				limit: AI_SESSION_SPANS_MAX_SPANS,
			}),
		)

		const span = page.data.find((candidate) => candidate.spanId === opts.spanId)
		if (span === undefined) {
			// A page that ended on a cursor read only the FIRST spans of the trace,
			// so absence from it is not absence from the trace; a page that ended
			// without one read all of it, and the span is simply not in the AI
			// index yet. Either way the raw attributes below still answer.
			return {
				_tag: "partial" as const,
				readSpans: page.data.length,
				hasMore: page.nextCursor !== undefined,
			}
		}
		// A trace read that ended on a cursor decodes this span in full, but the
		// results of the calls it made can be on a span past the page.
		const decoded = renderAiSpan(span, page.data, opts.payloadChars, page.nextCursor !== undefined)
		return {
			_tag: "decoded" as const,
			// The leading blank line kept the section apart in the old line-joined text.
			markdown: decoded.lines.join("\n").trim(),
			...(decoded.sessionId === undefined ? undefined : { sessionId: decoded.sessionId }),
		}
	},
	Effect.catchTags({
		...warehouseReadHandlers((error) => undecoded(`the trace read failed — ${error.message}`)),
		"@maple/http/ai-sessions/AiSessionTooLargeError": () => undecoded(TRACE_TOO_LARGE_NOTE),
	}),
)
