import type { McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatPercent, formatDurationFromMs, formatNumber } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { ListServicesOutput } from "@maple/domain/mcp-outputs"
import { listServices } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 6 })

export function registerListServicesTool(server: McpToolRegistrar) {
	server.define({
		name: "list_services",
		description:
			"List all active services with key metrics (throughput, error rate, P95 latency). Use as an entry point to discover services before drilling down with diagnose_service or get_service_top_operations.",
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
				services: services.map((s) => ({
					name: s.name,
					throughput: s.throughput,
					errorRate: s.errorRate,
					p95Ms: s.p95Ms,
				})),
				...(params.environment === undefined ? undefined : { environment: params.environment }),
			}
		}),
		render: (output) => ({
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
								["Service", "Throughput (rpm)", "Error Rate", "P95 Latency"],
								output.services.map((s) => [
									s.name,
									formatNumber(s.throughput),
									formatPercent(s.errorRate),
									formatDurationFromMs(s.p95Ms),
								]),
							),
						],
			next: [
				...output.services
					.slice(0, 3)
					.map((s) =>
						doc.next("diagnose_service", { service: s.name }, `deep-dive into ${s.name}`),
					),
				...output.services
					.slice(0, 1)
					.map((s) =>
						doc.next(
							"get_service_top_operations",
							{ service: s.name },
							"see top endpoints for a service",
						),
					),
			],
		}),
	})
}
