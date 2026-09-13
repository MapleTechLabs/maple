import type {
	ProductEventNamesRequest,
	ProductEventsForTraceRequest,
	ProductEventsFunnelBreakdownRequest,
	ProductEventsFunnelRequest,
	ProductEventTraceSamplesRequest,
} from "@maple/domain/http"
import type {
	ProductEventsBreakdownQuery,
	ProductEventsFilters,
	ProductEventsListQuery,
	ProductEventsTimeseriesQuery,
} from "@maple/domain/query-engine"
import * as CH from "../ch"
import { timeRangeCache } from "../runtime/query-engine"
import { defineQuery, makeTimeBucketQueryCachePolicy } from "./query-definition"

// Product-event funnels read `product_events` only — server and mobile rows have
// no raw `session_events` counterpart, so unlike the web-analytics pairs there is
// no `Raw` twin to fall back to. The builders validate the funnel definition
// synchronously and throw `ProductEventsFunnelError`; the HTTP handler checks the
// definition through `productEventsFunnelOpts` before `compile` runs here so a
// bad definition is a 400 rather than a defect.

/** The web-analytics filter surface, read off any funnel-family request. */
const productEventsFilters = (payload: ProductEventNamesRequest): CH.ProductEventsFilters => ({
	host: payload.host,
	pagePath: payload.pagePath,
	referrerHost: payload.referrerHost,
	country: payload.country,
	deviceType: payload.deviceType,
	browserName: payload.browserName,
	osName: payload.osName,
	language: payload.language,
	utmSource: payload.utmSource,
	utmMedium: payload.utmMedium,
	utmCampaign: payload.utmCampaign,
	visitorType: payload.visitorType,
	useProductEvents: true,
})

/** The funnel option bag shared by the plain and breakdown queries. */
export const productEventsFunnelOpts = (
	payload: ProductEventsFunnelRequest | ProductEventsFunnelBreakdownRequest,
): CH.ProductEventsFunnelOpts => ({
	steps: payload.steps,
	keyBy: payload.keyBy,
	windowSeconds: payload.windowSeconds,
	filters: productEventsFilters(payload),
})

