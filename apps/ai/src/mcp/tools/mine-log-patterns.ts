import type { McpToolRegistrar } from "./types"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_LOG_PATTERN_MAX_HOURS } from "../lib/time"
import { truncate, formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { MineLogPatternsOutput } from "@maple/domain/mcp-outputs"
import { mineLogPatterns } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { LOG_SEVERITIES, logFilterScope, logFilters } from "./search-logs"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_LOG_PATTERN_MAX_HOURS })

export function registerMineLogPatternsTool(server: McpToolRegistrar) {
	server.define({
		name: "mine_log_patterns",
		description:
			"Cluster log messages into templates (e.g. 'GET /api/users/<*> 200 in <*>ms') with counts and a per-template severity/service breakdown. Use when search_logs would return too many rows to read. It clusters a sample of the most recent matching logs, so pair it with a tight window and selective filters.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(),
			severity: P.optionalOneOf(
				LOG_SEVERITIES,
				"Only logs at this severity level (matches every SDK spelling of it)",
			),
			search: P.optionalText("Substring of the log body, applied before clustering"),
			trace_id: P.optionalText("Only logs under this trace"),
			sample_size: P.limit({
				default: 10_000,
				max: 50_000,
				description: "Recent logs sampled for clustering; more finds rarer templates, costs more",
			}),
			limit: P.limit({ default: 50, max: 200, noun: "patterns" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: MineLogPatternsOutput,
		hints: { readOnly: true },
		phrases: ["Grouping log patterns", "Finding common log patterns"],
		handler: Effect.fn("McpTool.mineLogPatterns")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "mine_log_patterns")
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: params.service ?? "all",
				severity: params.severity ?? "all",
				sampleSize: params.sample_size,
				limit: params.limit,
			})

			const result = yield* mineLogPatterns({
				timeRange: { startTime: st, endTime: et },
				service: params.service,
				severity: params.severity,
				search: params.search,
				traceId: params.trace_id,
				sampleSize: params.sample_size,
				limit: params.limit,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("mine_log_patterns")),
			)

			yield* Effect.annotateCurrentSpan("result.rowCount", result.patterns.length)

			return {
				timeRange: { start: st, end: et },
				totalSampled: result.totalSampled,
				sampleSize: result.sampleSize,
				patterns: result.patterns,
				filters: logFilters(params),
			}
		}),
		render: (output) => {
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				...logFilterScope(output.filters),
			]
			if (output.patterns.length === 0) {
				return {
					title: "Log Patterns",
					scope,
					blocks: [],
					empty: {
						message: "No logs found to cluster in this window.",
						hints: ["Widen start_time/end_time, or drop filters."],
					},
				}
			}
			const errorPattern = output.patterns.find((p) =>
				Object.keys(p.severityCounts).some(
					(k) => k.toUpperCase() === "ERROR" || k.toUpperCase() === "FATAL",
				),
			)
			return {
				title: `Log Patterns (${output.patterns.length} templates from ${formatNumber(output.totalSampled)} sampled logs)`,
				scope,
				blocks: [
					doc.text(
						output.patterns
							.map(
								(p) =>
									`${String(p.count).padStart(6)} ${topKey(p.severityCounts).padEnd(5)} ${topKey(p.serviceCounts)}: ${truncate(p.template, 140)}`,
							)
							.join("\n"),
					),
				],
				next:
					errorPattern === undefined
						? []
						: [
								doc.next(
									"search_logs",
									{
										severity: "ERROR",
										service: topKey(errorPattern.serviceCounts),
										start_time: output.timeRange.start,
										end_time: output.timeRange.end,
									},
									"drill into matching error logs",
								),
							],
			}
		},
	})
}

const topKey = (counts: { readonly [key: string]: number }): string => {
	let best = ""
	let bestN = -1
	for (const [k, v] of Object.entries(counts)) {
		if (v > bestN) {
			best = k
			bestN = v
		}
	}
	return best || "unknown"
}
