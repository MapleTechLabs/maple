import { Clock, Effect, Schema } from "effect"
import { RailwayInfraServicesRequest, RailwayInfraServiceTimeseriesRequest } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

/** /infra/railway data access over the `railway.*` gauges the Railway poller ingests. */

export interface RailwayServiceRow {
	environmentId: string
	serviceId: string
	serviceName: string
	projectName: string
	environmentName: string
	/** vCPU, summed across replicas. */
	cpuAvg: number
	cpuMax: number
	cpuLimit: number
	/** Bytes, summed across replicas. */
	memoryAvg: number
	memoryMax: number
	memoryLimit: number
	replicas: number
	lastSeen: string
}

export interface RailwayServiceTimeseriesRow {
	bucket: string
	cpuAvg: number
	cpuMax: number
	cpuLimit: number
	memoryAvg: number
	memoryMax: number
	memoryLimit: number
	networkRx: number
	networkTx: number
	diskVolume: number
	diskEphemeral: number
	replicas: number
}

const TimeRangeInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

const TimeseriesInputSchema = Schema.Struct({
	...TimeRangeInputSchema.fields,
	environmentId: Schema.String,
	serviceId: Schema.String,
	bucketSeconds: Schema.Number,
})

export type RailwayTimeRangeInput = (typeof TimeRangeInputSchema)["Encoded"]
export type RailwayTimeseriesInput = (typeof TimeseriesInputSchema)["Encoded"]

const resolveRange = (input: { startTime?: string; endTime?: string }, nowMillis: number) => ({
	startTime: input.startTime ?? formatWarehouseDateTime(nowMillis - 6 * 60 * 60 * 1000),
	endTime: input.endTime ?? formatWarehouseDateTime(nowMillis),
})

const num = (value: unknown) => Number(value ?? 0)

export const getRailwayServices = Effect.fn("QueryEngine.getRailwayServices")(function* ({
	data,
}: {
	data: RailwayTimeRangeInput
}) {
	const input = yield* decodeInput(TimeRangeInputSchema, data, "getRailwayServices")
	const range = resolveRange(input, yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("railwayInfraServices", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.railwayInfraServices({
				payload: new RailwayInfraServicesRequest(range),
			})
		}),
	)
	return {
		services: result.data.map((row): RailwayServiceRow => ({
			environmentId: String(row.environmentId ?? ""),
			serviceId: String(row.serviceId ?? ""),
			serviceName: String(row.serviceName ?? ""),
			projectName: String(row.projectName ?? ""),
			environmentName: String(row.environmentName ?? ""),
			cpuAvg: num(row.cpuAvg),
			cpuMax: num(row.cpuMax),
			cpuLimit: num(row.cpuLimit),
			memoryAvg: num(row.memoryAvg),
			memoryMax: num(row.memoryMax),
			memoryLimit: num(row.memoryLimit),
			replicas: num(row.replicas),
			lastSeen: String(row.lastSeen ?? ""),
		})),
	}
})

export const getRailwayServiceTimeseries = Effect.fn("QueryEngine.getRailwayServiceTimeseries")(function* ({
	data,
}: {
	data: RailwayTimeseriesInput
}) {
	const input = yield* decodeInput(TimeseriesInputSchema, data, "getRailwayServiceTimeseries")
	const range = resolveRange(input, yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("railwayInfraServiceTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.railwayInfraServiceTimeseries({
				payload: new RailwayInfraServiceTimeseriesRequest({
					...range,
					bucketSeconds: input.bucketSeconds,
					environmentId: input.environmentId,
					serviceId: input.serviceId,
				}),
			})
		}),
	)
	return {
		buckets: result.data.map((row): RailwayServiceTimeseriesRow => ({
			bucket: String(row.bucket ?? ""),
			cpuAvg: num(row.cpuAvg),
			cpuMax: num(row.cpuMax),
			cpuLimit: num(row.cpuLimit),
			memoryAvg: num(row.memoryAvg),
			memoryMax: num(row.memoryMax),
			memoryLimit: num(row.memoryLimit),
			networkRx: num(row.networkRx),
			networkTx: num(row.networkTx),
			diskVolume: num(row.diskVolume),
			diskEphemeral: num(row.diskEphemeral),
			replicas: num(row.replicas),
		})),
	}
})
