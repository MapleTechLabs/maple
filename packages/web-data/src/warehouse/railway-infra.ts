import { Clock, Effect, Schema } from "effect"
import { RailwayInfraServicesRequest, RailwayInfraServiceTimeseriesRequest } from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import {
	InfraWindowInput,
	decodeInput,
	resolveInfraWindow,
	runWarehouseQuery,
	wireNumber,
} from "./effect-utils"

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

const TimeseriesInputSchema = Schema.Struct({
	...InfraWindowInput.fields,
	environmentId: Schema.String,
	serviceId: Schema.String,
	bucketSeconds: Schema.Number,
})

export type RailwayTimeRangeInput = (typeof InfraWindowInput)["Encoded"]
export type RailwayTimeseriesInput = (typeof TimeseriesInputSchema)["Encoded"]

export const getRailwayServices = Effect.fn("QueryEngine.getRailwayServices")(function* ({
	data,
}: {
	data: RailwayTimeRangeInput
}) {
	const input = yield* decodeInput(InfraWindowInput, data, "getRailwayServices")
	const range = resolveInfraWindow(input, yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("railwayInfraServices", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
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
			cpuAvg: wireNumber(row.cpuAvg),
			cpuMax: wireNumber(row.cpuMax),
			cpuLimit: wireNumber(row.cpuLimit),
			memoryAvg: wireNumber(row.memoryAvg),
			memoryMax: wireNumber(row.memoryMax),
			memoryLimit: wireNumber(row.memoryLimit),
			replicas: wireNumber(row.replicas),
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
	const range = resolveInfraWindow(input, yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("railwayInfraServiceTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
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
			cpuAvg: wireNumber(row.cpuAvg),
			cpuMax: wireNumber(row.cpuMax),
			cpuLimit: wireNumber(row.cpuLimit),
			memoryAvg: wireNumber(row.memoryAvg),
			memoryMax: wireNumber(row.memoryMax),
			memoryLimit: wireNumber(row.memoryLimit),
			networkRx: wireNumber(row.networkRx),
			networkTx: wireNumber(row.networkTx),
			diskVolume: wireNumber(row.diskVolume),
			diskEphemeral: wireNumber(row.diskEphemeral),
			replicas: wireNumber(row.replicas),
		})),
	}
})
