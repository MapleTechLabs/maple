import * as Chart from "@maple/web/charts/chart"
import { ChartRuntime } from "@maple/web/charts/chart-runtime"
import { ThemeColors } from "@maple/web/charts/theme-colors"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { ServiceCatalogEntry } from "../services/model"

// The service detail page's data, as Schemas.

/** `ServiceOverview`: the header stats and where the chart starts; null when the service is quiet. */
export const Overview = Schema.NullOr(
	Schema.Struct({ stats: ServiceCatalogEntry, firstSeenMs: Schema.NullOr(Schema.Number) }),
)
export type Overview = typeof Overview.Type

export const OperationRow = Schema.Struct({
	spanName: Schema.String,
	spanCount: Schema.Number,
	estimatedSpanCount: Schema.Number,
	errorCount: Schema.Number,
	estimatedErrorCount: Schema.Number,
	errorRate: Schema.Number,
	avgDurationMs: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	p99DurationMs: Schema.Number,
})
export type OperationRow = typeof OperationRow.Type

/** `SeriesPoint` (lib/chart-series.ts): one long-form (bucket, series, value) row. */
export const SeriesPoint = Schema.Struct({
	bucket: Schema.String,
	series: Schema.String,
	value: Schema.Number,
})
export type SeriesPoint = typeof SeriesPoint.Type

/** `GoldenSignalRow` (lib/golden-signals.ts): one warehouse bucket of entry-span signals. */
export const GoldenSignalRow = Schema.Struct({
	bucketMs: Schema.Number,
	count: Schema.Number,
	errorRate: Schema.Number,
	p50Ms: Schema.Number,
	p95Ms: Schema.Number,
	p99Ms: Schema.Number,
	apdexScore: Schema.Number,
})
export type GoldenSignalRow = typeof GoldenSignalRow.Type

export const Model = Schema.TaggedStruct("ServiceDetailPage", {
	serviceName: Schema.String,
	/** The time window's anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	/** The clock at the last read: relative times and `chartWindow`'s "now". */
	nowMs: Schema.Number,
	overview: SlotSchema(Overview),
	operations: SlotSchema(Schema.Array(OperationRow)),
	timeseries: SlotSchema(Schema.Array(SeriesPoint)),
	golden: SlotSchema(Schema.Array(GoldenSignalRow)),
	overviewUpdatedAtMs: Schema.Number,
	isRefreshing: Schema.Boolean,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	charts: Schema.Record(Schema.String, Chart.Model),
})
export type Model = typeof Model.Type
