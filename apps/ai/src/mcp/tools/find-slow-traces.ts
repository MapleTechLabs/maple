import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { formatDurationFromMs, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { FindSlowTracesOutput } from "@maple/domain/mcp-outputs"
import { findSlowTraces } from "@maple/query-engine/observability"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_SEARCH_MAX_HOURS })

export function registerFindSlowTracesTool(server: McpToolRegistrar) {
	server.define({
		name: "find_slow_traces",
		description:
			"Find the slowest traces with percentile context (p50, p95, min, max). Use inspect_trace on slow trace_ids to find bottleneck spans.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(),
			environment: P.environment(),
			limit: P.limit({ default: 10, max: 100, noun: "traces" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: FindSlowTracesOutput,
		hints: { readOnly: true },
		phrases: ["Finding slow traces", "Looking for slow requests"],
		handler: Effect.fn("McpTool.findSlowTraces")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "find_slow_traces")

			const result = yield* withTenantExecutor(
				findSlowTraces({
					timeRange: { startTime: st, endTime: et },
					service: params.service,
					environment: params.environment,
					limit: params.limit,
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("find_slow_traces")))

			return {
				timeRange: { start: st, end: et },
				...(result.stats === null ? undefined : { stats: result.stats }),
				traces: result.traces.map((t) => ({
					traceId: t.traceId,
					rootSpanName: t.spanName,
					durationMs: t.durationMs,
					spanCount: 1,
					services: [t.serviceName],
					hasError: t.statusCode === "Error",
					resourceAttributes: t.resourceAttributes,
				})),
				...(params.service === undefined ? undefined : { service: params.service }),
				...(params.environment === undefined ? undefined : { environment: params.environment }),
			}
		}),
		render: (output) => {
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				["Service", output.service],
				["Environment", output.environment],
			]
			if (output.traces.length === 0) {
				return {
					title: "Slowest Traces",
					scope,
					blocks: [],
					empty: {
						message: "No traces found in this window.",
						hints: ["Widen start_time/end_time, or drop the service and environment filters."],
					},
				}
			}
			const stats = output.stats
			return {
				title: "Slowest Traces",
				scope,
				blocks: [
					...(stats === undefined
						? []
						: [
								doc.fields([
									["P50", formatDurationFromMs(stats.p50Ms)],
									["P95", formatDurationFromMs(stats.p95Ms)],
									["Min", formatDurationFromMs(stats.minMs)],
									["Max", formatDurationFromMs(stats.maxMs)],
								]),
							]),
					doc.table(
						["Trace ID", "Root Span", "Duration", "Service", "Error"],
						output.traces.map((t) => [
							t.traceId,
							truncate(t.rootSpanName, 30),
							formatDurationFromMs(t.durationMs),
							t.services.join(", "),
							t.hasError ? "Yes" : "",
						]),
					),
				],
				next: output.traces
					.slice(0, 3)
					.map((t) => doc.next("inspect_trace", { trace_id: t.traceId }, "find bottleneck spans")),
			}
		},
	})
}
