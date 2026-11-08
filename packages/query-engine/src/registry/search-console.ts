import type {
	SearchConsoleLandingPagesRequest,
	SearchConsoleOverviewRequest,
	SearchConsoleTimeseriesRequest,
	SearchConsoleTopPagesRequest,
	SearchConsoleTopQueriesRequest,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "../datetime"
import * as CH from "../ch"
import { timeRangeCache } from "../runtime/query-engine"
import { defineQuery } from "./query-definition"

// Search Console reads. Google reports whole days, so the page's window is floored to the
// midnight-UTC `Date` rows it covers, both ends inclusive.

const DAY_MS = 86_400_000

const floorDay = (value: string): number => Math.floor(parseWarehouseDateTime(value) / DAY_MS) * DAY_MS

/** The days a window covers, and the equal-length run of days before them. */
export const searchConsoleDays = (window: { readonly startTime: string; readonly endTime: string }) => {
	const start = floorDay(window.startTime)
	const end = Math.max(start, floorDay(window.endTime))
	const days = Math.round((end - start) / DAY_MS) + 1
	return {
		startDate: formatWarehouseDateTime(start),
		endDate: formatWarehouseDateTime(end),
		previousStartDate: formatWarehouseDateTime(start - days * DAY_MS),
	}
}

type Window = { readonly siteUrl: string; readonly startTime: string; readonly endTime: string }

const params = (payload: Window, orgId: OrgId) => {
	const days = searchConsoleDays(payload)
	return { orgId, siteUrl: payload.siteUrl, startDate: days.startDate, endDate: days.endDate }
}

const listOpts = (payload: SearchConsoleTopQueriesRequest | SearchConsoleTopPagesRequest) => ({
	sortBy: payload.sortBy,
	sortDir: payload.sortDir,
	limit: payload.limit,
	country: payload.country,
	device: payload.device,
	page: payload.page,
	query: payload.query,
})

export const searchConsoleOverview = defineQuery({
	id: "searchConsoleOverview",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleOverviewRequest, orgId: OrgId) =>
		CH.compile(CH.searchConsoleOverviewQuery(), {
			...params(payload, orgId),
			previousStartDate: searchConsoleDays(payload).previousStartDate,
		}),
})

export const searchConsoleTimeseries = defineQuery({
	id: "searchConsoleTimeseries",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleTimeseriesRequest, orgId: OrgId) =>
		CH.compile(CH.searchConsoleTimeseriesQuery(), params(payload, orgId)),
})

export const searchConsoleTopQueries = defineQuery({
	id: "searchConsoleTopQueries",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleTopQueriesRequest, orgId: OrgId) =>
		CH.compile(CH.searchConsoleTopQueriesQuery(listOpts(payload)), params(payload, orgId)),
})

export const searchConsoleTopPages = defineQuery({
	id: "searchConsoleTopPages",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleTopPagesRequest, orgId: OrgId) =>
		CH.compile(CH.searchConsoleTopPagesQuery(listOpts(payload)), params(payload, orgId)),
})

export const searchConsoleLandingPages = defineQuery({
	id: "searchConsoleLandingPages",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleLandingPagesRequest, orgId: OrgId) =>
		CH.compile(
			CH.searchConsoleLandingPagesQuery({ limit: payload.limit, sortBy: payload.sortBy }),
			params(payload, orgId),
		),
})

/** The browser side of the landing pages table: human sessions entering on the given paths. */
export interface SearchConsoleEntryPagesPayload {
	readonly startTime: string
	readonly endTime: string
	readonly entryPaths: ReadonlyArray<string>
	/** Set to count only sessions that fired this `track()` event (the conversions column). */
	readonly eventName?: string
}

export const searchConsoleEntryPages = defineQuery({
	id: "searchConsoleEntryPages",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleEntryPagesPayload, orgId: OrgId) =>
		CH.compile(
			CH.webAnalyticsEntryPagesQuery({
				entryPaths: payload.entryPaths,
				eventName: payload.eventName,
				// Search clicks are people; crawler sessions would inflate the denominator.
				traffic: "humans",
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})
