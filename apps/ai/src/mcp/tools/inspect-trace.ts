import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { buildTraceOverview, renderTraceOverview } from "../lib/render-trace"
import { Effect, Schema } from "effect"
import { InspectTraceOutput } from "@maple/domain/mcp-outputs"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { inspectTrace } from "@maple/query-engine/observability"

/**
 * Render budget for a single trace overview. Traces can hold thousands of spans
 * (the SQL caps at 5_000); dumping all of them blows up the agent context.
 * `selectOverviewSpans` keeps errors, roots and the longest/structural spans up
 * to this budget — deeper inspection goes through `inspect_span` / `search_traces`.
 */
const MAX_OVERVIEW_SPANS = 100
/** Hard ceiling for `max_spans`; past this a single response stops being readable. */
const MAX_OVERVIEW_SPANS_CEILING = 300

export function registerInspectTraceTool(server: McpToolRegistrar) {
	server.define({
		name: "inspect_trace",
		description:
			"Span tree and logs for one trace: request flow, bottlenecks, error context. Large traces are bounded to an overview (errors and longest spans first); `inspect_span` gives one span's full attributes. Without `timestamp` the last 24h is scanned first, then up to 30 days back if the trace is not found.",
		parameters: Schema.Struct({
			trace_id: P.text("The trace ID to inspect"),
			timestamp: P.optionalTimestamp(
				"Any timestamp from the trace (e.g. from search_traces). Narrows the scan to ±1h around it; required for traces older than 30 days, and faster for any trace older than 24h",
			),
			errors_only: P.optionalFlag(
				"Render only error spans, their ancestors and the roots: the fastest way to read a large trace's failure without its healthy spans.",
			),
			max_spans: P.limit({
				default: MAX_OVERVIEW_SPANS,
				max: MAX_OVERVIEW_SPANS_CEILING,
				description: "Max spans to render; errors and roots are always kept",
			}),
		}),
		output: InspectTraceOutput,
		hints: { readOnly: true },
		phrases: ["Inspecting a trace", "Opening a trace"],
		handler: Effect.fn("McpTool.inspectTrace")(function* ({
			trace_id,
			timestamp,
			errors_only,
			max_spans,
		}) {
			yield* Effect.annotateCurrentSpan("traceId", trace_id)
			const options = { errorsOnly: errors_only === true }
			const timestampHint =
				timestamp === undefined ? undefined : new Date(parseWarehouseDateTime(timestamp))

			const result = yield* withTenantExecutor(inspectTrace(trace_id, { timestampHint })).pipe(
				Effect.catchTags(warehouseToMcpHandlers("span_hierarchy")),
			)

			const output = buildTraceOverview({
				traceId: trace_id,
				serviceCount: result.serviceCount,
				spanCount: result.spanCount,
				rootDurationMs: result.rootDurationMs,
				spans: result.spans,
				logs: result.logs,
				budget: max_spans,
				options,
				...(timestamp === undefined ? undefined : { timestamp }),
			})

			yield* Effect.annotateCurrentSpan({
				"result.rowCount": result.spanCount,
				"result.renderedSpanCount": output.renderedSpanCount ?? 0,
				"result.errorsOnly": options.errorsOnly,
			})
			return output
		}),
		render: renderTraceOverview,
	})
}
