import {
	SEARCH_CONSOLE_LANDING_DEFAULT_LIMIT,
	type SearchConsoleLandingPagesRequest,
	type SearchConsoleOverviewRequest,
	type SearchConsoleTimeseriesRequest,
	type SearchConsoleTopPagesRequest,
	type SearchConsoleTopQueriesRequest,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "../datetime"
import * as CH from "../ch"
import { timeRangeCache } from "../runtime/query-engine"
import { defineQuery } from "./query-definition"

// Search Console reads. Google reports whole days, so the page's window is floored to the
// midnight-UTC `Date` rows it covers, both ends inclusive, and ends at the last complete day.

const DAY_MS = 86_400_000

const floorDay = (value: string): number => Math.floor(parseWarehouseDateTime(value) / DAY_MS) * DAY_MS

/**
 * The days a window covers, capped at `completeThrough` so a partial day never counts, and the
 * equal-length run of days before them. A window wholly past the cap covers no day.
 */
export const searchConsoleDays = (window: {
	readonly startTime: string
	readonly endTime: string
	readonly completeThrough?: string
}) => {
	const start = floorDay(window.startTime)
	const requestedEnd = Math.max(start, floorDay(window.endTime))
	const end =
		window.completeThrough === undefined
			? requestedEnd
			: Math.min(requestedEnd, parseWarehouseDateTime(`${window.completeThrough} 00:00:00`))
	const days = Math.max(0, Math.round((end - start) / DAY_MS) + 1)
	return {
		startDate: formatWarehouseDateTime(start),
		endDate: formatWarehouseDateTime(end),
		/** The last second of the end day, for reads over timestamps rather than days. */
		endOfDay: formatWarehouseDateTime(end + DAY_MS - 1000),
		previousStartDate: formatWarehouseDateTime(start - days * DAY_MS),
	}
}

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

const listOpts = (payload: SearchConsoleTopPagesRequest) => ({
	sortBy: payload.sortBy,
	sortDir: payload.sortDir,
	limit: payload.limit,
	country: payload.country,
	device: payload.device,
	page: payload.page,
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
		CH.compile(
			CH.searchConsoleTopQueriesQuery({ ...listOpts(payload), query: payload.query }),
			params(payload, orgId),
		),
})

export const searchConsoleTopPages = defineQuery({
	id: "searchConsoleTopPages",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleTopPagesRequest, orgId: OrgId) =>
		CH.compile(CH.searchConsoleTopPagesQuery(listOpts(payload)), params(payload, orgId)),
})

/** Pages over-fetched past the table's limit, so http/https and `/a`, `/a/` merge before the cut. */
const LANDING_OVERFETCH = 3

export const searchConsoleLandingPages = defineQuery({
	id: "searchConsoleLandingPages",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: SearchConsoleLandingPagesRequest, orgId: OrgId) =>
		CH.compile(
			CH.searchConsoleLandingPagesQuery({
				limit: (payload.limit ?? SEARCH_CONSOLE_LANDING_DEFAULT_LIMIT) * LANDING_OVERFETCH,
				sortBy: payload.sortBy,
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
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})
