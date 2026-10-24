import { Effect, Schema } from "effect"
import {
	BucketSeconds,
	DeploymentEnvironment,
	ServiceApiOverviewRequest,
	ServiceEndpointDetailRequest,
	ServiceEndpointStatusBreakdownRequest,
	ServiceEndpointsRequest,
	ServiceEndpointsTimeseriesRequest,
	ServiceName,
	SpanName,
} from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

export interface ServiceEndpoint {
	/** Normalized name ("GET /api/users") — valid as a /traces `spanNames` filter. */
	spanName: string
	method: string
	route: string
	spanCount: number
	estimatedSpanCount: number
	errorCount: number
	estimatedErrorCount: number
	/** 0–1 ratio, sampling-weighted. ×100 only at display. */
	errorRate: number
	avgDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
	p99DurationMs: number
	/**
	 * Migration 0048, Server spans only. Below `spanCount` part of the window predates
	 * 0048, where the status mix is unknown rather than clean.
	 */
	httpClassifiedSpanCount: number
	/** Spans with an HTTP response status: the status mix denominator. */
	httpStatusCount: number
	http4xxCount: number
	http5xxCount: number
	requestBodyBytes: number
	/** Requests that carried a body size; `requestBodyBytes / requestBodyCount` is the mean. */
	requestBodyCount: number
}

const GetServiceEndpointsInput = Schema.Struct({
	serviceName: ServiceName,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
	limit: Schema.optional(Schema.Number),
})

export type GetServiceEndpointsInput = (typeof GetServiceEndpointsInput)["Encoded"]

export const getServiceEndpoints = Effect.fn("QueryEngine.getServiceEndpoints")(function* ({
	data,
}: {
	data: GetServiceEndpointsInput
}) {
	const input = yield* decodeInput(GetServiceEndpointsInput, data, "getServiceEndpoints")

	const result = yield* runWarehouseQuery("serviceEndpoints", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.serviceEndpoints({
				payload: new ServiceEndpointsRequest({
					serviceName: input.serviceName,
					startTime: input.startTime,
					endTime: input.endTime,
					environments: input.environments,
					limit: input.limit,
				}),
			})
		}),
	)

	const endpoints: ServiceEndpoint[] = result.data.map((row) => ({
		spanName: row.spanName,
		method: row.method,
		route: row.route,
		spanCount: row.spanCount,
		estimatedSpanCount: row.estimatedSpanCount,
		errorCount: row.errorCount,
		estimatedErrorCount: row.estimatedErrorCount,
		errorRate: row.errorRate,
		avgDurationMs: row.avgDurationMs,
		p50DurationMs: row.p50DurationMs,
		p95DurationMs: row.p95DurationMs,
		p99DurationMs: row.p99DurationMs,
		httpClassifiedSpanCount: row.httpClassifiedSpanCount,
		httpStatusCount: row.httpStatusCount,
		http4xxCount: row.http4xxCount,
		http5xxCount: row.http5xxCount,
		requestBodyBytes: row.requestBodyBytes,
		requestBodyCount: row.requestBodyCount,
	}))

	return { endpoints }
})

/** Every HTTP endpoint of one service merged. Same measures as {@link ServiceEndpoint}. */
export interface ServiceApiTotals {
	spanCount: number
	estimatedSpanCount: number
	httpClassifiedSpanCount: number
	httpStatusCount: number
	http4xxCount: number
	http5xxCount: number
	requestBodyBytes: number
	requestBodyCount: number
	p50DurationMs: number
	p95DurationMs: number
	p99DurationMs: number
}

/** One bucket; `spanName` is `''` for the series merged across endpoints. */
export interface ServiceApiBucket {
	/** ISO 8601 UTC bucket start. */
	bucket: string
	spanName: string
	estimatedSpanCount: number
	/** 0 when the bucket predates the status counters: its status mix is unknown. */
	httpClassifiedSpanCount: number
	httpStatusCount: number
	http4xxCount: number
	http5xxCount: number
	requestBodyBytes: number
	p50DurationMs: number
	p95DurationMs: number
	p99DurationMs: number
}

const toTotals = (totals: ServiceApiTotals): ServiceApiTotals => ({ ...totals })
const toBucket = (bucket: ServiceApiBucket): ServiceApiBucket => ({ ...bucket })

const GetServiceApiOverviewInput = Schema.Struct({
	serviceName: ServiceName,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	previousStartTime: Schema.optional(WarehouseDateTimeString),
	previousEndTime: Schema.optional(WarehouseDateTimeString),
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
	bucketSeconds: BucketSeconds,
})

export type GetServiceApiOverviewInput = (typeof GetServiceApiOverviewInput)["Encoded"]

/** Totals (and the comparison window's, when both previous bounds are given) plus the merged series. */
export const getServiceApiOverview = Effect.fn("QueryEngine.getServiceApiOverview")(function* ({
	data,
}: {
	data: GetServiceApiOverviewInput
}) {
	const input = yield* decodeInput(GetServiceApiOverviewInput, data, "getServiceApiOverview")
	const result = yield* runWarehouseQuery("serviceApiOverview", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.serviceApiOverview({
				payload: new ServiceApiOverviewRequest({
					serviceName: input.serviceName,
					startTime: input.startTime,
					endTime: input.endTime,
					previousStartTime: input.previousStartTime,
					previousEndTime: input.previousEndTime,
					environments: input.environments,
					bucketSeconds: input.bucketSeconds,
				}),
			})
		}),
	)
	return {
		totals: toTotals(result.totals),
		previous: result.previous === null ? null : toTotals(result.previous),
		buckets: result.buckets.map(toBucket),
	}
})

