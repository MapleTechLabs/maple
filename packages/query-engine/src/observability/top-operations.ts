import { Array as Arr, Effect, pipe } from "effect"
import * as CH from "../ch"
import type { TracesMetric } from "../query-engine"
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
}) {
	const executor = yield* WarehouseExecutor

	yield* Effect.annotateCurrentSpan({
		service: input.serviceName,
		metric: input.metric,
	})

	const compiled = CH.compile(CH.topOperationsQuery({ metric: input.metric, limit: input.limit ?? 20 }), {
		orgId: executor.orgId,
		serviceName: input.serviceName,
		startTime: input.timeRange.startTime,
		endTime: input.timeRange.endTime,
	})

	const rows = compiled.castRows(yield* executor.sqlQuery(compiled.sql, { profile: "aggregation" }))
	yield* Effect.annotateCurrentSpan("operationCount", rows.length)
	return pipe(
		rows,
		Arr.map((r): TopOperation => ({ name: r.name, value: Number(r.value) })),
	)
})
