import type { SpanHierarchyOutput, ListLogsOutput } from "@maple/domain/tinybird"
import { FIXTURES } from "./utils"

const hex = (n: number): string => n.toString(16).padStart(16, "0")

/** Total spans in the synthetic large trace (> MAX_OVERVIEW_SPANS=100 to force the cap). */
export const LARGE_TRACE_SPAN_COUNT = 150

/**
 * A synthetic large trace: one root server span with many short children and a
 * single error span. Exceeding the 100-span overview budget makes `inspect_trace`
 * render the "Showing N of M spans" note — the Part-1 behavior under test.
 */
export const makeLargeTraceSpans = (count = LARGE_TRACE_SPAN_COUNT): SpanHierarchyOutput[] => {
	const traceId = FIXTURES.traceId
	const rootId = FIXTURES.spanId
	const rows: SpanHierarchyOutput[] = [
		{
			traceId,
			spanId: rootId,
			parentSpanId: "",
			spanName: "GET /api/checkout",
			serviceName: FIXTURES.service,
			spanKind: "Server",
			durationMs: 850,
			startTime: "2026-06-02 10:00:00",
			statusCode: "Ok",
			statusMessage: "",
			spanAttributes: "{}",
			resourceAttributes: "{}",
			relationship: "related",
		},
	]
	for (let i = 0; i < count - 1; i++) {
		const isError = i === 7
		rows.push({
			traceId,
			spanId: hex(0x1000 + i),
			parentSpanId: rootId,
			spanName: isError ? "db.query users" : `op-${i}`,
			serviceName: i % 3 === 0 ? "db" : FIXTURES.service,
			spanKind: "Internal",
			durationMs: isError ? 120 : (i % 10) + 1,
			startTime: "2026-06-02 10:00:00",
			statusCode: isError ? "Error" : "Ok",
			statusMessage: isError ? "connection reset by peer" : "",
			spanAttributes: "{}",
			resourceAttributes: "{}",
			relationship: "related",
		})
	}
	return rows
}

/** A distinct trace id for the "small trace renders in full" regression guard. */
export const SMALL_TRACE_ID = "5b8aa5a2d2c872e8321cf37308d69df2"

/**
 * A small trace (1 root + 4 children, all Ok) — well under MAX_OVERVIEW_SPANS,
 * so `inspect_trace` must render the full tree with NO "Showing N of M" note.
 */
export const makeSmallTraceSpans = (): SpanHierarchyOutput[] => {
	const rootId = "aaaa000000000001"
	const root: SpanHierarchyOutput = {
		traceId: SMALL_TRACE_ID,
		spanId: rootId,
		parentSpanId: "",
		spanName: "GET /api/orders",
		serviceName: FIXTURES.service,
		spanKind: "Server",
		durationMs: 42,
		startTime: "2026-06-02 10:00:00",
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: "{}",
		resourceAttributes: "{}",
		relationship: "related",
	}
	const children = Array.from(
		{ length: 4 },
		(_, i): SpanHierarchyOutput => ({
			traceId: SMALL_TRACE_ID,
			spanId: `aaaa00000000001${i}`,
			parentSpanId: rootId,
			spanName: `step-${i}`,
			serviceName: FIXTURES.service,
			spanKind: "Internal",
			durationMs: i + 1,
			startTime: "2026-06-02 10:00:00",
			statusCode: "Ok",
			statusMessage: "",
			spanAttributes: "{}",
			resourceAttributes: "{}",
			relationship: "related",
		}),
	)
	return [root, ...children]
}

/** Trace + span ids for the `inspect_span` drill-down regression guards. */
export const SPAN_DETAIL_TRACE_ID = "9c2f1e7a4b6d83f05e1a2c3d4e5f6071"
export const SPAN_DETAIL_SPAN_ID = "c1c1c1c1c1c1c1c1"
export const MISSING_SPAN_ID = "deadbeefdeadbeef"

/** One full-attribute row for `inspect_span` (shape: spanDetailQuery output). */
export const makeSpanDetailRows = (): ReadonlyArray<Record<string, unknown>> => [
	{
		traceId: SPAN_DETAIL_TRACE_ID,
		spanId: SPAN_DETAIL_SPAN_ID,
		// Every column `spanDetailQuery` selects — the row is validated against
		// the compiled query's schema now, so a partial one is a decode failure.
		parentSpanId: "",
		spanName: "POST /api/checkout",
		serviceName: FIXTURES.service,
		spanKind: "Server",
		durationMs: 120,
		startTime: "2026-06-02 10:00:00",
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: JSON.stringify({ "http.method": "POST", "http.route": "/api/checkout" }),
		resourceAttributes: JSON.stringify({ "service.name": FIXTURES.service }),
	},
]

/* -------------------------------------------------------------------------- */
/* An AI agent span, as `inspect_span` reaches it: the point lookup that finds  */
/* it, and the trace read that decodes it                                      */
/* -------------------------------------------------------------------------- */

