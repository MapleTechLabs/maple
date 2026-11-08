import { Array as Arr, Effect, pipe } from "effect"
import type { TopOperationsOutput } from "../ch/queries/top-operations"
import type { TracesMetric } from "@maple/domain/query-engine"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { TimeRange } from "./types"

export interface TopOperation {
	readonly name: string
	readonly value: number
}

export const topOperations = Effect.fn("Observability.topOperations")(function* (input: {
	readonly serviceName: string
	readonly metric: TracesMetric
	readonly timeRange: TimeRange
	readonly limit?: number
	readonly environment?: string
	/** Skip the operation rollups, for a cluster that turned out not to have them. */
	readonly rawOnly?: boolean
}) {
	const executor = yield* WarehouseExecutor

	yield* Effect.annotateCurrentSpan({
		"maple.query.service": input.serviceName,
		"query.metric": input.metric,
	})

	const result = yield* executor.query<TopOperationsOutput>(
		"top_operations",
		{
			service_name: input.serviceName,
			metric: input.metric,
			limit: input.limit ?? 20,
			...(input.environment === undefined ? undefined : { environment: input.environment }),
			...(input.rawOnly === true ? { raw_only: "1" } : undefined),
			start_time: input.timeRange.startTime,
			end_time: input.timeRange.endTime,
		},
		{ profile: "aggregation" },
	)
	yield* Effect.annotateCurrentSpan("result.operationCount", result.data.length)
	return pipe(
		result.data,
		Arr.map((r): TopOperation => ({ name: r.name, value: r.value })),
	)
})
