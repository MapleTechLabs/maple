import { Effect, Schema } from "effect"
import {
	MetricDistributionRequest,
	type MetricDistributionRow,
	type MetricExemplarRow,
	MetricExemplarsRequest,
} from "@maple/domain/http"
import type { MetricsFilters } from "@maple/domain/query-engine"
import { MetricsQueryDraftSchema } from "@maple/query-model"
import { buildTimeseriesQuerySpec } from "@maple/query-engine/query-builder"
import { resolveTimeseriesBucketSpec } from "@maple/query-engine/query-set"
import { MapleInternalHttp } from "./warehouse-services"
import {
	WarehouseDateTimeString,
	decodeInput,
	invalidWarehouseInput,
	runWarehouseQuery,
} from "./effect-utils"

// The metric detail page's reads beside its chart: the histogram distribution (heatmap)
// and the exemplars. Both take the chart's own draft, so they see what the chart sees.

const MetricDetailRequestInput = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	query: MetricsQueryDraftSchema,
	/** Exemplars only: one heatmap cell, (lower, upper] in its time bucket. */
	cell: Schema.optional(
		Schema.Struct({
			bucket: WarehouseDateTimeString,
			lowerBound: Schema.NullOr(Schema.Finite),
			upperBound: Schema.NullOr(Schema.Finite),
		}),
	),
})
export type MetricDetailInput = (typeof MetricDetailRequestInput)["Encoded"]

interface ChartScope {
	readonly filters: MetricsFilters
	readonly bucketSeconds: number
}

/** The chart's filters and bucket width, lowered from its draft the way the chart lowers it. */
const chartScope = Effect.fn("QueryEngine.metricChartScope")(function* (
	input: typeof MetricDetailRequestInput.Type,
	operation: string,
) {
	const built = buildTimeseriesQuerySpec({ ...input.query })
	if (built.query === null)
		return yield* invalidWarehouseInput(operation, built.error ?? "Invalid metric query")
	const spec = resolveTimeseriesBucketSpec(built.query, input.startTime, input.endTime)
	if (spec.kind !== "timeseries" || spec.source !== "metrics") {
		return yield* invalidWarehouseInput(operation, "Not a metrics query")
	}
	const scope: ChartScope = { filters: spec.filters, bucketSeconds: spec.bucketSeconds ?? 60 }
	return scope
})

export const getMetricDistribution = Effect.fn("QueryEngine.getMetricDistribution")(function* ({
	data,
}: {
	data: MetricDetailInput
}) {
	const input = yield* decodeInput(MetricDetailRequestInput, data, "getMetricDistribution")
	const scope = yield* chartScope(input, "getMetricDistribution")
	const response = yield* runWarehouseQuery("metricDistribution", () =>
		Effect.flatMap(MapleInternalHttp, (client) =>
			client.queryEngine.metricDistribution({
				payload: new MetricDistributionRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: scope.bucketSeconds,
					filters: scope.filters,
				}),
			}),
		),
	)
	const rows: ReadonlyArray<MetricDistributionRow> = response.data
	return { rows, bucketSeconds: scope.bucketSeconds }
})

export const getMetricExemplars = Effect.fn("QueryEngine.getMetricExemplars")(function* ({
	data,
}: {
	data: MetricDetailInput
}) {
	const input = yield* decodeInput(MetricDetailRequestInput, data, "getMetricExemplars")
	const scope = yield* chartScope(input, "getMetricExemplars")
	const response = yield* runWarehouseQuery("metricExemplars", () =>
		Effect.flatMap(MapleInternalHttp, (client) =>
			client.queryEngine.metricExemplars({
				payload: new MetricExemplarsRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: scope.bucketSeconds,
					filters: scope.filters,
					// A cell lists more than a bucket's top three: it is what the reader picked.
					...(input.cell === undefined ? undefined : { cell: input.cell, perBucket: 20 }),
				}),
			}),
		),
	)
	const rows: ReadonlyArray<MetricExemplarRow> = response.data
	return rows
})
