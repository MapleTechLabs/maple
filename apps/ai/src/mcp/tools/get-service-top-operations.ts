import type { McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { formatMetricValue } from "../lib/format-query-result"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { GetServiceTopOperationsOutput } from "@maple/domain/mcp-outputs"
import { topOperations } from "@maple/query-engine/observability"
import { TracesMetric } from "@maple/query-engine"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_SEARCH_MAX_HOURS })

export function registerGetServiceTopOperationsTool(server: McpToolRegistrar) {
	server.define({
		name: "get_service_top_operations",
		description:
			"Get the top operations (endpoints/spans) for a service, sorted by request count, error rate, or latency. Use after diagnosing a slow/erroring service to find which endpoints need attention.",
		parameters: Schema.Struct({
			service: P.text("Service name to get top operations for (exact `service.name`)"),
			metric: P.optionalOneOf(
				TracesMetric.literals,
				"Metric to sort by: count (request volume), error_rate, avg_duration, p95_duration (default: count)",
			),
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
				service: params.service,
				metric,
				limit: params.limit,
			})

			const operations = yield* topOperations({
				serviceName: params.service,
				metric,
				timeRange: { startTime: st, endTime: et },
				limit: params.limit,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("top_operations")),
			)

			return {
				timeRange: { start: st, end: et },
				serviceName: params.service,
				metric,
				total: operations.length,
				operations: operations.map((op) => ({ name: op.name, value: op.value })),
			}
		}),
		render: (output) => ({
			title: `Top Operations: ${output.serviceName}`,
			scope: [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
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
								output.operations.map((op) => [
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
							...output.operations
								.slice(0, 3)
								.map((op) =>
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
