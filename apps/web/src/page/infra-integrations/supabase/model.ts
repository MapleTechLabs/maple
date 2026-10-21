import { SupabaseIntegrationStatus } from "@maple/domain/http"
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
	poolerClientsMax: Schema.Number,
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
	poolerClients: Schema.Number,
	poolerWaiting: Schema.Number,
	commitsPerSecond: Schema.Number,
	rollbacksPerSecond: Schema.Number,
	cacheHitRatio: Schema.Number,
	cacheReads: Schema.Number,
	deadlocks: Schema.Number,
	authUsers: Schema.Number,
	authSamples: Schema.Number,
	realtimeSubscriptions: Schema.Number,
	postgrestPoolMax: Schema.Number,
	postgrestPoolInUse: Schema.Number,
	postgrestPoolWaiting: Schema.Number,
	networkRxPerSecond: Schema.Number,
	networkTxPerSecond: Schema.Number,
	diskReadPerSecond: Schema.Number,
	diskWritePerSecond: Schema.Number,
})
export type SupabaseProjectTimeseriesRow = typeof SupabaseProjectTimeseriesRow.Type

export const SupabaseStatus = SupabaseIntegrationStatus
export type SupabaseStatus = SupabaseIntegrationStatus
