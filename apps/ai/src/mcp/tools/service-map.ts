import type { McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatNumber, formatDurationFromMs, formatPercent } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { ServiceMapOutput } from "@maple/domain/mcp-outputs"
import { serviceMap } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 6 })

const errorRateOf = (edge: { readonly callCount: number; readonly errorCount: number }): number =>
	edge.callCount > 0 ? edge.errorCount / edge.callCount : 0

export function registerServiceMapTool(server: McpToolRegistrar) {
	server.define({
		name: "service_map",
		description:
			"Show service-to-service dependencies with call counts, error rates, and latency per edge. Use to understand system architecture and identify problematic inter-service calls.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(
				"Only edges involving this service, as source or target (exact `service.name`)",
			),
			environment: P.environment(),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ServiceMapOutput,
		hints: { readOnly: true },
		phrases: ["Loading the service map", "Mapping service dependencies"],
		handler: Effect.fn("McpTool.serviceMap")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "service_map")
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: params.service ?? "all",
				environment: params.environment ?? "all",
			})

			const allEdges = yield* serviceMap({
				timeRange: { startTime: st, endTime: et },
				service: params.service,
				environment: params.environment,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("service_dependencies")),
			)

			// The warehouse query does not scope by service, so filter to edges
			// involving the specified service here.
			const edges =
				params.service === undefined
					? allEdges
					: allEdges.filter(
							(e) => e.sourceService === params.service || e.targetService === params.service,
						)

			const serviceCount = new Set(edges.flatMap((e) => [e.sourceService, e.targetService])).size

			return {
				timeRange: { start: st, end: et },
				edges: edges.map((e) => ({
					sourceService: e.sourceService,
					targetService: e.targetService,
					callCount: e.callCount,
					errorCount: e.errorCount,
					avgDurationMs: e.avgDurationMs,
					maxDurationMs: e.maxDurationMs,
				})),
				serviceCount,
				...(params.service === undefined ? undefined : { service: params.service }),
				...(params.environment === undefined ? undefined : { environment: params.environment }),
			}
		}),
		render: (output) => {
			const errorTargets = output.edges
				.map((e) => ({ service: e.targetService, errorRate: errorRateOf(e) }))
				.filter((e) => e.errorRate > 0.01)
				.sort((a, b) => b.errorRate - a.errorRate)
				.slice(0, 2)
			return {
				title: "Service Map",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Service", output.service],
					["Environment", output.environment],
				],
				...(output.edges.length === 0
					? {
							empty: {
								message: `No service dependencies found${output.service === undefined ? "" : ` involving "${output.service}"`} in this window.`,
								hints: [
									"Widen start_time/end_time, or drop the service and environment filters.",
								],
							},
						}
					: undefined),
				blocks:
					output.edges.length === 0
						? []
						: [
								doc.text(`Services: ${output.serviceCount} | Edges: ${output.edges.length}`),
								doc.table(
									[
										"Source → Target",
										"Calls",
										"Errors",
										"Error Rate",
										"Avg Duration",
										"Max Duration",
									],
									output.edges.map((e) => [
										`${e.sourceService} → ${e.targetService}`,
										formatNumber(e.callCount),
										formatNumber(e.errorCount),
										formatPercent(errorRateOf(e)),
										formatDurationFromMs(e.avgDurationMs),
										formatDurationFromMs(e.maxDurationMs),
									]),
								),
							],
				next:
					errorTargets.length > 0
						? errorTargets.map((e) =>
								doc.next(
									"diagnose_service",
									{ service: e.service },
									"investigate high error rate dependency",
								),
							)
						: [doc.next("list_services", {}, "see all services with health metrics")],
			}
		},
	})
}
