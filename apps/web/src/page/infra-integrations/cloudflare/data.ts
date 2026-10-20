import {
	CloudflareInfraZoneFacetsResponse,
	CloudflareIntegrationStatus,
	CloudflareUsageResponse,
} from "@maple/domain/http"
import {
	CLOUDFLARE_BREAKDOWN_DIMENSIONS,
	getCloudflarePlatformResources,
	getCloudflareTopTraffic,
	getCloudflareWorkerDetail,
	getCloudflareWorkers,
	getCloudflareZoneBreakdown,
	getCloudflareZoneDetail,
	getCloudflareZoneDns,
	getCloudflareZoneFacets,
	getCloudflareZoneSecurity,
	getCloudflareZones,
	getCloudflareZoneTimeseries,
} from "@maple/web-data/warehouse/cloudflare-infra"
import { getReleases } from "@maple/web-data/warehouse/releases"
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

export const WorkerDetail = Schema.Struct({
	outcomeBuckets: Schema.Array(
		Schema.Struct({ bucket: Schema.String, status: Schema.String, requests: Schema.Number }),
	),
	latencyBuckets: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			cpuP50Ms: Schema.Number,
			cpuP99Ms: Schema.Number,
			durationP50Ms: Schema.Number,
			durationP99Ms: Schema.Number,
			doWallP50Ms: Schema.Number,
			doWallP99Ms: Schema.Number,
		}),
	),
	durableObjectBuckets: Schema.Array(
		Schema.Struct({ bucket: Schema.String, requests: Schema.Number, errors: Schema.Number }),
	),
})
export type WorkerDetail = typeof WorkerDetail.Type

export const WorkerDetailInput = Schema.Struct({
	serviceName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	accountId: Schema.optional(Schema.String),
})
export type WorkerDetailInput = typeof WorkerDetailInput.Type

/** `cloudflareWorkerDetailResultAtom`. */
export const loadWorkerDetail = (data: WorkerDetailInput) =>
	getCloudflareWorkerDetail({ data }).pipe(
		Effect.map((detail): WorkerDetail => detail),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** The parts of a release the Worker page reads. */
export const Release = Schema.Struct({
	serviceName: Schema.String,
	commitSha: Schema.String,
	firstSeen: Schema.String,
	spanCount: Schema.Number,
	errorCount: Schema.Number,
})
export type Release = typeof Release.Type

export const ReleasesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	services: Schema.Array(Schema.String),
})
export type ReleasesInput = typeof ReleasesInput.Type

/** `getReleasesResultAtom`. */
export const loadReleases = (input: ReleasesInput) =>
	getReleases({ data: { ...input, services: [...input.services] } }).pipe(
		Effect.map((result): ReadonlyArray<Release> =>
			result.releases.map((release) => ({
				serviceName: release.serviceName,
				commitSha: release.commitSha,
				firstSeen: release.firstSeen,
				spanCount: release.spanCount,
				errorCount: release.errorCount,
			})),
		),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** The zone filters every zone read carries (`CloudflareFilters`, URL-shaped). */
export const ZoneFilters = Schema.Struct({
	hosts: Schema.optional(Schema.Array(Schema.String)),
	cacheStatuses: Schema.optional(Schema.Array(Schema.String)),
	statusClasses: Schema.optional(Schema.Array(Schema.String)),
	paths: Schema.optional(Schema.Array(Schema.String)),
	pathContains: Schema.optional(Schema.String),
	countries: Schema.optional(Schema.Array(Schema.String)),
	methods: Schema.optional(Schema.Array(Schema.String)),
	protocols: Schema.optional(Schema.Array(Schema.String)),
	deviceTypes: Schema.optional(Schema.Array(Schema.String)),
})
export type ZoneFilters = typeof ZoneFilters.Type

export const ZoneDetailInput = Schema.Struct({
	...ZoneFilters.fields,
	serviceName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type ZoneDetailInput = typeof ZoneDetailInput.Type

export const ZoneDetail = Schema.Struct({
	statusBuckets: Schema.Array(
		Schema.Struct({ bucket: Schema.String, statusClass: Schema.String, requests: Schema.Number }),
	),
	cacheBuckets: Schema.Array(
		Schema.Struct({ bucket: Schema.String, cacheStatus: Schema.String, requests: Schema.Number }),
	),
	latencyBuckets: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			ttfbP50Ms: Schema.Number,
			ttfbP95Ms: Schema.Number,
			ttfbP99Ms: Schema.Number,
			originP50Ms: Schema.Number,
			originP95Ms: Schema.Number,
			originP99Ms: Schema.Number,
		}),
	),
	ignoredFilters: Schema.Array(Schema.String),
	latencyIgnoredFilters: Schema.Array(Schema.String),
})
export type ZoneDetail = typeof ZoneDetail.Type

