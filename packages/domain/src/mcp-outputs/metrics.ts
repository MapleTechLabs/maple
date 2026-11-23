import { Schema } from "effect"
import { MetricType } from "../query-engine"
import { OutputTimeRange } from "./shared"

/** One exemplar: the trace and span an SDK sampled while recording a metric value. */
export const MetricExemplarEntry = Schema.Struct({
	/** Start of the time bucket the exemplar was ranked in, UTC. */
	bucket: Schema.String,
	/** When the value was recorded, UTC. */
	timestamp: Schema.String,
	value: Schema.Number,
	traceId: Schema.String,
	spanId: Schema.String,
	serviceName: Schema.String,
})

export const GetMetricExemplarsOutput = Schema.Struct({
	metricName: Schema.String,
	metricType: MetricType,
	timeRange: OutputTimeRange,
	bucketSeconds: Schema.Number,
	/** Exemplars kept per time bucket, highest value first. */
	perBucket: Schema.Number,
	filters: Schema.Struct({
		service: Schema.optionalKey(Schema.String),
		environment: Schema.optionalKey(Schema.String),
		attributeFilterCount: Schema.optionalKey(Schema.Number),
	}),
	/** Highest value first across the window. */
	exemplars: Schema.Array(MetricExemplarEntry),
	/** True when `limit` cut the list. */
	truncated: Schema.Boolean,
})
