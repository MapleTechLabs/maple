import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Effect, Schema } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import type { TimeWindow } from "../../../data/time-range"

// The traced services of a window, for the infra pages' "Traced as": an integration names its
// resource's metrics after the resource, so the traced service of that name is the same thing.

/** A traced service's entry spans: what "Traced as" matches a resource's name against. */
export const TracedService = Schema.Struct({
	serviceName: Schema.String,
	errorRate: Schema.Number,
	throughput: Schema.Number,
	p95LatencyMs: Schema.Number,
})
export type TracedService = typeof TracedService.Type

export const loadTraced = (window: TimeWindow) =>
	getServiceOverview({ data: { startTime: window.startTime, endTime: window.endTime } }).pipe(
		Effect.map((response): ReadonlyArray<TracedService> =>
			response.data.map((row) => ({
				serviceName: row.serviceName,
				errorRate: row.errorRate,
				throughput: row.throughput,
				p95LatencyMs: row.p95LatencyMs,
			})),
		),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)
