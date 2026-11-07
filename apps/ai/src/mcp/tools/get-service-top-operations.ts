import type { McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { formatMetricValue } from "../lib/format-query-result"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema, Array as Arr } from "effect"
import { GetServiceTopOperationsOutput } from "@maple/domain/mcp-outputs"
import { topOperations } from "@maple/query-engine/observability"
import { TracesMetric } from "@maple/query-engine"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { isMissingServiceOperationsRollup } from "@maple/backend/services/warehouse/missing-table"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_SEARCH_MAX_HOURS })

/** The short latency spellings agents send (`p95`), as the metric they mean. */
const METRIC_ALIASES = {
	p50: "p50_duration",
	median: "p50_duration",
	p95: "p95_duration",
	p99: "p99_duration",
	avg: "avg_duration",
	errors: "error_rate",
} as const

export function registerGetServiceTopOperationsTool(server: McpToolRegistrar) {
	server.define({
		name: "get_service_top_operations",
		title: "Service Top Operations",
		description:
			"Every operation of ONE service (span names, HTTP server spans as `METHOD /route`), ranked by the chosen metric. Use after diagnose_service to find which operations need attention. " +
			"For HTTP routes over up to 90 days use route_usage; for arbitrary filters or time series, query_data group_by=span_name.",
		parameters: Schema.Struct({
			service: P.text("The service (exact `service.name`)"),
			metric: P.optionalOneOf(TracesMetric.literals, "What to rank by (default count)", METRIC_ALIASES),
			environment: P.environment(),
			...WINDOW.fields,
			limit: P.limit({ default: 20, max: 500, noun: "operations" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: GetServiceTopOperationsOutput,
		hints: { readOnly: true },
		phrases: ["Finding top operations", "Ranking a service's operations"],
		handler: Effect.fn("McpTool.getServiceTopOperations")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "get_service_top_operations")
			const metric = params.metric ?? "count"
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.service": params.service,
				"maple.ai.environment": params.environment ?? "all",
				"maple.ai.metric": metric,
				"maple.ai.limit": params.limit,
			})

			const read = (rawOnly: boolean) =>
				topOperations({
					serviceName: params.service,
					metric,
					timeRange: { startTime: st, endTime: et },
					limit: params.limit,
					rawOnly,
					...(params.environment === undefined ? undefined : { environment: params.environment }),
				}).pipe(provideWarehouseExecutorFromTenant(tenant))
			// A BYO cluster the capability probe could not inspect may lack the operation rollups.
			const operations = yield* read(false).pipe(
				Effect.catchIf(isMissingServiceOperationsRollup, () =>
					Effect.annotateCurrentSpan("maple.ai.rollup_fallback", true).pipe(
						Effect.andThen(read(true)),
					),
				),
				Effect.mapError(toMcpQueryError("top_operations")),
			)

			return {
				timeRange: { start: st, end: et },
				serviceName: params.service,
				...(params.environment === undefined ? undefined : { environment: params.environment }),
				metric,
				total: operations.length,
				operations: Arr.map(operations, (op) => ({ name: op.name, value: op.value })),
			}
		}),
		render: (output) => ({
			title: `Top Operations: ${output.serviceName}`,
			scope: [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				["Environment", output.environment],
				["Metric", output.metric],
			],
			...(output.operations.length === 0
				? { empty: { message: "No operations found for this service in the given time range." } }
				: undefined),
			blocks:
				output.operations.length === 0
					? []
					: [
							doc.table(
								["Operation", output.metric],
								Arr.map(output.operations, (op) => [
									op.name,
									formatMetricValue(output.metric, op.value),
								]),
							),
						],
			next:
				output.operations.length === 0
					? [
							doc.next(
								"search_traces",
								{ service: output.serviceName },
								"search for traces from this service",
							),
							doc.next("list_services", {}, "verify the service name"),
						]
					: [
							...Arr.map(output.operations.slice(0, 3), (op) =>
								doc.next(
									"search_traces",
									{ service: output.serviceName, span_name: op.name },
									`find traces for ${op.name}`,
								),
							),
							doc.next(
								"query_data",
								{
									source: "traces",
									kind: "timeseries",
									metric: output.metric,
									service: output.serviceName,
								},
								"chart trend over time",
							),
						],
		}),
	})
}
