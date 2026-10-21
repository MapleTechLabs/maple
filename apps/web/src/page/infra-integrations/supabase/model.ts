import { SupabaseIntegrationStatus, SupabaseProjectInsights } from "@maple/domain/http"
import { Schema } from "effect"

// Row schemas shared by the Supabase pages: `@maple/web-data/warehouse/supabase-infra`'s rows.

export const SupabaseProjectRow = Schema.Struct({
	projectRef: Schema.String,
	cpuAvg: Schema.Number,
	cpuMax: Schema.Number,
	memoryAvg: Schema.Number,
	memoryMax: Schema.Number,
	memoryTotal: Schema.Number,
	diskUsedMax: Schema.Number,
	diskSize: Schema.Number,
	dbSize: Schema.Number,
	connectionsAvg: Schema.Number,
	connectionsMax: Schema.Number,
	/** Postgres' `max_connections`; null when the project never reported it. */
	maxConnections: Schema.NullOr(Schema.Number),
	/** Edge requests from the polled logs; 0 while logs are off. */
	requests: Schema.Number,
	requestsPerMinute: Schema.Number,
	errors5xx: Schema.Number,
	/** WARN-or-worse log lines of any source. */
	issueCount: Schema.Number,
	lastSeen: Schema.String,
})
export type SupabaseProjectRow = typeof SupabaseProjectRow.Type

export const SupabaseProjectTimeseriesRow = Schema.Struct({
	bucket: Schema.String,
	cpu: Schema.Number,
	memoryAvg: Schema.Number,
	memoryMax: Schema.Number,
	memoryTotal: Schema.Number,
	diskUsed: Schema.Number,
	diskSize: Schema.Number,
	dbSize: Schema.Number,
	connectionsAvg: Schema.Number,
	connectionsMax: Schema.Number,
	/** Null for a bucket without the sample. */
	maxConnections: Schema.NullOr(Schema.Number),
	poolerClients: Schema.Number,
	/** Per-second rates are null for a bucket holding a counter's first sample. */
	commitsPerSecond: Schema.NullOr(Schema.Number),
	rollbacksPerSecond: Schema.NullOr(Schema.Number),
	/** Null for a bucket with no block reads. */
	cacheHitRatio: Schema.NullOr(Schema.Number),
	authUsers: Schema.Number,
	authSamples: Schema.Number,
	postgrestPoolMax: Schema.Number,
	postgrestPoolInUse: Schema.Number,
	postgrestPoolWaiting: Schema.Number,
	networkRxPerSecond: Schema.NullOr(Schema.Number),
	networkTxPerSecond: Schema.NullOr(Schema.Number),
	diskReadPerSecond: Schema.NullOr(Schema.Number),
	diskWritePerSecond: Schema.NullOr(Schema.Number),
})
export type SupabaseProjectTimeseriesRow = typeof SupabaseProjectTimeseriesRow.Type

export const SupabaseStatus = SupabaseIntegrationStatus
export type SupabaseStatus = SupabaseIntegrationStatus

/** The overview's advisor read: each project's insights, and the refs whose read failed. */
export const SupabaseFleetInsights = Schema.Struct({
	insights: Schema.Array(SupabaseProjectInsights),
	failedRefs: Schema.Array(Schema.String),
})
export type SupabaseFleetInsights = typeof SupabaseFleetInsights.Type
