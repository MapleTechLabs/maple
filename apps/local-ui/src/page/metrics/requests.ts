import { Schema } from "effect"
import { SparklineGroup } from "./fetch"

// What each metrics read asks for; a cached answer carries it back so the fetch can follow.

const Window = { startTime: Schema.String, endTime: Schema.String, apiBase: Schema.String }

export const ListRequest = Schema.Struct({
	key: Schema.String,
	type: Schema.optional(Schema.String),
	search: Schema.optional(Schema.String),
	...Window,
})
export const SummaryRequest = Schema.Struct({ key: Schema.String, service: Schema.optional(Schema.String), ...Window })
export const SparklinesRequest = Schema.Struct({
	key: Schema.String,
	groups: Schema.Array(SparklineGroup),
	bucketSeconds: Schema.Number,
	...Window,
})