export const AI_SPAN_TRACE_ID = "4d2c1b0a9f8e7d6c5b4a3928170615ff"
/** The LLM call: it requests a tool, whose result is on the span below. */
export const AI_SPAN_SPAN_ID = "a1a1a1a1a1a1a1a1"
export const AI_TOOL_SPAN_ID = "a2a2a2a2a2a2a2a2"
/** A trace too large for one read, and an AI span past its first page. */
export const PARTIAL_AI_TRACE_ID = "5e3d2c1b0a9f8e7d6c5b4a3928170611"
export const PARTIAL_AI_SPAN_ID = "b9b9b9b9b9b9b9b9"
export const PARTIAL_AI_TRACE_SPANS = 2_001
/** The same trace's FIRST span: decoded, but with the rest of the trace — and
 *  so the tool span answering its call — past what the read carried. */
export const PARTIAL_AI_FIRST_SPAN_ID = "c000000000000000"

const AI_SPAN_ATTRIBUTES = {
	"maple_ai.session.id": "wrun_01KZEVAL",
	"maple_ai.vendor.id": "eve",
	"gen_ai.operation.name": "chat",
	"gen_ai.request.model": "gpt-5",
	"gen_ai.response.model": "gpt-5",
	"gen_ai.usage.input_tokens": "1200",
	"gen_ai.input.messages": JSON.stringify([
		{ role: "user", parts: [{ type: "text", content: "why is checkout failing?" }] },
	]),
	"gen_ai.output.messages": JSON.stringify([
		{
			role: "assistant",
			parts: [{ type: "tool_call", id: "call_1", name: "run_sql", arguments: { sql: "select 1" } }],
		},
	]),
}

/** The point lookup, in `spanDetailQuery`'s output shape. */
export const makeAiSpanDetailRows = (
	spanId: string = AI_SPAN_SPAN_ID,
	traceId: string = AI_SPAN_TRACE_ID,
): ReadonlyArray<Record<string, unknown>> => [
	{
		traceId,
		spanId,
		parentSpanId: "",
		spanName: "chat gpt-5",
		serviceName: FIXTURES.service,
		spanKind: "Client",
		durationMs: 1_200,
		startTime: "2026-06-02 10:00:00",
		statusCode: "Unset",
		statusMessage: "",
		spanAttributes: JSON.stringify(AI_SPAN_ATTRIBUTES),
		resourceAttributes: JSON.stringify({ "service.name": FIXTURES.service }),
	},
]

const aiTraceSpanRow = (
	spanId: string,
	spanName: string,
	attributes: Record<string, string>,
	traceId: string = AI_SPAN_TRACE_ID,
): Record<string, unknown> => ({
	traceId,
	spanId,
	parentSpanId: "",
	spanName,
	spanKind: "Client",
	serviceName: FIXTURES.service,
	durationMs: 1_200,
	statusCode: "Unset",
	statusMessage: "",
	timestamp: "2026-06-02 10:00:00.000000000",
	spanAttributes: attributes,
})

/** The trace behind the AI span, in `aiSessionSpansRowSchema`'s shape: the call
 *  and the tool span that answered it. */
export const makeAiTraceSpanRows = (): ReadonlyArray<Record<string, unknown>> => [
	aiTraceSpanRow(AI_SPAN_SPAN_ID, "chat gpt-5", AI_SPAN_ATTRIBUTES),
	aiTraceSpanRow(AI_TOOL_SPAN_ID, "execute_tool run_sql", {
		"maple_ai.session.id": "wrun_01KZEVAL",
		"maple_ai.vendor.id": "eve",
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": "run_sql",
		"gen_ai.tool.call.id": "call_1",
		"gen_ai.tool.call.result": JSON.stringify({ error: "table orders does not exist" }),
	}),
]

/** One row past the trace-pinned read's limit, and the inspected span in none
 *  of them: the read returns a cursor, so absence is not absence. */
export const makePartialAiTraceSpanRows = (): ReadonlyArray<Record<string, unknown>> =>
	Array.from({ length: PARTIAL_AI_TRACE_SPANS }, (_, index) =>
		aiTraceSpanRow(
			`c${index.toString(16).padStart(15, "0")}`,
			"chat gpt-5",
			// The first span is the LLM call that requested `call_1`; the tool span
			// that answered it is not in this trace's first page.
			index === 0
				? AI_SPAN_ATTRIBUTES
				: { "maple_ai.vendor.id": "eve", "gen_ai.operation.name": "chat" },
			PARTIAL_AI_TRACE_ID,
		),
	)

/** A trace's own bounds, as `aiTraceWindowQuery` reports them: what
 *  `inspect_span` resolves before it reads the trace as agent spans. */
export const makeAiTraceWindowRows = (): ReadonlyArray<Record<string, unknown>> => [
	{
		startTime: "2026-06-01 10:00:00.000000000",
		endTime: "2026-06-03 10:00:00.000000000",
		spanCount: PARTIAL_AI_TRACE_SPANS,
	},
]

export const makeTraceLogs = (): ListLogsOutput[] => [
	{
		timestamp: "2026-06-02 10:00:00",
		severityText: "ERROR",
		severityNumber: 17,
		serviceName: FIXTURES.service,
		body: "checkout failed: downstream db error",
		traceId: FIXTURES.traceId,
		spanId: FIXTURES.spanId,
		// The list-logs cursor identity — a real selected column, so a row without
		// it no longer decodes.
		recordIdentity: "0123456789ABCDEF0123456789ABCDEF",
		logAttributes: "{}",
		resourceAttributes: "{}",
	},
]