export const productEventsFunnel = defineQuery({
	id: "productEventsFunnel",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ProductEventsFunnelRequest, orgId: string) =>
		CH.compile(CH.productEventsFunnelQuery(productEventsFunnelOpts(payload)), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const productEventsFunnelBreakdown = defineQuery({
	id: "productEventsFunnelBreakdown",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ProductEventsFunnelBreakdownRequest, orgId: string) =>
		CH.compile(
			CH.productEventsFunnelBreakdownQuery({
				...productEventsFunnelOpts(payload),
				breakdownBy: payload.breakdownBy,
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const productEventNames = defineQuery({
	id: "productEventNames",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ProductEventNamesRequest, orgId: string) =>
		CH.compile(
			CH.productEventNamesQuery({
				filters: productEventsFilters(payload),
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

// The trace ↔ product-event link, both directions. `list` profile because each is
// a bloom-filter point lookup, and a flat 60s rather than `timeRangeCache`
// because the answer does not widen with the range asked about.

export const productEventsForTrace = defineQuery({
	id: "productEventsForTrace",
	profile: "list",
	cache: 60,
	compile: (payload: ProductEventsForTraceRequest, orgId: string) =>
		CH.compile(CH.productEventsForTraceQuery({ limit: payload.limit ?? 50 }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			traceId: payload.traceId,
		}),
})

export const productEventTraceSamples = defineQuery({
	id: "productEventTraceSamples",
	profile: "list",
	cache: 60,
	compile: (payload: ProductEventTraceSamplesRequest, orgId: string) =>
		CH.compile(CH.productEventTraceSamplesQuery({ limit: payload.limit ?? 20 }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			eventName: payload.eventName,
		}),
})

// The query-builder source. One options bag per `ProductEventsFilters`, lowered
// field for field so a filter the domain accepts is a filter the SQL applies.

export const productEventsQueryOptions = (
	filters: ProductEventsFilters | undefined,
): CH.ProductEventsQueryOpts => ({
	eventNames: filters?.eventNames,
	kinds: filters?.kinds,
	sources: filters?.sources,
	hosts: filters?.hosts,
	pagePaths: filters?.pagePaths,
	serviceNames: filters?.serviceNames,
	userIds: filters?.userIds,
	groupIds: filters?.groupIds,
	excludedEventNames: filters?.excludedEventNames,
	excludedKinds: filters?.excludedKinds,
	excludedSources: filters?.excludedSources,
	excludedHosts: filters?.excludedHosts,
	excludedPagePaths: filters?.excludedPagePaths,
	excludedServiceNames: filters?.excludedServiceNames,
	attributeFilters: filters?.attributeFilters,
	groupByAttributeKey: filters?.groupByAttributeKey,
	referrerHost: filters?.referrerHost,
	country: filters?.country,
	deviceType: filters?.deviceType,
	browserName: filters?.browserName,
	osName: filters?.osName,
	language: filters?.language,
	utmSource: filters?.utmSource,
	utmMedium: filters?.utmMedium,
	utmCampaign: filters?.utmCampaign,
	visitorType: filters?.visitorType,
})

export interface ProductEventsTimeseriesInput {
	readonly startTime: string
	readonly endTime: string
	readonly bucketSeconds: number
	readonly metric: ProductEventsTimeseriesQuery["metric"]
	readonly groupBy?: ProductEventsTimeseriesQuery["groupBy"]
	readonly filters?: ProductEventsFilters
	readonly seriesLimit?: number
}

export const toProductEventsTimeseriesInput = (
	startTime: string,
	endTime: string,
	query: ProductEventsTimeseriesQuery,
	bucketSeconds: number,
): ProductEventsTimeseriesInput => ({
	startTime,
	endTime,
	bucketSeconds,
	metric: query.metric,
	groupBy: query.groupBy,
	filters: query.filters,
	seriesLimit: query.seriesLimit,
})

export const productEventsTimeseries = defineQuery({
	id: "productEventsTimeseries",
	profile: "aggregation",
	cache: makeTimeBucketQueryCachePolicy<ProductEventsTimeseriesInput>({
		identity: ({ metric, filters, groupBy, seriesLimit }) => ({ metric, filters, groupBy, seriesLimit }),
		fallback: 15,
	}),
	compile: (input: ProductEventsTimeseriesInput, orgId: string) =>
		CH.compile(
			CH.productEventsTimeseriesQuery({
				...productEventsQueryOptions(input.filters),
				metric: input.metric,
				groupBy: input.groupBy,
				bucketSeconds: input.bucketSeconds,
				seriesLimit: input.seriesLimit,
			}),
			{ orgId, startTime: input.startTime, endTime: input.endTime, bucketSeconds: input.bucketSeconds },
		),
})

export interface ProductEventsBreakdownInput {
	readonly startTime: string
	readonly endTime: string
	readonly query: ProductEventsBreakdownQuery
}

export const productEventsBreakdown = defineQuery({
	id: "productEventsBreakdown",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (input: ProductEventsBreakdownInput, orgId: string) =>
		CH.compile(
			CH.productEventsBreakdownQuery({
				...productEventsQueryOptions(input.query.filters),
				metric: input.query.metric,
				groupBy: input.query.groupBy,
				limit: input.query.limit,
			}),
			{ orgId, startTime: input.startTime, endTime: input.endTime },
		),
})

export interface ProductEventsListInput {
	readonly startTime: string
	readonly endTime: string
	readonly query: ProductEventsListQuery
}

export const productEventsList = defineQuery({
	id: "productEventsList",
	profile: "list",
	cache: timeRangeCache,
	compile: (input: ProductEventsListInput, orgId: string) =>
		CH.compile(
			CH.productEventsListQuery({
				...productEventsQueryOptions(input.query.filters),
				limit: input.query.limit,
				cursor: input.query.cursor,
			}),
			{ orgId, startTime: input.startTime, endTime: input.endTime },
		),
})
