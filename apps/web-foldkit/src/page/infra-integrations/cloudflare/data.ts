import { CloudflareIntegrationStatus, CloudflareUsageResponse } from "@maple/domain/http"
import {
	getCloudflarePlatformResources,
	getCloudflareWorkers,
	getCloudflareZones,
	getCloudflareZoneTimeseries,
} from "@maple/web-data/warehouse/cloudflare-infra"
import { Effect, Schema } from "effect"
import { IntegrationStatuses } from "../../../data/integration-statuses"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"

// Row schemas and loaders shared by the Cloudflare pages: `@maple/web-data/warehouse/cloudflare-infra`.

export const Status = CloudflareIntegrationStatus
export type Status = CloudflareIntegrationStatus
export const Usage = CloudflareUsageResponse
export type Usage = CloudflareUsageResponse

export const ZoneRow = Schema.Struct({
	serviceName: Schema.String,
	zoneName: Schema.String,
	requests: Schema.Number,
	errors5xx: Schema.Number,
	errorRate: Schema.Number,
	errors4xx: Schema.Number,
	clientErrorRate: Schema.Number,
	requests2xx: Schema.Number,
	requests3xx: Schema.Number,
	cacheHits: Schema.Number,
	cacheableRequests: Schema.Number,
	cacheHitRate: Schema.NullOr(Schema.Number),
	bytes: Schema.Number,
	visits: Schema.Number,
	ttfbP50Ms: Schema.Number,
	ttfbP95Ms: Schema.Number,
	ttfbP99Ms: Schema.Number,
	originP50Ms: Schema.Number,
	originP95Ms: Schema.Number,
	originP99Ms: Schema.Number,
})
export type ZoneRow = typeof ZoneRow.Type

export const ZoneBucket = Schema.Struct({
	serviceName: Schema.String,
	zoneName: Schema.String,
	bucket: Schema.String,
	requests: Schema.Number,
	errors5xx: Schema.Number,
	cacheHits: Schema.Number,
	bytes: Schema.Number,
	visits: Schema.Number,
})
export type ZoneBucket = typeof ZoneBucket.Type

export const WorkerRow = Schema.Struct({
	serviceName: Schema.String,
	accountId: Schema.String,
	scriptName: Schema.String,
	requests: Schema.Number,
	errors: Schema.Number,
	errorRate: Schema.Number,
	subrequests: Schema.Number,
	cpuP50Ms: Schema.Number,
	cpuP99Ms: Schema.Number,
	durationP50Ms: Schema.Number,
	durationP99Ms: Schema.Number,
})
export type WorkerRow = typeof WorkerRow.Type

export const QueueRow = Schema.Struct({
	serviceName: Schema.String,
	accountId: Schema.String,
	queueName: Schema.String,
	backlogMessages: Schema.Number,
	backlogMessagesMax: Schema.Number,
	backlogBytes: Schema.Number,
	consumerConcurrency: Schema.Number,
})
export type QueueRow = typeof QueueRow.Type

export const DurableObjectRow = Schema.Struct({
	serviceName: Schema.String,
	accountId: Schema.String,
	scriptName: Schema.String,
	requests: Schema.Number,
	errors: Schema.Number,
	errorRate: Schema.Number,
})
export type DurableObjectRow = typeof DurableObjectRow.Type

export const PlatformResources = Schema.Struct({
	queues: Schema.Array(QueueRow),
	durableObjects: Schema.Array(DurableObjectRow),
})
export type PlatformResources = typeof PlatformResources.Type

export const WindowInput = Schema.Struct({ startTime: Schema.String, endTime: Schema.String })
export type WindowInput = typeof WindowInput.Type

export const TimeseriesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type TimeseriesInput = typeof TimeseriesInput.Type

/** `retainedInternalQuery("integrations", "cloudflareStatus")`, shared with the sidebar. */
export const loadStatus = (refresh: boolean) =>
	Effect.gen(function* () {
		const statuses = yield* IntegrationStatuses
		return yield* statuses.cloudflare({ refresh })
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `retainedInternalQuery("integrations", "cloudflareUsage")`. */
export const loadUsage = () =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.integrations.cloudflareUsage()
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const loadZones = (data: WindowInput) =>
	getCloudflareZones({ data }).pipe(
		Effect.map((response): ReadonlyArray<ZoneRow> => response.zones),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const loadZoneTimeseries = (data: TimeseriesInput) =>
	getCloudflareZoneTimeseries({ data }).pipe(
		Effect.map((response): ReadonlyArray<ZoneBucket> => response.buckets),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const loadWorkers = (data: WindowInput) =>
	getCloudflareWorkers({ data }).pipe(
		Effect.map((response): ReadonlyArray<WorkerRow> => response.workers),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const loadPlatform = (data: WindowInput) =>
	getCloudflarePlatformResources({ data }).pipe(
		Effect.map((response): PlatformResources => response),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)
