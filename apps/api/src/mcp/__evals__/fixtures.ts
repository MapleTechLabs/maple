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

export const makeTraceLogs = (): ListLogsOutput[] => [
	{
		timestamp: "2026-06-02 10:00:00",
		severityText: "ERROR",
		severityNumber: 17,
		serviceName: FIXTURES.service,
		body: "checkout failed: downstream db error",
		traceId: FIXTURES.traceId,
		spanId: FIXTURES.spanId,
		logAttributes: "{}",
		resourceAttributes: "{}",
	},
]
