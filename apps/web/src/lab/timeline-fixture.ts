import { buildTraceDetail, type SpanHierarchyRow } from "@maple/ui/lib/span-tree"
import { formatWarehouseDateTimeMs, type SpanEvent } from "@maple/query-engine"
import type { SpanEventsBySpanId } from "@maple/ui/lib/span-event-markers"

const T0_MS = new Date("2026-07-21T10:00:00.000Z").getTime()

function at(offsetMs: number): string {
	return formatWarehouseDateTimeMs(T0_MS + offsetMs)
}

function row(overrides: Partial<SpanHierarchyRow> & { spanId: string; spanName: string }): SpanHierarchyRow {
	return {
		traceId: "timeline-lab-trace",
		parentSpanId: "",
		serviceName: "checkout-api",
		spanKind: "Internal",
		durationMs: 20,
		startTime: at(0),
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: "{}",
		resourceAttributes: "{}",
		...overrides,
	}
}

// A wide dynamic range on purpose: a 2s root, mid-size children, and a fan of
// sub-millisecond spans that only become legible at deep zoom.
const ROWS: SpanHierarchyRow[] = [
	row({ spanId: "root", spanName: "POST /api/checkout", spanKind: "Server", durationMs: 2000 }),
	...Array.from({ length: 6 }, (_, i) =>
		row({
			spanId: `svc${i}`,
			parentSpanId: "root",
			spanName: `stage-${i} handler`,
			serviceName: ["checkout-api", "payments", "inventory", "search", "mailer", "edge"][i],
			spanKind: "Internal",
			startTime: at(20 + i * 300),
			durationMs: 260,
			statusCode: i === 3 ? "Error" : "Ok",
		}),
	),
	...Array.from({ length: 40 }, (_, i) =>
		row({
			spanId: `q${i}`,
			parentSpanId: `svc${i % 6}`,
			spanName: `SELECT shard_${i}`,
			serviceName: "postgres",
			spanKind: "Client",
			startTime: at(25 + (i % 6) * 300 + (i % 7) * 30),
			// Sub-ms spans: invisible zoomed out, the reason zoom has to work.
			durationMs: 0.08 + (i % 5) * 0.4,
		}),
	),
	...Array.from({ length: 12 }, (_, i) =>
		row({
			spanId: `deep${i}`,
			parentSpanId: i === 0 ? "svc1" : `deep${i - 1}`,
			spanName: `nested level ${i}`,
			serviceName: "payments",
			startTime: at(330 + i * 3),
			durationMs: 200 - i * 12,
		}),
	),
]

/** Synthetic trace for the timeline lab: 2s root, mid-size children, sub-ms fan. */
export const TIMELINE_LAB_TRACE = buildTraceDetail(ROWS)

const event = (
	spanStartMs: number,
	offsetMs: number,
	name: string,
	attributes: Record<string, string> = {},
): SpanEvent => ({
	name,
	timestamp: new Date(T0_MS + spanStartMs + offsetMs).toISOString(),
	offsetMs,
	attributes,
})

/** OTel events on a few spans: plain events, an exception, one stamped before its span (clock skew). */
export const TIMELINE_LAB_EVENTS: ReadonlyMap<string, ReadonlyArray<SpanEvent>> = new Map([
	[
		"root",
		[
			event(0, 4.2, "cache.miss", { "cache.key": "cart:8f2c" }),
			event(0, 1210.0004, "retry", { "retry.attempt": "2", "retry.reason": "upstream 503" }),
		],
	],
	["svc0", [event(20, 1.75, "db.connection.acquired", { "db.pool.wait_ms": "1.7" })]],
	[
		"svc3",
		[
			event(920, -0.6, "request.received"),
			event(920, 180.25, "exception", {
				"exception.type": "SearchTimeoutError",
				"exception.message": "search backend did not answer within 150ms",
				"exception.stacktrace":
					"SearchTimeoutError: search backend did not answer within 150ms\n    at query (search/client.ts:88:11)\n    at handler (search/route.ts:41:5)",
				"exception.escaped": "true",
			}),
		],
	],
])

/** The timeline only needs names and offsets. */
export const TIMELINE_LAB_MARKERS: SpanEventsBySpanId = new Map(
	[...TIMELINE_LAB_EVENTS].map(([spanId, events]) => [
		spanId,
		events.map(({ name, offsetMs }) => ({ name, offsetMs })),
	]),
)