export const ZoneDns = Schema.Struct({
	buckets: Schema.Array(
		Schema.Struct({ bucket: Schema.String, responseCode: Schema.String, queries: Schema.Number }),
	),
	names: Schema.Array(
		Schema.Struct({ queryName: Schema.String, queries: Schema.Number, nxdomain: Schema.Number }),
	),
	ignoredFilters: Schema.Array(Schema.String),
})
export type ZoneDns = typeof ZoneDns.Type

export const ZoneSecurity = Schema.Struct({
	buckets: Schema.Array(
		Schema.Struct({ bucket: Schema.String, action: Schema.String, events: Schema.Number }),
	),
	top: Schema.Array(
		Schema.Struct({
			source: Schema.String,
			action: Schema.String,
			ruleId: Schema.String,
			host: Schema.String,
			events: Schema.Number,
		}),
	),
	ignoredFilters: Schema.Array(Schema.String),
})
export type ZoneSecurity = typeof ZoneSecurity.Type

export const ZoneFacetsInput = Schema.Struct({
	...ZoneFilters.fields,
	serviceName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
})
export type ZoneFacetsInput = typeof ZoneFacetsInput.Type

export const ZoneFacets = CloudflareInfraZoneFacetsResponse
export type ZoneFacets = CloudflareInfraZoneFacetsResponse

export const ZonesInput = Schema.Struct({
	...ZoneFilters.fields,
	startTime: Schema.String,
	endTime: Schema.String,
})
export type ZonesInput = typeof ZonesInput.Type

export const BreakdownDimension = Schema.Literals(CLOUDFLARE_BREAKDOWN_DIMENSIONS)
export type BreakdownDimension = typeof BreakdownDimension.Type

export const BreakdownInput = Schema.Struct({
	...ZoneDetailInput.fields,
	dimension: BreakdownDimension,
	limit: Schema.Number,
})
export type BreakdownInput = typeof BreakdownInput.Type

export const BreakdownTotal = Schema.Struct({
	key: Schema.String,
	requests: Schema.Number,
	errors5xx: Schema.Number,
	errorRate: Schema.Number,
	bytes: Schema.Number,
	share: Schema.Number,
})
export type BreakdownTotal = typeof BreakdownTotal.Type

export const ZoneBreakdown = Schema.Struct({
	totals: Schema.Array(BreakdownTotal),
	coverage: Schema.Number,
	coverageStart: Schema.NullOr(Schema.String),
	ignoredFilters: Schema.Array(Schema.String),
})
export type ZoneBreakdown = typeof ZoneBreakdown.Type

export const TopTrafficInput = Schema.Struct({
	zoneName: Schema.String,
	dimension: Schema.Literals(["host", "path"]),
	startTime: Schema.Number,
	endTime: Schema.Number,
	limit: Schema.Number,
	contains: Schema.String,
})
export type TopTrafficInput = typeof TopTrafficInput.Type

export const TopTraffic = Schema.Struct({
	unavailableReason: Schema.NullOr(Schema.String),
	rows: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			requests: Schema.Number,
			bytes: Schema.Number,
			errors5xx: Schema.Number,
			errorRate: Schema.Number,
		}),
	),
})
export type TopTraffic = typeof TopTraffic.Type

/** `cloudflareZoneDetailResultAtom`. */
export const loadZoneDetail = (data: ZoneDetailInput) =>
	getCloudflareZoneDetail({ data }).pipe(
		Effect.map((detail): ZoneDetail => detail),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** `cloudflareZoneDnsResultAtom`. */
export const loadZoneDns = (data: ZoneDetailInput) =>
	getCloudflareZoneDns({ data }).pipe(
		Effect.map((dns): ZoneDns => dns),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** `cloudflareZoneSecurityResultAtom`. */
export const loadZoneSecurity = (data: ZoneDetailInput) =>
	getCloudflareZoneSecurity({ data }).pipe(
		Effect.map((security): ZoneSecurity => security),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** `cloudflareZoneFacetsResultAtom`. */
export const loadZoneFacets = (data: ZoneFacetsInput) =>
	getCloudflareZoneFacets({ data }).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `cloudflareZonesResultAtom` with the zone page's filters. */
export const loadFilteredZones = (data: ZonesInput) =>
	getCloudflareZones({ data }).pipe(
		Effect.map((response): ReadonlyArray<ZoneRow> => response.zones),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** `cloudflareZoneBreakdownResultAtom`. */
export const loadZoneBreakdown = (data: BreakdownInput) =>
	getCloudflareZoneBreakdown({ data }).pipe(
		Effect.map((breakdown): ZoneBreakdown => ({
			totals: breakdown.totals,
			coverage: breakdown.coverage,
			coverageStart: breakdown.coverageStart,
			ignoredFilters: breakdown.ignoredFilters,
		})),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** `cloudflareTopTrafficResultAtom`: the live long-tail lookup. */
export const loadTopTraffic = (data: TopTrafficInput) =>
	getCloudflareTopTraffic({ data }).pipe(
		Effect.map((traffic): TopTraffic => traffic),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)
