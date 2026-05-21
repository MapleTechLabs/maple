import { Array as Arr, Effect, pipe, Record } from "effect"
import type { ServiceOverviewOutput } from "@maple/domain/tinybird"
import { TinybirdExecutor } from "./TinybirdExecutor"
import type { ListServicesInput, ServiceSummary } from "./types"
import { aggregateServiceRows, weightedAvg } from "./aggregation"

export const listServices = Effect.fn("Observability.listServices")(function* (input: ListServicesInput) {
	const executor = yield* TinybirdExecutor

	yield* Effect.annotateCurrentSpan("environment", input.environment ?? "all")

	const result = yield* executor.query<ServiceOverviewOutput>(
		"service_overview",
		{
			start_time: input.timeRange.startTime,
			end_time: input.timeRange.endTime,
			...(input.environment && { environments: input.environment }),
		},
		{ profile: "aggregation" },
	)

	const services = pipe(
		result.data,
		Arr.groupBy((r) => r.serviceName),
		Record.map((group) => aggregateServiceRows(group)),
		Record.toEntries,
		Arr.map(
			([name, svc]): ServiceSummary => ({
				name,
				throughput: svc.throughput,
				errorCount: svc.errorCount,
				errorRate: svc.throughput > 0 ? svc.errorCount / svc.throughput : 0,
				p50Ms: weightedAvg(svc.weightedP50, svc.throughput),
				p95Ms: weightedAvg(svc.weightedP95, svc.throughput),
				p99Ms: weightedAvg(svc.weightedP99, svc.throughput),
			}),
		),
		Arr.sort((a: ServiceSummary, b: ServiceSummary) =>
			b.throughput > a.throughput ? -1 : b.throughput < a.throughput ? 1 : 0,
		),
	)

	yield* Effect.annotateCurrentSpan("serviceCount", services.length)

	return services
})
