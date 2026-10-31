import { Effect, Schema } from "effect"
import {
	ServiceName,
	ServiceRuntimesRequest,
	type ServiceRuntimeRow,
	ServiceWorkloadsRequest,
} from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

type ServiceWorkloadKind = "deployment" | "statefulset" | "daemonset" | "unknown"

export interface ServiceWorkload {
	serviceName: string
	workloadKind: ServiceWorkloadKind
	workloadName: string
	namespace: string
	clusterName: string
	podCount: number
	avgCpuLimitUtilization: number | null
	avgMemoryLimitUtilization: number | null
}

interface ServiceWorkloadsResult {
	workloads: ServiceWorkload[]
}

const GetServiceWorkloadsInputSchema = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	services: Schema.Array(ServiceName),
})

export type GetServiceWorkloadsInput = (typeof GetServiceWorkloadsInputSchema)["Encoded"]

export const getServiceWorkloads = Effect.fn("QueryEngine.getServiceWorkloads")(function* ({
	data,
}: {
	data: GetServiceWorkloadsInput
}) {
	const input = yield* decodeInput(GetServiceWorkloadsInputSchema, data, "getServiceWorkloads")

	if (input.services.length === 0) {
		return { workloads: [] } satisfies ServiceWorkloadsResult
	}

	const result = yield* runWarehouseQuery("serviceWorkloads", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.serviceWorkloads({
				payload: new ServiceWorkloadsRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					services: input.services,
				}),
			})
		}),
	)

	return {
		workloads: result.data.map((row) => ({
			serviceName: row.serviceName,
			workloadKind: row.workloadKind,
			workloadName: row.workloadName,
			namespace: row.namespace,
			clusterName: row.clusterName,
			podCount: row.podCount,
			avgCpuLimitUtilization: row.avgCpuLimitUtilization,
			avgMemoryLimitUtilization: row.avgMemoryLimitUtilization,
		})),
	} satisfies ServiceWorkloadsResult
})

/** A platform resource a traced service runs as: see `@maple/domain/service-runtimes`. */
export type ServiceRuntime = ServiceRuntimeRow

export const getServiceRuntimes = Effect.fn("QueryEngine.getServiceRuntimes")(function* ({
	data,
}: {
	data: GetServiceWorkloadsInput
}) {
	const input = yield* decodeInput(GetServiceWorkloadsInputSchema, data, "getServiceRuntimes")
	if (input.services.length === 0) return { runtimes: [] }

	const result = yield* runWarehouseQuery("serviceRuntimes", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.serviceRuntimes({
				payload: new ServiceRuntimesRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					services: input.services,
				}),
			})
		}),
	)
	return { runtimes: result.data }
})
