import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { CurrentMcpTenant, withTenantExecutor } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { formatDurationFromMs, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { SearchTracesOutput } from "@maple/domain/mcp-outputs"
import { searchTraces } from "@maple/query-engine/observability"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_SEARCH_MAX_HOURS })

export function registerSearchTracesTool(server: McpToolRegistrar) {
	server.define({
		name: "search_traces",
		description:
			"Search traces by service, duration, error status, HTTP method, span name, or custom attributes. When span_name is provided, searches at the span level (not just root spans) for accurate results. Use inspect_trace on interesting trace_ids. Use explore_attributes to discover attribute keys.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(
				"Only this service (exact `service.name`; searches all spans in the trace, not just root)",
			),
			has_error: P.optionalFlag("Only traces with errors"),
			min_duration_ms: P.optionalNumber("Minimum duration in milliseconds"),
			max_duration_ms: P.optionalNumber("Maximum duration in milliseconds"),
			http_method: P.optionalText("Filter by HTTP method (GET, POST, etc.)"),
			span_name: P.optionalText(
				"Filter by span name (searches all spans, substring match, case-insensitive)",
			),
			trace_id: P.optionalText("Find a specific trace by ID"),
			attribute_key: P.optionalText("Filter by span attribute key (e.g. user.id, request.id)"),
			attribute_value: P.optionalText("Filter by span attribute value (requires attribute_key)"),
			root_only: P.optionalFlag(
				"Only match root spans for service/span_name filters (default: false, searches all spans)",
			),
			offset: P.offset({ max: 10_000 }),
			limit: P.limit({ default: 20, max: 200, noun: "traces" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: SearchTracesOutput,
		hints: { readOnly: true },
		phrases: ["Searching traces", "Looking through traces"],
		handler: Effect.fn("McpTool.searchTraces")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "search_traces")

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: params.service ?? "all",
				hasError: params.has_error ?? false,
				limit: params.limit,
				offset: params.offset,
			})

			if (params.attribute_value !== undefined && params.attribute_key === undefined) {
				return yield* new McpInvalidInputError({
					message:
						"`attribute_value` requires `attribute_key`. Use explore_attributes to discover available keys.",
					parameter: "attribute_value",
					example: 'attribute_key="user.id" attribute_value="abc123"',
				})
			}

			const rootOnly = params.root_only ?? false
			const result = yield* withTenantExecutor(
				searchTraces({
					timeRange: { startTime: st, endTime: et },
					service: params.service,
					spanName: params.span_name,
					spanNameMatchMode: params.span_name ? "contains" : undefined,
					hasError: params.has_error,
					minDurationMs: params.min_duration_ms,
					maxDurationMs: params.max_duration_ms,
					httpMethod: params.http_method,
					traceId: params.trace_id,
					attributeFilters: params.attribute_key
						? [{ key: params.attribute_key, value: params.attribute_value ?? "" }]
						: undefined,
					rootOnly,
					limit: params.limit,
					offset: params.offset,
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("search_traces")))

			const spans = result.spans
			yield* Effect.annotateCurrentSpan("result.rowCount", spans.length)
			const hasMore = result.pagination.hasMore

			return {
				timeRange: { start: st, end: et },
				pagination: {
					offset: params.offset,
					limit: params.limit,
					hasMore,
					...(hasMore ? { nextOffset: params.offset + spans.length } : undefined),
				},
				traces: spans.map((s) => ({
					traceId: s.traceId,
					rootSpanName: s.spanName,
					durationMs: s.durationMs,
					spanCount: 1,
					services: [s.serviceName],
					hasError: s.statusCode === "Error",
					resourceAttributes: s.resourceAttributes,
				})),
				filters: {
					...(params.service === undefined ? undefined : { service: params.service }),
					...(params.has_error === undefined ? undefined : { hasError: params.has_error }),
					...(params.min_duration_ms === undefined
						? undefined
						: { minDurationMs: params.min_duration_ms }),
					...(params.max_duration_ms === undefined
						? undefined
						: { maxDurationMs: params.max_duration_ms }),
					...(params.http_method === undefined ? undefined : { httpMethod: params.http_method }),
					...(params.span_name === undefined ? undefined : { spanName: params.span_name }),
					...(params.trace_id === undefined ? undefined : { traceId: params.trace_id }),
					...(params.attribute_key === undefined
						? undefined
						: { attributeKey: params.attribute_key }),
					...(params.attribute_value === undefined
						? undefined
						: { attributeValue: params.attribute_value }),
					rootOnly,
				},
				spanLevel: params.span_name !== undefined && !rootOnly,
			}
		}),
		render: (output) => {
			const { filters, pagination } = output
			const noun = output.spanLevel ? "matching spans" : "traces"
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				["Service", filters.service],
				["Span name", filters.spanName],
				[
					"Offset",
					pagination === undefined || pagination.offset === 0
						? undefined
						: String(pagination.offset),
				],
			]
			const title = output.spanLevel ? "Matching Spans" : "Traces"
			if (output.traces.length === 0) {
				return {
					title,
					scope,
					blocks: [],
					empty: {
						message: `No ${noun} found matching the filters in this window.`,
						hints: [
							"Widen start_time/end_time, or drop filters.",
							"span_name is a case-insensitive substring; explore_attributes lists attribute keys and values.",
						],
					},
				}
			}
			const nextOffset = pagination?.nextOffset
			return {
				title,
				scope,
				blocks: [
					output.spanLevel
						? doc.table(
								["Trace ID", "Span Name", "Service", "Duration", "Status"],
								output.traces.map((t) => [
									t.traceId,
									truncate(t.rootSpanName, 40),
									t.services.join(", "),
									formatDurationFromMs(t.durationMs),
									t.hasError ? "Error" : "",
								]),
							)
						: doc.table(
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
				...(nextOffset === undefined
					? undefined
					: {
							truncation: {
								shown: output.traces.length,
								noun,
								next: doc.next(
									"search_traces",
									{
										start_time: output.timeRange.start,
										end_time: output.timeRange.end,
										service: filters.service,
										has_error: filters.hasError,
										min_duration_ms: filters.minDurationMs,
										max_duration_ms: filters.maxDurationMs,
										http_method: filters.httpMethod,
										span_name: filters.spanName,
										trace_id: filters.traceId,
										attribute_key: filters.attributeKey,
										attribute_value: filters.attributeValue,
										root_only: filters.rootOnly ? true : undefined,
										limit: pagination?.limit,
										offset: nextOffset,
									},
									"the next page",
								),
							},
						}),
				next: output.traces
					.slice(0, 3)
					.map((t) => doc.next("inspect_trace", { trace_id: t.traceId }, "full span tree")),
			}
		},
	})
}
