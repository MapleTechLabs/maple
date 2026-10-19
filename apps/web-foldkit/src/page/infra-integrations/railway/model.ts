import { RailwayIntegrationStatus } from "@maple/domain/http"
import { Schema } from "effect"

// Row schemas shared by the Railway pages: `@maple/web-data/warehouse/railway-infra`'s rows.

export const RailwayServiceRow = Schema.Struct({
	environmentId: Schema.String,
	serviceId: Schema.String,
	serviceName: Schema.String,
	projectName: Schema.String,
	environmentName: Schema.String,
	cpuAvg: Schema.Number,
	cpuMax: Schema.Number,
	cpuLimit: Schema.Number,
	memoryAvg: Schema.Number,
	memoryMax: Schema.Number,
	memoryLimit: Schema.Number,
	replicas: Schema.Number,
	lastSeen: Schema.String,
})
export type RailwayServiceRow = typeof RailwayServiceRow.Type

export const RailwayServiceTimeseriesRow = Schema.Struct({
	bucket: Schema.String,
	cpuAvg: Schema.Number,
	cpuMax: Schema.Number,
	cpuLimit: Schema.Number,
	memoryAvg: Schema.Number,
	memoryMax: Schema.Number,
	memoryLimit: Schema.Number,
	networkRx: Schema.Number,
	networkTx: Schema.Number,
	diskVolume: Schema.Number,
	diskEphemeral: Schema.Number,
	replicas: Schema.Number,
})
export type RailwayServiceTimeseriesRow = typeof RailwayServiceTimeseriesRow.Type

export const RailwayStatus = RailwayIntegrationStatus
export type RailwayStatus = RailwayIntegrationStatus
