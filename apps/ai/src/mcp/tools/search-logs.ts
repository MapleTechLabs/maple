import type { McpToolRegistrar } from "./types"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { truncate, formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { SearchLogsOutput, type LogSearchFilters } from "@maple/domain/mcp-outputs"
import { searchLogs } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_SEARCH_MAX_HOURS })

/** Severity levels a log filter takes. Matched across SDK spellings (`ERROR`, `Error`, `error`). */
export const LOG_SEVERITIES = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const

/** The filters a log tool applied, for its output. */
export const logFilters = (params: {
	readonly service?: string | undefined
	readonly severity?: string | undefined
	readonly search?: string | undefined
	readonly trace_id?: string | undefined
	readonly span_id?: string | undefined
}): typeof LogSearchFilters.Type => ({
	...(params.service === undefined ? undefined : { service: params.service }),
	...(params.severity === undefined ? undefined : { severity: params.severity }),
	...(params.search === undefined ? undefined : { search: params.search }),
	...(params.trace_id === undefined ? undefined : { traceId: params.trace_id }),
	...(params.span_id === undefined ? undefined : { spanId: params.span_id }),
})

/** The filters as a scope line: each one only when it applied. */
export const logFilterScope = (
	filters: typeof LogSearchFilters.Type | undefined,
): ReadonlyArray<readonly [string, string | undefined]> => [
	["Service", filters?.service],
	["Severity", filters?.severity],
	["Search", filters?.search === undefined ? undefined : `"${filters.search}"`],
	["Trace", filters?.traceId],
	["Span", filters?.spanId],
]

export function registerSearchLogsTool(server: McpToolRegistrar) {
	server.define({
		name: "search_logs",
		description:
			"Search and filter logs by service, severity, keyword, or trace_id. A partial page names the call for the next one. Use inspect_trace to see the full trace for a log entry.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(),
			severity: P.optionalOneOf(
				LOG_SEVERITIES,
				"Only logs at this severity level (matches every SDK spelling of it)",
			),
			search: P.optionalText("Search text in log body"),
			trace_id: P.optionalText("Filter by trace ID"),
			span_id: P.optionalText("Filter by span ID (scope to a specific span within a trace)"),
			offset: P.offset({ max: 10_000 }),
			limit: P.limit({ default: 30, max: 200, noun: "logs" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: SearchLogsOutput,
		hints: { readOnly: true },
		phrases: ["Searching logs", "Reading through logs"],
		handler: Effect.fn("McpTool.searchLogs")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "search_logs")
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: params.service ?? "all",
				severity: params.severity ?? "all",
				limit: params.limit,
				offset: params.offset,
			})

			const result = yield* searchLogs({
				timeRange: { startTime: st, endTime: et },
				service: params.service,
				severity: params.severity,
				search: params.search,
				traceId: params.trace_id,
				spanId: params.span_id,
				limit: params.limit,
				offset: params.offset,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("search_logs")),
			)

			yield* Effect.annotateCurrentSpan("result.rowCount", result.logs.length)
			const hasMore = result.pagination.hasMore

			return {
				timeRange: { start: st, end: et },
				totalCount: result.total,
				pagination: {
					offset: params.offset,
					limit: params.limit,
					hasMore,
					total: result.total,
					...(hasMore ? { nextOffset: params.offset + result.logs.length } : undefined),
				},
				logs: result.logs.map((l) => ({
					timestamp: l.timestamp,
					severityText: l.severityText,
					serviceName: l.serviceName,
					body: l.body,
					...(l.traceId ? { traceId: l.traceId } : undefined),
					...(l.spanId ? { spanId: l.spanId } : undefined),
				})),
				filters: logFilters(params),
			}
		}),
		render: (output) => {
			const filters = output.filters
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				...logFilterScope(filters),
			]
			if (output.logs.length === 0) {
				return {
					title: "Logs",
					scope,
					blocks: [],
					empty: {
						message: "No logs found matching the filters in this window.",
						hints: [
							"Widen start_time/end_time, or drop filters. `search` is a substring of the log body.",
						],
					},
				}
			}
			const lines = output.logs.map((log) => {
				const time = log.timestamp.split(" ")[1] ?? log.timestamp
				const sevUpper = log.severityText.toUpperCase()
				const marker = sevUpper === "ERROR" || sevUpper === "FATAL" ? "●" : " "
				// Span ref is only useful once scoped to a trace; otherwise it's noise.
				const span =
					filters?.traceId !== undefined && log.spanId ? ` span:${log.spanId.slice(0, 8)}` : ""
				const ref = log.traceId ? ` [trace:${log.traceId.slice(0, 8)}${span}]` : ""
				return `${marker} ${time} [${log.severityText.padEnd(5)}] ${log.serviceName}: ${truncate(log.body, 120)}${ref}`
			})
			const pagination = output.pagination
			const nextOffset = pagination?.nextOffset
			const traceIds = [...new Set(output.logs.flatMap((l) => (l.traceId ? [l.traceId] : [])))].slice(
				0,
				3,
			)
			const spanPivot = output.logs.find((l) => l.spanId && l.traceId)
			return {
				title: `Logs (${formatNumber(output.totalCount)} total)`,
				scope,
				blocks: [doc.text(lines.join("\n"))],
				...(nextOffset === undefined
					? undefined
					: {
							truncation: {
								shown: output.logs.length,
								total: output.totalCount,
								noun: "logs",
								next: doc.next(
									"search_logs",
									{
										start_time: output.timeRange.start,
										end_time: output.timeRange.end,
										service: filters?.service,
										severity: filters?.severity,
										search: filters?.search,
										trace_id: filters?.traceId,
										span_id: filters?.spanId,
										limit: pagination?.limit,
										offset: nextOffset,
									},
									"the next page",
								),
							},
						}),
				next: [
					...traceIds.map((traceId) =>
						doc.next("inspect_trace", { trace_id: traceId }, "see full trace"),
					),
					...(spanPivot?.traceId && spanPivot.spanId
						? [
								doc.next(
									"inspect_span",
									{ trace_id: spanPivot.traceId, span_id: spanPivot.spanId },
									"full attributes for a span",
								),
							]
						: []),
				],
			}
		},
	})
}
