import { Schema } from "effect"
import { OutputTimeRange } from "./shared"

/** A sample value: a finite number, or Prometheus' spelling of a non-finite one. */
export const PromqlSampleValue = Schema.Union([Schema.Finite, Schema.Literals(["NaN", "+Inf", "-Inf"])])

/** One sample: epoch ms and value. */
export const PromqlPoint = Schema.Struct({ t: Schema.Number, v: PromqlSampleValue })

export const PromqlSeries = Schema.Struct({
	/** Prometheus labels, `__name__` included when the expression keeps it. */
	labels: Schema.Record(Schema.String, Schema.String),
	/** The last `points` samples of the series; `totalPoints` counts them all. */
	points: Schema.Array(PromqlPoint),
	totalPoints: Schema.Number,
	/** Min, average and max over every point, not only the listed ones; absent when all are NaN. */
	stats: Schema.optionalKey(
		Schema.Struct({ min: PromqlSampleValue, avg: PromqlSampleValue, max: PromqlSampleValue }),
	),
})

export const QueryPromqlOutput = Schema.Struct({
	query: Schema.String,
	resultType: Schema.Literals(["matrix", "vector", "scalar", "string"]),
	/** Evaluated at `timeRange.end` alone, not over the range. */
	instant: Schema.Boolean,
	timeRange: OutputTimeRange,
	/** Resolution step of a range evaluation, 0 for an instant one. */
	stepSeconds: Schema.Number,
	/** Series kept, at most the cap; a scalar is one series with no labels. */
	series: Schema.Array(PromqlSeries),
	totalSeries: Schema.Number,
	/** A `string` result's value. */
	stringValue: Schema.optionalKey(Schema.String),
})
