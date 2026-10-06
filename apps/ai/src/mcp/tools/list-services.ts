import type { McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatPercent, formatDurationFromMs, formatNumber } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { ListServicesOutput } from "@maple/domain/mcp-outputs"
import { listServices } from "@maple/query-engine/observability"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 6 })

export function registerListServicesTool(server: McpToolRegistrar) {
	server.define({
		name: "list_services",
		title: "List Services",
		description:
			"List all active services, busiest first, with request count and rate, error rate and P95 latency. Use as an entry point to discover services before drilling down with diagnose_service or get_service_top_operations.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			environment: P.environment(),
		}),
		output: ListServicesOutput,
		hints: { readOnly: true },
		phrases: ["Listing services", "Checking which services are reporting"],
		handler: Effect.fn("McpTool.listServices")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "list_services")
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				environment: params.environment ?? "all",
			})

			const services = yield* listServices({
				timeRange: { startTime: st, endTime: et },
				environment: params.environment,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("service_overview")),
			)

			yield* Effect.annotateCurrentSpan("result.rowCount", services.length)

			return {
				timeRange: { start: st, end: et },
				total: services.length,
				// Busiest first, so a truncated table still shows the services that carry the traffic.
				services: [...services]
					.sort((a, b) => b.throughput - a.throughput)
					.map((s) => ({
						name: s.name,
						throughput: s.throughput,
						errorRate: s.errorRate,
						p95Ms: s.p95Ms,
					})),
				...(params.environment === undefined ? undefined : { environment: params.environment }),
			}
		}),
		render: (output) => {
			const minutes = windowMinutes(output.timeRange)
			const unhealthy = output.services
				.filter((s) => s.errorRate > 0)
				.sort((a, b) => b.errorRate - a.errorRate || b.throughput - a.throughput)
			return {
				title: "Services",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Environment", output.environment],
				],
				...(output.services.length === 0
					? {
							empty: {
								message: "No active services found in this time range.",
								hints: ["Widen start_time/end_time, or drop the environment filter."],
							},
						}
					: undefined),
				blocks:
					output.services.length === 0
						? []
						: [
								doc.text(`Total: ${output.total} service${output.total !== 1 ? "s" : ""}`),
								doc.table(
									["Service", "Requests", "Req/min", "Error Rate", "P95 Latency"],
									output.services.map((s) => [
										s.name,
										formatNumber(s.throughput),
										minutes > 0 ? formatRate(s.throughput / minutes) : "-",
										formatPercent(s.errorRate),
										formatDurationFromMs(s.p95Ms),
									]),
								),
							],
				next: [
					...(unhealthy.length > 0 ? unhealthy : output.services)
						.slice(0, 3)
						.map((s) =>
							doc.next(
								"diagnose_service",
								{ service: s.name },
								s.errorRate > 0
									? `deep-dive into ${s.name} (${formatPercent(s.errorRate)} errors)`
									: `deep-dive into ${s.name}, the busiest service`,
							),
						),
					...output.services
						.slice(0, 1)
						.map((s) =>
							doc.next(
								"get_service_top_operations",
								{ service: s.name },
								`see top endpoints of ${s.name}, the busiest service`,
							),
						),
				],
			}
		},
	})
}

const windowMinutes = (range: { readonly start: string; readonly end: string }): number =>
	(parseWarehouseDateTime(range.end) - parseWarehouseDateTime(range.start)) / 60_000

const formatRate = (perMinute: number): string =>
	perMinute >= 10 ? formatNumber(Math.round(perMinute)) : perMinute.toFixed(2)
