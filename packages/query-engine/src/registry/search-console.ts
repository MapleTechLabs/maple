import {
	SEARCH_CONSOLE_LANDING_DEFAULT_LIMIT,
	SEARCH_CONSOLE_LIST_DEFAULT_LIMIT,
	type SearchConsoleLandingPagesRequest,
	type SearchConsoleOverviewRequest,
	type SearchConsoleTimeseriesRequest,
	type SearchConsoleTopPagesRequest,
	type SearchConsoleTopQueriesRequest,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import * as CH from "../ch"
import { timeRangeCache } from "../runtime/cache-policy"
import { wholeDayWindow } from "./day-window"
import { defineQuery, windowParams } from "./query-definition"

// Search Console reads. Google reports whole days, so the page's window is floored to the
// midnight-UTC `Date` rows it covers, both ends inclusive, and ends at the last complete day.

/** The whole (Pacific) days a Search Console window covers; see `wholeDayWindow`. */
export const searchConsoleDays = wholeDayWindow

type Window = {
	readonly siteUrl: string
	readonly startTime: string
	readonly endTime: string
	readonly completeThrough?: string
}

const params = (payload: Window, orgId: OrgId) => {
	const days = searchConsoleDays(payload)
	return { orgId, siteUrl: payload.siteUrl, startDate: days.startDate, endDate: days.endDate }
}

const sortOpts = (payload: SearchConsoleTopPagesRequest | SearchConsoleTopQueriesRequest) => ({
	sortBy: payload.sortBy,
	sortDir: payload.sortDir,
	limit: payload.limit,
	page: payload.page,
})

/** Pages over-fetched past the table's limit, so http/https and `/a`, `/a/` merge before the cut. */
const PAGE_OVERFETCH = 3

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
		CH.compile(
			CH.searchConsoleTopQueriesQuery({
				...sortOpts(payload),
				query: payload.query,
				country: payload.country,
				device: payload.device,
			}),
			params(payload, orgId),
		),
})

export const searchConsoleTopPages = defineQuery({
	id: "searchConsoleTopPages",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleTopPagesRequest, orgId: OrgId) =>
		CH.compile(
			CH.searchConsoleTopPagesQuery({
				...sortOpts(payload),
				limit: (payload.limit ?? SEARCH_CONSOLE_LIST_DEFAULT_LIMIT) * PAGE_OVERFETCH,
			}),
			params(payload, orgId),
		),
})

export const searchConsoleLandingPages = defineQuery({
	id: "searchConsoleLandingPages",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleLandingPagesRequest, orgId: OrgId) =>
		CH.compile(
			CH.searchConsoleLandingPagesQuery({
				sortBy: payload.sortBy,
				sortDir: payload.sortDir,
				limit: (payload.limit ?? SEARCH_CONSOLE_LANDING_DEFAULT_LIMIT) * PAGE_OVERFETCH,
			}),
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
			windowParams(payload, orgId),
		),
})
