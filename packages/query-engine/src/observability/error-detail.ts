import { Array as Arr, Effect, pipe } from "effect"
import type { ErrorDetailTracesOutput, ErrorsTimeseriesOutput, ListLogsOutput } from "@maple/domain/tinybird"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { TimeRange } from "./types"

export interface ErrorDetailTrace {
	readonly traceId: string
	readonly rootSpanName: string
	readonly durationMs: number
	readonly spanCount: number
	readonly services: string[]
	readonly startTime: string
	readonly errorMessage: string
	readonly logs: ReadonlyArray<{ timestamp: string; severityText: string; body: string }>
}

export interface ErrorDetailOutput {
	readonly fingerprintHash: string
	readonly timeRange: TimeRange
	readonly traces: ReadonlyArray<ErrorDetailTrace>
	readonly timeseries?: ReadonlyArray<{ bucket: string; count: number }>
}

export const errorDetail = Effect.fn("Observability.errorDetail")(function* (input: {
	readonly fingerprintHash: string
	readonly timeRange: TimeRange
	readonly service?: string
	readonly includeTimeseries?: boolean
	readonly limit?: number
}) {
	const executor = yield* WarehouseExecutor
	const limit = input.limit ?? 5

	yield* Effect.annotateCurrentSpan({
		fingerprintHash: input.fingerprintHash,
		service: input.service ?? "all",
	})

	const tracesResult = yield* executor.query<ErrorDetailTracesOutput>(
		"error_detail_traces",
		{
			fingerprint_hash: input.fingerprintHash,
			start_time: input.timeRange.startTime,
			end_time: input.timeRange.endTime,
			...(input.service && { services: input.service }),
			limit,
		},
		{ profile: "list" },
	)

	const traces = tracesResult.data
	yield* Effect.annotateCurrentSpan("traceCount", traces.length)

	// Fetch logs for first 3 traces in parallel
	const logsResults = yield* pipe(
		traces,
		Arr.take(3),
		Effect.forEach(
			(t) =>
				executor.query<ListLogsOutput>(
					"list_logs",
					{ trace_id: t.traceId, limit: 10 },
					{ profile: "list" },
				),
			{ concurrency: "unbounded" },
		),
	)

	// Optionally fetch timeseries
	const timeseries = input.includeTimeseries
		? yield* executor
				.query<ErrorsTimeseriesOutput>(
					"errors_timeseries",
					{
						fingerprint_hash: input.fingerprintHash,
						start_time: input.timeRange.startTime,
						end_time: input.timeRange.endTime,
						...(input.service && { services: input.service }),
					},
					{ profile: "aggregation" },
				)
				.pipe(
					Effect.map((r) =>
						pipe(
							r.data,
							Arr.map((p) => ({ bucket: String(p.bucket), count: Number(p.count) })),
						),
					),
				)
		: undefined

	return {
		fingerprintHash: input.fingerprintHash,
		timeRange: input.timeRange,
		traces: pipe(
			traces,
			Arr.map(
				(t, i): ErrorDetailTrace => ({
					traceId: t.traceId,
					rootSpanName: t.rootSpanName,
					durationMs: Number(t.durationMicros) / 1000,
					spanCount: Number(t.spanCount),
					services: t.services ?? [],
					startTime: String(t.startTime),
					errorMessage: t.errorMessage ?? "",
					logs: pipe(
						i < logsResults.length ? logsResults[i]!.data : [],
						Arr.take(5),
						Arr.map((l) => ({
							timestamp: String(l.timestamp),
							severityText: l.severityText || "INFO",
							body: l.body,
						})),
					),
				}),
			),
		),
		timeseries,
	}
})
