import { Clock, Effect, Schema } from "effect"
import { SupabaseInfraProjectsRequest, SupabaseInfraProjectTimeseriesRequest } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

/** /infra/supabase data access over the metrics scraped from each Supabase project. */

export interface SupabaseProjectRow {
	projectRef: string
	/** CPU busy share, 0..1: the window's average and its busiest five minutes. */
	cpuAvg: number
	cpuMax: number
	/** Memory in use, 0..1, and the instance's total bytes. */
	memoryAvg: number
	memoryMax: number
	memoryTotal: number
	/** Data volume in use at its fullest, 0..1, and its size in bytes. */
	diskUsedMax: number
	diskSize: number
	/** Bytes across the non-template databases. */
	dbSize: number
	/** Postgres backends. */
	connectionsAvg: number
	connectionsMax: number
	/** PgBouncer client slots in use. */
	poolerClientsMax: number
	lastSeen: string
}

export interface SupabaseProjectTimeseriesRow {
	bucket: string
	cpu: number
	memoryAvg: number
	memoryMax: number
	memoryTotal: number
	diskUsed: number
	diskSize: number
	dbSize: number
	connectionsAvg: number
	connectionsMax: number
	poolerClients: number
	poolerWaiting: number
	commitsPerSecond: number
	rollbacksPerSecond: number
	cacheHitRatio: number
	cacheReads: number
	deadlocks: number
	authUsers: number
	authSamples: number
	realtimeSubscriptions: number
	postgrestPoolMax: number
	postgrestPoolInUse: number
	postgrestPoolWaiting: number
	networkRxPerSecond: number
	networkTxPerSecond: number
	diskReadPerSecond: number
	diskWritePerSecond: number
}

const TimeRangeInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

const TimeseriesInputSchema = Schema.Struct({
	...TimeRangeInputSchema.fields,
	projectRef: SupabaseProjectRef,
	bucketSeconds: Schema.Number,
})

export type SupabaseTimeRangeInput = (typeof TimeRangeInputSchema)["Encoded"]
export type SupabaseTimeseriesInput = (typeof TimeseriesInputSchema)["Encoded"]

const resolveRange = (input: { startTime?: string; endTime?: string }, nowMillis: number) => ({
	startTime: input.startTime ?? formatWarehouseDateTime(nowMillis - 6 * 60 * 60 * 1000),
	endTime: input.endTime ?? formatWarehouseDateTime(nowMillis),
})

const num = (value: unknown) => Number(value ?? 0)

export const getSupabaseProjects = Effect.fn("QueryEngine.getSupabaseProjects")(function* ({
	data,
}: {
	data: SupabaseTimeRangeInput
}) {
	const input = yield* decodeInput(TimeRangeInputSchema, data, "getSupabaseProjects")
	const range = resolveRange(input, yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("supabaseInfraProjects", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.supabaseInfraProjects({
				payload: new SupabaseInfraProjectsRequest(range),
			})
		}),
	)
	return {
		projects: result.data.map((row): SupabaseProjectRow => ({
			projectRef: String(row.projectRef ?? ""),
			cpuAvg: num(row.cpuAvg),
			cpuMax: num(row.cpuMax),
			memoryAvg: num(row.memoryAvg),
			memoryMax: num(row.memoryMax),
			memoryTotal: num(row.memoryTotal),
			diskUsedMax: num(row.diskUsedMax),
			diskSize: num(row.diskSize),
			dbSize: num(row.dbSize),
			connectionsAvg: num(row.connectionsAvg),
			connectionsMax: num(row.connectionsMax),
			poolerClientsMax: num(row.poolerClientsMax),
			lastSeen: String(row.lastSeen ?? ""),
		})),
	}
})

export const getSupabaseProjectTimeseries = Effect.fn("QueryEngine.getSupabaseProjectTimeseries")(function* ({
	data,
}: {
	data: SupabaseTimeseriesInput
}) {
	const input = yield* decodeInput(TimeseriesInputSchema, data, "getSupabaseProjectTimeseries")
	const range = resolveRange(input, yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("supabaseInfraProjectTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.supabaseInfraProjectTimeseries({
				payload: new SupabaseInfraProjectTimeseriesRequest({
					...range,
					bucketSeconds: input.bucketSeconds,
					projectRef: input.projectRef,
				}),
			})
		}),
	)
	return {
		buckets: result.data.map((row): SupabaseProjectTimeseriesRow => ({
			bucket: String(row.bucket ?? ""),
			cpu: num(row.cpu),
			memoryAvg: num(row.memoryAvg),
			memoryMax: num(row.memoryMax),
			memoryTotal: num(row.memoryTotal),
			diskUsed: num(row.diskUsed),
			diskSize: num(row.diskSize),
			dbSize: num(row.dbSize),
			connectionsAvg: num(row.connectionsAvg),
			connectionsMax: num(row.connectionsMax),
			poolerClients: num(row.poolerClients),
			poolerWaiting: num(row.poolerWaiting),
			commitsPerSecond: num(row.commitsPerSecond),
			rollbacksPerSecond: num(row.rollbacksPerSecond),
			cacheHitRatio: num(row.cacheHitRatio),
			cacheReads: num(row.cacheReads),
			deadlocks: num(row.deadlocks),
			authUsers: num(row.authUsers),
			authSamples: num(row.authSamples),
			realtimeSubscriptions: num(row.realtimeSubscriptions),
			postgrestPoolMax: num(row.postgrestPoolMax),
			postgrestPoolInUse: num(row.postgrestPoolInUse),
			postgrestPoolWaiting: num(row.postgrestPoolWaiting),
			networkRxPerSecond: num(row.networkRxPerSecond),
			networkTxPerSecond: num(row.networkTxPerSecond),
			diskReadPerSecond: num(row.diskReadPerSecond),
			diskWritePerSecond: num(row.diskWritePerSecond),
		})),
	}
})
