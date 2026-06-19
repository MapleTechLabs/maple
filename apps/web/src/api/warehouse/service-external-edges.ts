import { Clock, Effect, Schema } from "effect"
import { DeploymentEnvironment, ServiceExternalEdgesRequest, ServiceName } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { summarizeSampling } from "@/lib/sampling"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

type ServiceExternalTargetType = "http" | "messaging" | "rpc"

export interface ServiceExternalEdge {
	sourceService: string
	targetType: ServiceExternalTargetType
	targetSystem: string
	targetName: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

const GetServiceExternalEdgesInputSchema = Schema.Struct({
	serviceName: ServiceName,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
})

export type GetServiceExternalEdgesInput = (typeof GetServiceExternalEdgesInputSchema)["Encoded"]

const defaultTimeRange = (nowMillis: number) => {
	const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(nowMillis - 24 * 60 * 60 * 1000), endTime: fmt(nowMillis) }
}

const knownTargetTypes: ReadonlySet<ServiceExternalTargetType> = new Set(["http", "messaging", "rpc"])

function coerceTargetType(value: unknown): ServiceExternalTargetType {
	return knownTargetTypes.has(value as ServiceExternalTargetType)
		? (value as ServiceExternalTargetType)
		: "http"
}

function transformEdge(row: Record<string, unknown>, durationSeconds: number): ServiceExternalEdge {
	const callCount = Number(row.callCount ?? 0)
	const errorCount = Number(row.errorCount ?? 0)
	const estimatedSpanCount = Number(row.estimatedSpanCount ?? 0)
	const sampling = summarizeSampling(estimatedSpanCount, callCount, durationSeconds)
	const estimatedCallCount = sampling.hasSampling ? Math.round(estimatedSpanCount) : callCount
	return {
		sourceService: String(row.sourceService ?? ""),
		targetType: coerceTargetType(row.targetType),
		targetSystem: String(row.targetSystem ?? ""),
		targetName: String(row.targetName ?? ""),
		callCount,
		estimatedCallCount,
		errorCount,
		errorRate: callCount > 0 ? errorCount / callCount : 0,
		avgDurationMs: Number(row.avgDurationMs ?? 0),
		p95DurationMs: Number(row.p95DurationMs ?? 0),
		hasSampling: sampling.hasSampling,
		samplingWeight: sampling.weight,
	}
}

export const getServiceExternalEdges = Effect.fn("QueryEngine.getServiceExternalEdges")(function* ({
	data,
}: {
	data: GetServiceExternalEdgesInput
}) {
	const input = yield* decodeInput(
		GetServiceExternalEdgesInputSchema,
		data ?? {},
		"getServiceExternalEdges",
	)
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceExternalEdges", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceExternalEdges({
				payload: new ServiceExternalEdgesRequest({
					serviceName: input.serviceName,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					deploymentEnv: input.deploymentEnv,
				}),
			})
		}),
	)

	const startMs = input.startTime ? new Date(input.startTime.replace(" ", "T") + "Z").getTime() : 0
	const endMs = input.endTime ? new Date(input.endTime.replace(" ", "T") + "Z").getTime() : 0
	const durationSeconds = startMs > 0 && endMs > 0 ? Math.max((endMs - startMs) / 1000, 1) : 3600

	return {
		edges: result.data.map((row) => transformEdge(row, durationSeconds)),
	}
})
