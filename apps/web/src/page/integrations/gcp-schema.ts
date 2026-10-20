import { Schema } from "effect"

// The Google Cloud card's data shapes (shared by the Model and the Messages).

export const LogVolume = Schema.Struct({
	total: Schema.Number,
	errors: Schema.Number,
	warnings: Schema.Number,
	hourly: Schema.Array(Schema.Number),
})
export type LogVolume = typeof LogVolume.Type

/** `RemovedGcpConnector`: a connection removed before its cleanup script was seen to run. */
export const RemovedConnector = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	hostProjectId: Schema.String,
	cleanupScript: Schema.String,
	reported: Schema.Boolean,
})
export type RemovedConnector = typeof RemovedConnector.Type

/** What Configure opens: a new connection, or one connection at a stage. */
export const ConfigureTarget = Schema.Union([
	Schema.TaggedStruct("New", {}),
	Schema.TaggedStruct("Connection", { id: Schema.String, stage: Schema.Literals(["choose", "apply"]) }),
])
export type ConfigureTarget = typeof ConfigureTarget.Type