const GetServiceEndpointsTimeseriesInput = Schema.Struct({
	serviceName: ServiceName,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
	bucketSeconds: BucketSeconds,
	spanNames: Schema.Array(SpanName).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
})

export type GetServiceEndpointsTimeseriesInput = (typeof GetServiceEndpointsTimeseriesInput)["Encoded"]

/** One series per named endpoint (up to 50), `spanName` set on every bucket. */
export const getServiceEndpointsTimeseries = Effect.fn("QueryEngine.getServiceEndpointsTimeseries")(
	function* ({ data }: { data: GetServiceEndpointsTimeseriesInput }) {
		const input = yield* decodeInput(
			GetServiceEndpointsTimeseriesInput,
			data,
			"getServiceEndpointsTimeseries",
		)
		const result = yield* runWarehouseQuery("serviceEndpointsTimeseries", () =>
			Effect.gen(function* () {
				const client = yield* MapleInternalHttp
				return yield* client.queryEngine.serviceEndpointsTimeseries({
					payload: new ServiceEndpointsTimeseriesRequest({
						serviceName: input.serviceName,
						startTime: input.startTime,
						endTime: input.endTime,
						environments: input.environments,
						bucketSeconds: input.bucketSeconds,
						spanNames: input.spanNames,
					}),
				})
			}),
		)
		return { buckets: result.buckets.map(toBucket) }
	},
)

export interface ServiceEndpointStatusRow {
	spanName: string
	httpStatusCode: string
	/** `error.type`, `''` when the span carried none. */
	errorType: string
	spanCount: number
	estimatedSpanCount: number
}

const GetServiceEndpointStatusBreakdownInput = Schema.Struct({
	serviceName: ServiceName,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
	spanName: Schema.optional(SpanName),
})

export type GetServiceEndpointStatusBreakdownInput =
	(typeof GetServiceEndpointStatusBreakdownInput)["Encoded"]

/**
 * Status code x `error.type` counts per endpoint, highest first. Hour-grain: both
 * window ends are floored to the hour.
 */
export const getServiceEndpointStatusBreakdown = Effect.fn("QueryEngine.getServiceEndpointStatusBreakdown")(
	function* ({ data }: { data: GetServiceEndpointStatusBreakdownInput }) {
		const input = yield* decodeInput(
			GetServiceEndpointStatusBreakdownInput,
			data,
			"getServiceEndpointStatusBreakdown",
		)
		const result = yield* runWarehouseQuery("serviceEndpointStatusBreakdown", () =>
			Effect.gen(function* () {
				const client = yield* MapleInternalHttp
				return yield* client.queryEngine.serviceEndpointStatusBreakdown({
					payload: new ServiceEndpointStatusBreakdownRequest({
						serviceName: input.serviceName,
						startTime: input.startTime,
						endTime: input.endTime,
						environments: input.environments,
						spanName: input.spanName,
					}),
				})
			}),
		)
		const rows: ServiceEndpointStatusRow[] = result.rows.map((row) => ({ ...row }))
		return { rows }
	},
)

export interface ServiceEndpointDetail {
	/** The quantile levels `latencyQuantilesMs` is reported at, in order. */
	latencyQuantileLevels: number[]
	/** One value per level; empty when the window holds no request. */
	latencyQuantilesMs: number[]
	/** Null when no request carried a body size. */
	body: { p50Bytes: number; p95Bytes: number; maxBytes: number; count: number } | null
	/** Top user agents, most frequent first; `count` is approximate (approx_top_k). */
	userAgents: Array<{ value: string; count: number | null }>
	/** Slowest requests, at most one per hour and status code, slowest first. */
	slowest: Array<{
		traceId: string
		/** ISO 8601 UTC, millisecond precision. */
		timestamp: string
		durationMs: number
		httpStatusCode: string
		bodyBytes: number | null
	}>
}

const GetServiceEndpointDetailInput = Schema.Struct({
	serviceName: ServiceName,
	spanName: SpanName,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
})

export type GetServiceEndpointDetailInput = (typeof GetServiceEndpointDetailInput)["Encoded"]

/** One endpoint's latency and body distributions, user agents and slowest requests (hour-grain). */
export const getServiceEndpointDetail = Effect.fn("QueryEngine.getServiceEndpointDetail")(function* ({
	data,
}: {
	data: GetServiceEndpointDetailInput
}) {
	const input = yield* decodeInput(GetServiceEndpointDetailInput, data, "getServiceEndpointDetail")
	const result = yield* runWarehouseQuery("serviceEndpointDetail", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.serviceEndpointDetail({
				payload: new ServiceEndpointDetailRequest({
					serviceName: input.serviceName,
					spanName: input.spanName,
					startTime: input.startTime,
					endTime: input.endTime,
					environments: input.environments,
				}),
			})
		}),
	)
	const detail: ServiceEndpointDetail = {
		latencyQuantileLevels: [...result.latencyQuantileLevels],
		latencyQuantilesMs: [...result.latencyQuantilesMs],
		body: result.body === null ? null : { ...result.body },
		userAgents: result.userAgents.map((agent) => ({ ...agent })),
		slowest: result.slowest.map((request) => ({ ...request })),
	}
	return detail
})
