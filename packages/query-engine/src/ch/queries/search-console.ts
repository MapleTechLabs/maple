// Google Search Console performance from `search_console_daily`. The table holds three grains
// (site totals, per page, per query) that must never be summed together. Every read keeps only the
// newest complete import of each day: the importer writes a completion marker per day and grain
// after all of an import's rows, since a re-fetched day can lose keys an older import still holds
// and an import can fail part-way. Pinned to the managed route: written through `ingest` only.

import { String as Str, type DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, fromQuery, param } from "@maple-dev/effect-orm/clickhouse"
import type { ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { SEARCH_TYPE_WEB, SEARCH_TYPE_WEB_COMPLETE } from "@maple/domain/search-console"
import { orgIdParam, utcSecondsParam } from "../tables"

export type SearchConsoleGrain = "site" | "page" | "query"

export const SEARCH_CONSOLE_SORT_KEYS = ["clicks", "impressions", "ctr", "position"] as const
export type SearchConsoleSortKey = (typeof SEARCH_CONSOLE_SORT_KEYS)[number]

/** Optional narrowing shared by the page and query lists. Values are inlined as escaped literals. */
export interface SearchConsoleFilters {
	/** Lowercase ISO 3166 alpha-3, as Google reports it. */
	readonly country?: string
	readonly device?: string
	/** A full page URL. */
	readonly page?: string
	readonly query?: string
}

/**
 * The page URL as given, plus its path with one trailing slash added or removed. Google reports
 * whichever form it crawled, so `https://acme.dev/docs` and `https://acme.dev/docs/` are the same
 * page split across two rows. The query string and fragment are kept as they are.
 */
export const pageUrlVariants = (page: string): ReadonlyArray<string> => {
	const path = Str.replace(/[?#][\s\S]*$/, "")(page)
	const rest = Str.slice(path.length)(page)
	const toggled = Str.endsWith("/")(path) ? Str.slice(0, -1)(path) : `${path}/`
	return [page, `${toggled}${rest}`]
}

type DailyAccessor = ColumnAccessor<typeof Datasources.searchConsoleDaily.columns>

/**
 * Base WHERE for one grain. Params: orgId, siteUrl, startDate, endDate (second-precision
 * bounds on the midnight-UTC `Date` column, inclusive).
 */
function dailyWhere(
	$: DailyAccessor,
	grain: SearchConsoleGrain,
	filters: SearchConsoleFilters,
	startParam: "startDate" | "previousStartDate" = "startDate",
	searchTypes: "rows" | "rowsAndMarkers" = "rows",
) {
	return [
		$.OrgId.eq(orgIdParam),
		$.SiteUrl.eq(param.string("siteUrl")),
		$.Grain.eq(grain),
		searchTypes === "rows"
			? $.SearchType.eq(SEARCH_TYPE_WEB)
			: CH.inList($.SearchType, [SEARCH_TYPE_WEB, SEARCH_TYPE_WEB_COMPLETE]),
		$.Date.gte(utcSecondsParam(startParam)),
		$.Date.lte(utcSecondsParam("endDate")),
		CH.when(filters.country, (v: string) => $.Country.eq(v)),
		CH.when(filters.device, (v: string) => $.Device.eq(v)),
		CH.when(filters.page, (v: string) => CH.inList($.Page, pageUrlVariants(v))),
		CH.when(filters.query, (v: string) => $.Query.eq(v)),
	]
}

/**
 * Each day's newest complete import for the grain, unfiltered: an import replaces the whole day.
 * Complete means marked; a day imported before markers existed has none, so its newest import counts.
 */
function newestImports(grain: SearchConsoleGrain, startParam: "startDate" | "previousStartDate") {
	return from(Datasources.searchConsoleDaily)
		.select(($) => ({
			date: $.Date,
			// Ordered by (is a marker, IngestedAt): the newest marker wins over any unmarked row.
			ingestedAt: CH.argMax(
				$.IngestedAt,
				CH.compileFnCall<unknown>("tuple", $.SearchType.eq(SEARCH_TYPE_WEB_COMPLETE), $.IngestedAt),
			),
		}))
		.where(($) => dailyWhere($, grain, {}, startParam, "rowsAndMarkers"))
		.groupBy("date")
}

/**
 * The rows of each day's newest complete import. Rows of a later import that failed before its
 * markers also pass: the table replaces a key's older version on merge, so the complete import's
 * row for that key may already be gone, and the newer one stands in. Copies of one row (an ingest
 * retry) collapse in the GROUP BY.
 */
function latestRows(
	grain: SearchConsoleGrain,
	filters: SearchConsoleFilters = {},
	startParam: "startDate" | "previousStartDate" = "startDate",
) {
	return from(Datasources.searchConsoleDaily)
		.innerJoinQuery(newestImports(grain, startParam), "newest", (row, newest) => row.Date.eq(newest.date))
		.select(($) => ({
			date: $.Date,
			page: $.Page,
			query: $.Query,
			country: $.Country,
			device: $.Device,
			clicks: CH.argMax($.Clicks, $.IngestedAt),
			impressions: CH.argMax($.Impressions, $.IngestedAt),
			positionSum: CH.argMax($.PositionSum, $.IngestedAt),
		}))
		.where(($) => [...dailyWhere($, grain, filters, startParam), $.IngestedAt.gte($.newest.ingestedAt)])
		.groupBy("date", "page", "query", "country", "device")
}

/** `numerator / denominator`, 0 when the denominator is 0 (nan or inf otherwise). */
function ratio(numerator: CH.Expr<number | null>, denominator: CH.Expr<number | null>): CH.Expr<number> {
	return CH.ifNull(CH.ifNotFinite(numerator.div(denominator), 0), CH.lit(0))
}

/** A sum that reads 0, not NULL, so the row decodes as plain numbers. */
const total = (sum: CH.Expr<number | null>): CH.Expr<number> => CH.ifNull(sum, CH.lit(0))

/** The four metrics over the grouped rows. Position is impression-weighted, so sum / impressions. */
type Sums = {
	readonly clicks: CH.Expr<number | null>
	readonly impressions: CH.Expr<number | null>
	readonly positionSum: CH.Expr<number | null>
}

const metrics = (sums: Sums) => ({
	clicks: total(sums.clicks),
	impressions: total(sums.impressions),
	ctr: ratio(sums.clicks, sums.impressions),
	position: ratio(sums.positionSum, sums.impressions),
})

export interface SearchConsoleOverviewOutput {
	readonly clicks: number
	readonly impressions: number
	readonly ctr: number
	/** Average position, 0 when there were no impressions. Lower is better. */
	readonly position: number
	readonly previousClicks: number
	readonly previousImpressions: number
	readonly previousCtr: number
	readonly previousPosition: number
}

/**
 * Totals for the window and the equal-length period before it, from the site grain, in one
 * scan. Params: orgId, siteUrl, previousStartDate, startDate, endDate.
 */
export function searchConsoleOverviewQuery() {
	return fromQuery(latestRows("site", {}, "previousStartDate"), "latest")
		.select(($) => {
			const current = $.date.gte(utcSecondsParam("startDate"))
			const previous = CH.not(current)
			const now = metrics({
				clicks: CH.sumIf($.clicks, current),
				impressions: CH.sumIf($.impressions, current),
				positionSum: CH.sumIf($.positionSum, current),
			})
			const before = metrics({
				clicks: CH.sumIf($.clicks, previous),
				impressions: CH.sumIf($.impressions, previous),
				positionSum: CH.sumIf($.positionSum, previous),
			})
			return {
				clicks: now.clicks,
				impressions: now.impressions,
				ctr: now.ctr,
				position: now.position,
				previousClicks: before.clicks,
				previousImpressions: before.impressions,
				previousCtr: before.ctr,
				previousPosition: before.position,
			}
		})
		.format("JSON")
		.route("ingest")
}

export interface SearchConsoleTimeseriesOutput {
	/** Midnight UTC of Google's (Pacific) day. */
	readonly date: DateTime.Utc
	readonly clicks: number
	readonly impressions: number
	readonly ctr: number
	readonly position: number
}

/**
 * Daily totals from the site grain, one point per imported day: a day whose newest complete import
 * Google answered empty is a zero point, not a gap. Params: orgId, siteUrl, startDate, endDate.
 */
export function searchConsoleTimeseriesQuery() {
	const daily = fromQuery(latestRows("site"), "latest")
		.select(($) => ({
			date: $.date,
			clicks: CH.sum($.clicks),
			impressions: CH.sum($.impressions),
			positionSum: CH.sum($.positionSum),
		}))
		.groupBy("date")
	return fromQuery(newestImports("site", "startDate"), "days")
		.leftJoinQuery(daily, "daily", (day, totals) => day.date.eq(totals.date))
		.select(($) => ({
			date: $.date,
			...metrics({
				clicks: $.daily.clicks,
				impressions: $.daily.impressions,
				positionSum: $.daily.positionSum,
			}),
		}))
		.orderBy(["date", "asc"])
		.format("JSON")
		.route("ingest")
}

export interface SearchConsoleSortOpts {
	readonly sortBy?: SearchConsoleSortKey
	/** Defaults to descending, except position, where lower is better. */
	readonly sortDir?: "asc" | "desc"
	readonly limit?: number
}

export interface SearchConsoleListOpts extends SearchConsoleFilters, SearchConsoleSortOpts {}

/** The page grain has no query, country or device, so a page list narrows by page only. */
export interface SearchConsolePageListOpts extends SearchConsoleSortOpts {
	/** A full page URL. */
	readonly page?: string
}

const sortDirOf = (opts: SearchConsoleSortOpts): "asc" | "desc" =>
	opts.sortDir ?? (opts.sortBy === "position" ? "asc" : "desc")

/**
 * What ranks rows tied on the sorted metric: the busier one first. Most queries of a young site
 * tie at zero clicks, and an alphabetical tie-break buries the ones people actually see.
 */
const tieBreakOf = (sortBy: SearchConsoleSortKey): "clicks" | "impressions" =>
	sortBy === "impressions" ? "clicks" : "impressions"

export interface SearchConsoleTopQueriesOutput {
	readonly query: string
	readonly clicks: number
	readonly impressions: number
	readonly ctr: number
	readonly position: number
}

/** Queries from the query grain (Google drops anonymized ones). Params: orgId, siteUrl, startDate, endDate. */
export function searchConsoleTopQueriesQuery(opts: SearchConsoleListOpts = {}) {
	const sortBy = opts.sortBy ?? "clicks"
	return fromQuery(latestRows("query", opts), "latest")
		.select(($) => ({
			query: $.query,
			...metrics({
				clicks: CH.sum($.clicks),
				impressions: CH.sum($.impressions),
				positionSum: CH.sum($.positionSum),
			}),
		}))
		.groupBy("query")
		.orderBy([sortBy, sortDirOf(opts)], [tieBreakOf(sortBy), "desc"], ["query", "asc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
		.route("ingest")
}

export interface SearchConsoleTopPagesOutput {
	/** The full URL Google reports. */
	readonly page: string
	readonly clicks: number
	readonly impressions: number
	/** Kept so a caller can re-aggregate pages that normalise to one path. */
	readonly positionSum: number
	readonly ctr: number
	readonly position: number
}

/** Pages from the page grain. Params: orgId, siteUrl, startDate, endDate. */
export function searchConsoleTopPagesQuery(opts: SearchConsolePageListOpts = {}) {
	const sortBy = opts.sortBy ?? "clicks"
	return fromQuery(latestRows("page", { page: opts.page }), "latest")
		.select(($) => ({
			page: $.page,
			positionSum: total(CH.sum($.positionSum)),
			...metrics({
				clicks: CH.sum($.clicks),
				impressions: CH.sum($.impressions),
				positionSum: CH.sum($.positionSum),
			}),
		}))
		.groupBy("page")
		.orderBy([sortBy, sortDirOf(opts)], [tieBreakOf(sortBy), "desc"], ["page", "asc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
		.route("ingest")
}

/** Landing pages for the combined table: the page grain by URL, most clicked first by default. */
export function searchConsoleLandingPagesQuery(opts: SearchConsoleSortOpts = {}) {
	const sortBy = opts.sortBy ?? "clicks"
	return searchConsoleTopPagesQuery({
		sortBy,
		sortDir: sortDirOf({ ...opts, sortBy }),
		limit: opts.limit ?? 100,
	})
}

/** A ClickHouse string literal: backslashes first, then quotes, so an escape cannot be undone. */
const sqlString = (value: string): string =>
	`'${Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(value))}'`

/**
 * Hand-written `run_sql` text for one query's daily clicks, impressions and position, read like
 * the query list: each day from its newest complete (marked) import, each key at its newest
 * version from then on. Uses the `run_sql` macros `$__orgFilter`, `$__startTime`, `$__endTime`.
 */
export const searchConsoleQueryTrendSql = (siteUrl: string, query: string): string => {
	const where = `WHERE $__orgFilter AND SiteUrl = ${sqlString(siteUrl)} AND Grain = 'query' AND Date >= toStartOfDay($__startTime) AND Date <= $__endTime`
	return (
		"SELECT Date, sum(keyClicks) AS clicks, sum(keyImpressions) AS impressions, " +
		"round(sum(keyPositionSum) / sum(keyImpressions), 1) AS position FROM (" +
		"SELECT Date, Page, Country, Device, argMax(Clicks, IngestedAt) AS keyClicks, " +
		"argMax(Impressions, IngestedAt) AS keyImpressions, argMax(PositionSum, IngestedAt) AS keyPositionSum " +
		"FROM search_console_daily INNER JOIN (" +
		`SELECT Date AS completeDate, argMax(IngestedAt, (SearchType = '${SEARCH_TYPE_WEB_COMPLETE}', IngestedAt)) AS completeAt ` +
		`FROM search_console_daily ${where} AND SearchType IN ('${SEARCH_TYPE_WEB}', '${SEARCH_TYPE_WEB_COMPLETE}') GROUP BY completeDate` +
		") AS complete ON Date = complete.completeDate " +
		`${where} AND SearchType = '${SEARCH_TYPE_WEB}' AND Query = ${sqlString(query)} AND IngestedAt >= complete.completeAt ` +
		"GROUP BY Date, Page, Country, Device) GROUP BY Date ORDER BY Date"
	)
}
