import { DateTime, Effect } from "effect"
import {
	WebAnalyticsAiCrawlersRequest,
	WebAnalyticsAiCrawlersResponse,
	WebAnalyticsAiReferralsRequest,
	WebAnalyticsAiReferralsResponse,
	WebAnalyticsBreakdownsRequest,
	WebAnalyticsBreakdownsResponse,
	WebAnalyticsEventsRequest,
	WebAnalyticsEventsResponse,
	WebAnalyticsLiveRequest,
	WebAnalyticsLiveResponse,
	WebAnalyticsPagesRequest,
	WebAnalyticsPagesResponse,
	WebAnalyticsPageviewsRequest,
	WebAnalyticsPageviewsResponse,
	WebAnalyticsSummaryRequest,
	WebAnalyticsSummaryResponse,
	WebAnalyticsTimeseriesRequest,
	WebAnalyticsTimeseriesResponse,
} from "@maple/domain/http"
import { isAiContentFormat } from "@maple/domain/ai-traffic"
import { SESSION_LIVE_WINDOW_SECONDS } from "@maple/domain/query-engine"
import { Queries } from "@maple/query-engine/registry"
import { warehouseEndpoint } from "../../../backend/endpoints/run.ts"
import type { FixtureWarehouse } from "../../../backend/warehouse.ts"
import type { EndpointHandler } from "../../dataset.ts"

/**
 * The web analytics endpoints of `HttpQueryEngineLive`: the rollup (`product_events`) queries
 * and row shaping. The fixture schema always has `product_events`, so the raw fallback never runs.
 */

type Facet = { name: string; count: number }

const BUCKET_OF = {
	referrerHost: "referrerHosts",
	country: "countries",
	deviceType: "deviceTypes",
	browserName: "browsers",
	osName: "operatingSystems",
	language: "languages",
	utmSource: "utmSources",
	utmMedium: "utmMediums",
	utmCampaign: "utmCampaigns",
	entryPath: "entryPaths",
	exitPath: "exitPaths",
	host: "hosts",
} as const

const bucketKey = (facetType: string) => Object.entries(BUCKET_OF).find(([facet]) => facet === facetType)?.[1]

