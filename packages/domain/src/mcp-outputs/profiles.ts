import { Schema } from "effect"
import { OutputTimeRange } from "./shared"

/** One sample type the scope sent, in one unit: `value / durationNano` is average cores for CPU. */
export const ProfileHotspotsSampleType = Schema.Struct({
	sampleType: Schema.String,
	sampleUnit: Schema.String,
	value: Schema.Number,
	profiles: Schema.Number,
	durationNano: Schema.Number,
})

/** A function and the value sampled in it (`self`) and under it (`total`), in the read's unit. */
export const ProfileHotspotsFunction = Schema.Struct({
	name: Schema.String,
	file: Schema.String,
	line: Schema.Number,
	self: Schema.Number,
	total: Schema.Number,
})

export const ProfileHotspotsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	serviceName: Schema.String,
	environment: Schema.optionalKey(Schema.String),
	traceId: Schema.optionalKey(Schema.String),
	/** Heaviest first; empty when the scope sent no profiles. */
	sampleTypes: Schema.Array(ProfileHotspotsSampleType),
	/** The sample type the functions are read from; absent with no profiles. */
	sampleType: Schema.optionalKey(Schema.String),
	sampleUnit: Schema.optionalKey(Schema.String),
	/** Every stack of that type in scope, including those past the stack cap. */
	totalValue: Schema.Number,
	totalStacks: Schema.Number,
	/** The read kept the heaviest stacks only: function totals miss the rest. */
	truncated: Schema.Boolean,
	functions: Schema.Array(ProfileHotspotsFunction),
})
