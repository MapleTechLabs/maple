import { Clock, Effect, Schema } from "effect"
import { SupabaseInfraProjectsRequest, SupabaseInfraProjectTimeseriesRequest } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { MapleInternalHttp } from "./warehouse-services"
import {
	InfraWindowInput,
	decodeInput,
	resolveInfraWindow,
	runWarehouseQuery,
	wireNumber,
	wireNumberOrNull,
} from "./effect-utils"

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
	/** Postgres' `max_connections`; null when the project never reported it. */
	maxConnections: number | null
	/** Edge (API gateway) requests from the polled logs; 0 when logs are off. */
	requests: number
	requestsPerMinute: number
	errors5xx: number
	/** WARN-or-worse log records of any source. */
	issueCount: number
	/** Latest scrape, or latest log record for a project with logs only. */
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
	/** Postgres' `max_connections`; null for a bucket without the sample. */
	maxConnections: number | null
	poolerClients: number
	commitsPerSecond: number
	rollbacksPerSecond: number
	/** Null for a bucket with no block reads. */
	cacheHitRatio: number | null
	authUsers: number
	authSamples: number
	postgrestPoolMax: number
	postgrestPoolInUse: number
	postgrestPoolWaiting: number
	networkRxPerSecond: number
	networkTxPerSecond: number
	diskReadPerSecond: number
	diskWritePerSecond: number
}

/** The warehouse reads an unreported limit as 0: no limit is known, not a limit of zero. */
const positiveOrNull = (value: unknown): number | null => {
	const number = wireNumber(value)
	return number > 0 ? number : null
}

const TimeseriesInputSchema = Schema.Struct({
	...InfraWindowInput.fields,
	projectRef: SupabaseProjectRef,
	bucketSeconds: Schema.Number,
})

export type SupabaseTimeRangeInput = (typeof InfraWindowInput)["Encoded"]
export type SupabaseTimeseriesInput = (typeof TimeseriesInputSchema)["Encoded"]

export const getSupabaseProjects = Effect.fn("QueryEngine.getSupabaseProjects")(function* ({
	data,
}: {
	data: SupabaseTimeRangeInput
}) {
	const input = yield* decodeInput(InfraWindowInput, data, "getSupabaseProjects")
	const range = resolveInfraWindow(input, yield* Clock.currentTimeMillis)
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
			cpuAvg: wireNumber(row.cpuAvg),
			cpuMax: wireNumber(row.cpuMax),
			memoryAvg: wireNumber(row.memoryAvg),
			memoryMax: wireNumber(row.memoryMax),
			memoryTotal: wireNumber(row.memoryTotal),
			diskUsedMax: wireNumber(row.diskUsedMax),
			diskSize: wireNumber(row.diskSize),
			dbSize: wireNumber(row.dbSize),
			connectionsAvg: wireNumber(row.connectionsAvg),
			connectionsMax: wireNumber(row.connectionsMax),
			maxConnections: positiveOrNull(row.maxConnections),
			requests: wireNumber(row.requests),
			requestsPerMinute: wireNumber(row.requestsPerMinute),
			errors5xx: wireNumber(row.errors5xx),
			issueCount: wireNumber(row.issueCount),
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
	const range = resolveInfraWindow(input, yield* Clock.currentTimeMillis)
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
			cpu: wireNumber(row.cpu),
			memoryAvg: wireNumber(row.memoryAvg),
			memoryMax: wireNumber(row.memoryMax),
			memoryTotal: wireNumber(row.memoryTotal),
			diskUsed: wireNumber(row.diskUsed),
			diskSize: wireNumber(row.diskSize),
			dbSize: wireNumber(row.dbSize),
			connectionsAvg: wireNumber(row.connectionsAvg),
			connectionsMax: wireNumber(row.connectionsMax),
			maxConnections: positiveOrNull(row.maxConnections),
			poolerClients: wireNumber(row.poolerClients),
			commitsPerSecond: wireNumber(row.commitsPerSecond),
			rollbacksPerSecond: wireNumber(row.rollbacksPerSecond),
			cacheHitRatio: wireNumberOrNull(row.cacheHitRatio),
			authUsers: wireNumber(row.authUsers),
			authSamples: wireNumber(row.authSamples),
			postgrestPoolMax: wireNumber(row.postgrestPoolMax),
			postgrestPoolInUse: wireNumber(row.postgrestPoolInUse),
			postgrestPoolWaiting: wireNumber(row.postgrestPoolWaiting),
			networkRxPerSecond: wireNumber(row.networkRxPerSecond),
			networkTxPerSecond: wireNumber(row.networkTxPerSecond),
			diskReadPerSecond: wireNumber(row.diskReadPerSecond),
			diskWritePerSecond: wireNumber(row.diskWritePerSecond),
		})),
	}
})
