// Search Console reads for the dashboard (and the MCP tools after it): the registry queries over
// `search_console_daily`, shaped for the wire, and the landing pages join with web analytics.
import {
	SEARCH_CONSOLE_LANDING_DEFAULT_LIMIT,
	SEARCH_CONSOLE_LIST_DEFAULT_LIMIT,
	type SearchConsoleLandingPagesRequest,
	type SearchConsoleOverviewRequest,
	type SearchConsoleTimeseriesRequest,
	type SearchConsoleTopPagesRequest,
	type SearchConsoleTopQueriesRequest,
} from "@maple/domain/http"
import { Queries } from "@maple/query-engine/registry"
import { DateTime, Effect, Array as Arr } from "effect"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { makeQueryRunners, type QueryRunnerDeps } from "@maple/backend/queries/query-runner"
import {
	entryPathsFor,
	mergeLandingPages,
	topSearchPages,
} from "@maple/backend/services/integrations/google-search-console/landing-pages"

const metricsOf = (row: {
	readonly clicks: number
	readonly impressions: number
	readonly ctr: number
	readonly position: number
}) => ({ clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position })

const EMPTY_METRICS = { clicks: 0, impressions: 0, ctr: 0, position: 0 }

export const makeSearchConsoleReads = (deps: QueryRunnerDeps) => {
	const { runQuery, runQueryFirst } = makeQueryRunners(deps)

	const overview = Effect.fn("SearchConsoleReads.overview")(function* (
		tenant: TenantContext,
		payload: SearchConsoleOverviewRequest,
	) {
		const row = yield* runQueryFirst(Queries.searchConsoleOverview, tenant, payload)
		if (row === null) return { ...EMPTY_METRICS, previous: EMPTY_METRICS }
		return {
			...metricsOf(row),
			previous: {
				clicks: row.previousClicks,
				impressions: row.previousImpressions,
				ctr: row.previousCtr,
				position: row.previousPosition,
			},
		}
	})

	const timeseries = Effect.fn("SearchConsoleReads.timeseries")(function* (
		tenant: TenantContext,
		payload: SearchConsoleTimeseriesRequest,
	) {
		const rows = yield* runQuery(Queries.searchConsoleTimeseries, tenant, payload)
		return Arr.map(rows, (row) => ({ date: DateTime.formatIsoDateUtc(row.date), ...metricsOf(row) }))
	})

	const topQueries = Effect.fn("SearchConsoleReads.topQueries")(function* (
		tenant: TenantContext,
		payload: SearchConsoleTopQueriesRequest,
	) {
		const rows = yield* runQuery(Queries.searchConsoleTopQueries, tenant, payload)
		return Arr.map(rows, (row) => ({ query: row.query, ...metricsOf(row) }))
	})

	const topPages = Effect.fn("SearchConsoleReads.topPages")(function* (
		tenant: TenantContext,
		payload: SearchConsoleTopPagesRequest,
	) {
		// Over-fetched by the query, merged by host + path, then sorted and cut to the limit.
		const rows = yield* runQuery(Queries.searchConsoleTopPages, tenant, payload)
		return topSearchPages(rows, {
			sortBy: payload.sortBy,
			sortDir: payload.sortDir,
			limit: payload.limit ?? SEARCH_CONSOLE_LIST_DEFAULT_LIMIT,
		})
	})

	/**
	 * Search pages first, then the sessions entering on just those paths (and, with a conversion
	 * event, the ones that fired it). Two routes, so the join is `mergeLandingPages`, not SQL.
	 */
	const landingPages = Effect.fn("SearchConsoleReads.landingPages")(function* (
		tenant: TenantContext,
		payload: SearchConsoleLandingPagesRequest,
	) {
		// Over-fetched by the query, merged by host + path, then cut to the limit.
		const limit = payload.limit ?? SEARCH_CONSOLE_LANDING_DEFAULT_LIMIT
		const sort = { sortBy: payload.sortBy, sortDir: payload.sortDir }
		const pages = yield* runQuery(Queries.searchConsoleLandingPages, tenant, payload)
		const entryPaths = entryPathsFor(pages)
		yield* Effect.annotateCurrentSpan({ "maple.search_console.landing_paths": entryPaths.length })
		if (entryPaths.length === 0)
			return Arr.take(mergeLandingPages({ pages, entries: [], conversions: null, sort }), limit)
		// The same whole days the Search Console half covers.
		const days = Queries.searchConsoleDays(payload)
		const window = { startTime: days.startDate, endTime: days.endOfDay, entryPaths }
		const conversionEvent = payload.conversionEvent
		// Resolve the web analytics route once, not in both concurrent reads.
		if (conversionEvent !== undefined) yield* deps.warehouse.warmRoute(tenant)
		const [entries, conversions] = yield* Effect.all(
			[
				runQuery(Queries.searchConsoleEntryPages, tenant, window),
				conversionEvent === undefined
					? Effect.succeed(null)
					: runQuery(Queries.searchConsoleEntryPages, tenant, {
							...window,
							eventName: conversionEvent,
						}),
			],
			{ concurrency: 2 },
		)
		return Arr.take(mergeLandingPages({ pages, entries, conversions, sort }), limit)
	})

	return { overview, timeseries, topQueries, topPages, landingPages } as const
}