export const webAnalyticsEndpoints = (
	warehouse: FixtureWarehouse,
): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.webAnalyticsSummary": warehouseEndpoint(
		warehouse,
		WebAnalyticsSummaryRequest,
		WebAnalyticsSummaryResponse,
		(payload, { runQueryFirst }) =>
			Effect.map(
				runQueryFirst(Queries.webAnalyticsSummary, payload),
				(row) =>
					new WebAnalyticsSummaryResponse({
						data: {
							visitors: Number(row?.visitors) || 0,
							sessions: Number(row?.sessions) || 0,
							newSessions: Number(row?.newSessions) || 0,
							bouncedSessions: Number(row?.bouncedSessions) || 0,
							identifiedSessions: Number(row?.identifiedSessions) || 0,
							avgDurationMs: Number(row?.avgDurationMs) || 0,
							botSessions: Number(row?.botSessions) || 0,
						},
					}),
			),
	),
	"queryEngine.webAnalyticsLive": warehouseEndpoint(
		warehouse,
		WebAnalyticsLiveRequest,
		WebAnalyticsLiveResponse,
		(payload, { runQueryFirst }) =>
			Effect.map(
				runQueryFirst(Queries.webAnalyticsLive, payload),
				(row) =>
					new WebAnalyticsLiveResponse({
						data: {
							visitors: Number(row?.visitors) || 0,
							sessions: Number(row?.sessions) || 0,
							windowSeconds: SESSION_LIVE_WINDOW_SECONDS,
						},
					}),
			),
	),
	"queryEngine.webAnalyticsTimeseries": warehouseEndpoint(
		warehouse,
		WebAnalyticsTimeseriesRequest,
		WebAnalyticsTimeseriesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.webAnalyticsTimeseries, payload),
				(rows) =>
					new WebAnalyticsTimeseriesResponse({
						data: rows.map((row) => ({
							bucket: DateTime.formatIso(row.bucket),
							visitors: row.visitors || 0,
							sessions: row.sessions || 0,
							newSessions: row.newSessions || 0,
							bouncedSessions: row.bouncedSessions || 0,
							identifiedSessions: row.identifiedSessions || 0,
							avgDurationMs: row.avgDurationMs || 0,
						})),
					}),
			),
	),
	"queryEngine.webAnalyticsPageviews": warehouseEndpoint(
		warehouse,
		WebAnalyticsPageviewsRequest,
		WebAnalyticsPageviewsResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.webAnalyticsPageviews, payload),
				(rows) =>
					new WebAnalyticsPageviewsResponse({
						data: rows.map((row) => ({
							bucket: DateTime.formatIso(row.bucket),
							pageViews: row.pageViews || 0,
							sessions: row.sessions || 0,
						})),
					}),
			),
	),
	"queryEngine.webAnalyticsPages": warehouseEndpoint(
		warehouse,
		WebAnalyticsPagesRequest,
		WebAnalyticsPagesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.webAnalyticsPages, payload),
				(rows) =>
					new WebAnalyticsPagesResponse({
						data: rows.map((row) => ({
							host: row.host,
							pagePath: row.pagePath,
							pageViews: row.pageViews || 0,
							sessions: row.sessions || 0,
						})),
					}),
			),
	),
	"queryEngine.webAnalyticsEvents": warehouseEndpoint(
		warehouse,
		WebAnalyticsEventsRequest,
		WebAnalyticsEventsResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.webAnalyticsEvents, payload),
				(rows) =>
					new WebAnalyticsEventsResponse({
						data: rows.map((row) => ({
							name: row.name,
							events: row.events || 0,
							sessions: row.sessions || 0,
						})),
					}),
			),
	),
	"queryEngine.webAnalyticsAiReferrals": warehouseEndpoint(
		warehouse,
		WebAnalyticsAiReferralsRequest,
		WebAnalyticsAiReferralsResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.webAnalyticsAiReferrals, payload),
				(rows) =>
					new WebAnalyticsAiReferralsResponse({
						data: rows.map((row) => ({
							bucket: DateTime.formatIso(row.bucket),
							product: row.product,
							sessions: row.sessions || 0,
						})),
					}),
			),
	),
	// `ai_crawler_requests` has no fixture rows: the real queries answer an empty crawl log.
	"queryEngine.webAnalyticsAiCrawlers": warehouseEndpoint(
		warehouse,
		WebAnalyticsAiCrawlersRequest,
		WebAnalyticsAiCrawlersResponse,
		(payload, { runQuery }) =>
			Effect.map(
				Effect.all([
					runQuery(Queries.webAnalyticsAiCrawlers, payload),
					runQuery(Queries.webAnalyticsAiCrawlerFormats, payload),
					runQuery(Queries.webAnalyticsAiCrawledPages, payload),
				]),
				([crawlers, formats, pages]) =>
					new WebAnalyticsAiCrawlersResponse({
						data: {
							crawlers: crawlers.map((row) => ({
								crawler: row.crawler,
								requests: row.requests || 0,
								failedRequests: row.failedRequests || 0,
								pages: row.pages || 0,
								lastSeen: DateTime.formatIso(row.lastSeen),
							})),
							formats: formats.flatMap((row) =>
								isAiContentFormat(row.format)
									? [
											{
												format: row.format,
												requests: row.requests || 0,
												failedRequests: row.failedRequests || 0,
												pages: row.pages || 0,
												crawlers: row.crawlers,
											},
										]
									: [],
							),
							pages: pages.map((row) => ({
								host: row.host,
								path: row.path,
								requests: row.requests || 0,
								crawlers: row.crawlers,
								lastSeen: DateTime.formatIso(row.lastSeen),
							})),
						},
					}),
			),
	),
	"queryEngine.webAnalyticsBreakdowns": warehouseEndpoint(
		warehouse,
		WebAnalyticsBreakdownsRequest,
		WebAnalyticsBreakdownsResponse,
		(payload, { runQuery }) =>
			Effect.map(runQuery(Queries.webAnalyticsBreakdowns, payload), (rows) => {
				const of = (key: (typeof BUCKET_OF)[keyof typeof BUCKET_OF]): Array<Facet> =>
					rows.flatMap((row) =>
						bucketKey(row.facetType) === key ? [{ name: row.name, count: row.count || 0 }] : [],
					)
				return new WebAnalyticsBreakdownsResponse({
					data: {
						referrerHosts: of("referrerHosts"),
						countries: of("countries"),
						deviceTypes: of("deviceTypes"),
						browsers: of("browsers"),
						operatingSystems: of("operatingSystems"),
						languages: of("languages"),
						utmSources: of("utmSources"),
						utmMediums: of("utmMediums"),
						utmCampaigns: of("utmCampaigns"),
						entryPaths: of("entryPaths"),
						exitPaths: of("exitPaths"),
						hosts: of("hosts"),
					},
				})
			}),
	),
})
