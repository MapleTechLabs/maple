import { ChartEnvFields } from "@maple/views/charts/chart-env"
import * as Chart from "@maple/views/charts/chart"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as ProfileFlamegraph from "@maple/views/profiles/profile-flamegraph"
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

/** The service's heaviest call stacks of one sample type in the window; null when it sent no profiles. */
export const ServiceProfile = Schema.NullOr(
	Schema.Struct({
		sampleType: Schema.String,
		sampleUnit: Schema.String,
		/** Every stack in the window, including those past the read's cap. */
		totalValue: Schema.Number,
		totalStacks: Schema.Number,
		/** The summed length of the profiled windows: CPU time over it is average cores. */
		durationNano: Schema.Number,
		stacks: Schema.Array(
			Schema.Struct({
				frames: Schema.Array(Schema.String),
				files: Schema.Array(Schema.String),
				lines: Schema.Array(Schema.Number),
				value: Schema.Number,
			}),
		),
	}),
)
export type ServiceProfile = typeof ServiceProfile.Type

export const Model = Schema.TaggedStruct("ServiceDetailPage", {
	serviceName: Schema.String,
	/** The time window's anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	/** The clock at the last read: relative times and `chartWindow`'s "now". */
	nowMs: Schema.Number,
	overview: KeyedSchema(Overview, LoadFailure),
	operations: KeyedSchema(Schema.Array(OperationRow), LoadFailure),
	timeseries: KeyedSchema(Schema.Array(SeriesPoint), LoadFailure),
	golden: KeyedSchema(Schema.Array(GoldenSignalRow), LoadFailure),
	profile: KeyedSchema(ServiceProfile, LoadFailure),
	flamegraph: ProfileFlamegraph.Model,
	overviewUpdatedAtMs: Schema.Number,
	isRefreshing: Schema.Boolean,
	...ChartEnvFields,
	charts: Schema.Record(Schema.String, Chart.Model),
})
export type Model = typeof Model.Type
