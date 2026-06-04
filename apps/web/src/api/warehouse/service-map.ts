import { Clock, Effect, Schema } from "effect"
import {
	ServiceDbEdgesForServiceRequest,
	ServiceDbEdgesRequest,
	ServiceDbQuerySummaryRequest,
	ServiceDependenciesForServiceRequest,
	ServiceDependenciesRequest,
	ServicePlatformsRequest,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { summarizeSampling } from "@/lib/sampling"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

export interface ServiceEdge {
	sourceService: string
	targetService: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

export interface ServiceMapResponse {
	edges: ServiceEdge[]
}

export interface ServiceDbEdge {
	sourceService: string
	dbSystem: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

export interface ServiceDbEdgesResponse {
	edges: ServiceDbEdge[]
}

export interface ServiceDbQuerySummary {
	queryCount: number
	estimatedQueryCount: number
	errorCount: number
	estimatedErrorCount: number
	errorRate: number
	avgDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
	activeServiceCount: number
}

export interface ServiceDbQueryTimeseriesPoint {
	bucket: string
	queryCount: number
	estimatedQueryCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
}

export interface ServiceDbTopQuery {
	queryKey: string
	queryLabel: string
	sampleStatement: string
	sampleService: string
	serviceCount: number
	queryCount: number
	estimatedQueryCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
	lastSeen: string
}

export interface ServiceDbQuerySummaryResponse {
	summary: ServiceDbQuerySummary | null
	timeseries: ReadonlyArray<ServiceDbQueryTimeseriesPoint>
	topQueries: ReadonlyArray<ServiceDbTopQuery>
}

export type ServicePlatform = "kubernetes" | "cloudflare" | "lambda" | "web" | "unknown"

export interface ServicePlatformInfo {
	serviceName: string
	platform: ServicePlatform
	k8sCluster: string
	cloudPlatform: string
	cloudProvider: string
	faasName: string
	mapleSdkType: string
	runtime: string
}

export interface ServicePlatformsResponse {
	platforms: ServicePlatformInfo[]
}

const GetServiceMapInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	deploymentEnv: Schema.optional(Schema.String),
})

export type GetServiceMapInput = Schema.Schema.Type<typeof GetServiceMapInputSchema>

const GetServiceMapForServiceInputSchema = Schema.Struct({
	serviceName: Schema.String,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	deploymentEnv: Schema.optional(Schema.String),
})

export type GetServiceMapForServiceInput = Schema.Schema.Type<typeof GetServiceMapForServiceInputSchema>

const GetServiceDbQuerySummaryInputSchema = Schema.Struct({
	dbSystem: Schema.String,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	sourceService: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(Schema.String),
	bucketSeconds: Schema.optional(Schema.Number),
	topN: Schema.optional(Schema.Number),
})

export type GetServiceDbQuerySummaryInput = Schema.Schema.Type<
	typeof GetServiceDbQuerySummaryInputSchema
>

function transformEdge(row: Record<string, unknown>, durationSeconds: number): ServiceEdge {
	const callCount = Number(row.callCount ?? 0)
	const errorCount = Number(row.errorCount ?? 0)
	const estimatedSpanCount = Number(row.estimatedSpanCount ?? 0)
	const sampling = summarizeSampling(estimatedSpanCount, callCount, durationSeconds)
	const estimatedCallCount = sampling.hasSampling ? Math.round(estimatedSpanCount) : callCount
	return {
		sourceService: String(row.sourceService ?? ""),
		targetService: String(row.targetService ?? ""),
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

const defaultTimeRange = (nowMillis: number) => {
	const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(nowMillis - 24 * 60 * 60 * 1000), endTime: fmt(nowMillis) }
}

export const getServiceMap = Effect.fn("QueryEngine.getServiceMap")(function* ({
	data,
}: {
	data: GetServiceMapInput
}) {
	const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServiceMap")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceDependencies", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDependencies({
				payload: new ServiceDependenciesRequest({
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

// Service-scoped variant used by the service-detail page's Dependencies tab.
// Hits a different API endpoint that pushes `SourceService = ?` into both
// branches of the underlying SQL (hourly MV + live topology JOIN), so the
// returned set is already trimmed to this service's outbound edges — no
// client-side filter needed.
export const getServiceMapForService = Effect.fn("QueryEngine.getServiceMapForService")(function* ({
	data,
}: {
	data: GetServiceMapForServiceInput
}) {
	const input = yield* decodeInput(
		GetServiceMapForServiceInputSchema,
		data,
		"getServiceMapForService",
	)
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceDependenciesForService", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDependenciesForService({
				payload: new ServiceDependenciesForServiceRequest({
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

function transformDbEdge(row: Record<string, unknown>, durationSeconds: number): ServiceDbEdge {
	const callCount = Number(row.callCount ?? 0)
	const errorCount = Number(row.errorCount ?? 0)
	const estimatedSpanCount = Number(row.estimatedSpanCount ?? 0)
	const sampling = summarizeSampling(estimatedSpanCount, callCount, durationSeconds)
	const estimatedCallCount = sampling.hasSampling ? Math.round(estimatedSpanCount) : callCount
	return {
		sourceService: String(row.sourceService ?? ""),
		dbSystem: String(row.dbSystem ?? ""),
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

export const getServiceMapDbEdges = Effect.fn("QueryEngine.getServiceMapDbEdges")(function* ({
	data,
}: {
	data: GetServiceMapInput
}) {
	const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServiceMapDbEdges")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceDbEdges", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDbEdges({
				payload: new ServiceDbEdgesRequest({
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
		edges: result.data.map((row) => transformDbEdge(row, durationSeconds)),
	}
})

// Service-scoped variant: pre-filters by `ServiceName = ?` server-side so the
// raw-traces fallback branch only scans this service's Client/Producer spans
// in the in-progress hour, not every span in the org.
export const getServiceMapDbEdgesForService = Effect.fn("QueryEngine.getServiceMapDbEdgesForService")(
	function* ({ data }: { data: GetServiceMapForServiceInput }) {
		const input = yield* decodeInput(
			GetServiceMapForServiceInputSchema,
			data,
			"getServiceMapDbEdgesForService",
		)
		const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

		const result = yield* runWarehouseQuery("serviceDbEdgesForService", () =>
			Effect.gen(function* () {
				const client = yield* MapleApiAtomClient
				return yield* client.queryEngine.serviceDbEdgesForService({
					payload: new ServiceDbEdgesForServiceRequest({
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
			edges: result.data.map((row) => transformDbEdge(row, durationSeconds)),
		}
	},
)

export const getServiceDbQuerySummary = Effect.fn("QueryEngine.getServiceDbQuerySummary")(function* ({
	data,
}: {
	data: GetServiceDbQuerySummaryInput
}) {
	const input = yield* decodeInput(
		GetServiceDbQuerySummaryInputSchema,
		data,
		"getServiceDbQuerySummary",
	)
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceDbQuerySummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDbQuerySummary({
				payload: new ServiceDbQuerySummaryRequest({
					dbSystem: input.dbSystem,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					sourceService: input.sourceService,
					deploymentEnv: input.deploymentEnv,
					bucketSeconds: input.bucketSeconds,
					topN: input.topN,
				}),
			})
		}),
	)

	return {
		summary: result.summary,
		timeseries: result.timeseries,
		topQueries: result.topQueries,
	} satisfies ServiceDbQuerySummaryResponse
})

export const getServicePlatforms = Effect.fn("QueryEngine.getServicePlatforms")(function* ({
	data,
}: {
	data: GetServiceMapInput
}) {
	const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServicePlatforms")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("servicePlatforms", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.servicePlatforms({
				payload: new ServicePlatformsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					deploymentEnv: input.deploymentEnv,
				}),
			})
		}),
	)

	return {
		platforms: result.data.map((row) => ({
			serviceName: row.serviceName,
			platform: row.platform,
			k8sCluster: row.k8sCluster,
			cloudPlatform: row.cloudPlatform,
			cloudProvider: row.cloudProvider,
			faasName: row.faasName,
			mapleSdkType: row.mapleSdkType,
			runtime: row.processRuntimeName,
		})),
	}
})
