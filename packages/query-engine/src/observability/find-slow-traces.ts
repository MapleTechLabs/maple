import { Array as Arr, Effect, pipe } from "effect"
import { TraceId } from "@maple/domain"
import type { TracesDurationStatsOutput } from "@maple/domain/tinybird"
import { Schema } from "effect"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { FindSlowTracesInput, FindSlowTracesOutput, SpanResult } from "./types"
import { safeUInt } from "./sql-utils"

const MAX_LIMIT = 1000

/**
 * Returns the slowest root spans in a time range, ordered by Duration DESC at
 * the database via the `slow_traces` pipe. Previously this fetched 500 rows
 * from the `list_traces` pipe (sorted by recency) and sorted them in JS, which
 * both over-fetched and returned the wrong page when the actual slowest traces
 * were older than the 500 most-recent.
 *
 * Routing through a named pipe (rather than building raw SQL here) lets the
 * same code run unchanged against both local chDB and the remote warehouse —
 * the executor decides where the compiled SQL runs.
 */
export const findSlowTraces = Effect.fn("Observability.findSlowTraces")(function* (
	input: FindSlowTracesInput,
) {
	const executor = yield* WarehouseExecutor
	const limit = safeUInt(input.limit, 10, MAX_LIMIT)

	yield* Effect.annotateCurrentSpan("service", input.service ?? "all")

	interface SlowTraceRow {
		readonly traceId: string
		readonly spanName: string
		readonly serviceName: string
		readonly durationMs: number
		readonly statusCode: string
		readonly timestamp: string
	}

	const [slowResult, statsResult] = yield* Effect.all(
		[
			executor.query<SlowTraceRow>(
				"slow_traces",
				{
					start_time: input.timeRange.startTime,
					end_time: input.timeRange.endTime,
					...(input.service && { service: input.service }),
					...(input.environment && { deployment_env: input.environment }),
					limit,
				},
				{ profile: "list" },
			),
			executor.query<TracesDurationStatsOutput>(
				"traces_duration_stats",
				{
					start_time: input.timeRange.startTime,
					end_time: input.timeRange.endTime,
					...(input.service && { service: input.service }),
					...(input.environment && { deployment_env: input.environment }),
				},
				{ profile: "aggregation" },
			),
		],
		{ concurrency: "unbounded" },
	)

	const rows = slowResult.data

	const traces: ReadonlyArray<SpanResult> = pipe(
		rows,
		Arr.map(
			(r): SpanResult => ({
				traceId: Schema.decodeSync(TraceId)(r.traceId),
				spanId: null,
				spanName: r.spanName,
				serviceName: r.serviceName,
				durationMs: Number(r.durationMs),
				statusCode: r.statusCode,
				statusMessage: "",
				attributes: {},
				resourceAttributes: {},
				timestamp: r.timestamp,
			}),
		),
	)

	const rawStats = rows.length > 0 ? statsResult.data[0] : undefined

	return {
		timeRange: input.timeRange,
		stats: rawStats
			? {
					p50Ms: Number(rawStats.p50DurationMs ?? 0),
					p95Ms: Number(rawStats.p95DurationMs ?? 0),
					minMs: Number(rawStats.minDurationMs ?? 0),
					maxMs: Number(rawStats.maxDurationMs ?? 0),
				}
			: null,
		traces,
	} satisfies FindSlowTracesOutput
})
