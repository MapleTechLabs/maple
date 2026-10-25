import { Schema } from "effect"

/** One metric picker entry: `name::type`, its label, and whether a sum is monotonic. */
export const MetricOptionSchema = Schema.Struct({
	value: Schema.String,
	label: Schema.String,
	isMonotonic: Schema.Boolean,
})
export type MetricOption = typeof MetricOptionSchema.Type

/** One `listMetrics` page: the picker's options and every row's service (`metricServices`). */
export const MetricPageSchema = Schema.Struct({
	options: Schema.Array(MetricOptionSchema),
	services: Schema.Array(Schema.String),
})
