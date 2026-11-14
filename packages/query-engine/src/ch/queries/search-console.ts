// Google Search Console performance from `search_console_daily`. The table holds three grains
// (site totals, per page, per query) that must never be summed together. Every read keeps only the
// newest import of each day (rows whose IngestedAt is that day's max), since a re-fetched day can
// lose keys an older import still holds. Pinned to the managed route: written through `ingest` only.

import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, fromQuery, param } from "@maple-dev/effect-orm/clickhouse"
import type { ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "../tables"

export type SearchConsoleGrain = "site" | "page" | "query"

/** The only search type the importer writes today. */
const SEARCH_TYPE_WEB = "web"

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
) {
	return [
		$.OrgId.eq(orgIdParam),
		$.SiteUrl.eq(param.string("siteUrl")),
		$.Grain.eq(grain),
		$.SearchType.eq(SEARCH_TYPE_WEB),
		$.Date.gte(utcSecondsParam(startParam)),
		$.Date.lte(utcSecondsParam("endDate")),
		CH.when(filters.country, (v: string) => $.Country.eq(v)),
		CH.when(filters.device, (v: string) => $.Device.eq(v)),
		CH.when(filters.page, (v: string) => $.Page.eq(v)),
		CH.when(filters.query, (v: string) => $.Query.eq(v)),
	]
}

/** Each day's newest import for the grain, unfiltered: an import replaces the whole day. */
function newestImports(grain: SearchConsoleGrain, startParam: "startDate" | "previousStartDate") {
	return from(Datasources.searchConsoleDaily)
		.select(($) => ({ date: $.Date, ingestedAt: CH.max_($.IngestedAt) }))
		.where(($) => dailyWhere($, grain, {}, startParam))
		.groupBy("date")
}

/** The rows of each day's newest import; copies of one row (an ingest retry) collapse in the GROUP BY. */
function latestRows(
	grain: SearchConsoleGrain,
	filters: SearchConsoleFilters = {},
	startParam: "startDate" | "previousStartDate" = "startDate",
) {
	return from(Datasources.searchConsoleDaily)
		.innerJoinQuery(newestImports(grain, startParam), "newest", (row, newest) =>
			row.Date.eq(newest.date).and(row.IngestedAt.eq(newest.ingestedAt)),
		)
		.select(($) => ({
			date: $.Date,
			page: $.Page,
			query: $.Query,
			country: $.Country,
			device: $.Device,
			clicks: CH.max_($.Clicks),
			impressions: CH.max_($.Impressions),
			positionSum: CH.max_($.PositionSum),
		}))
		.where(($) => dailyWhere($, grain, filters, startParam))
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

/** Daily totals from the site grain. Params: orgId, siteUrl, startDate, endDate. */
export function searchConsoleTimeseriesQuery() {
	return fromQuery(latestRows("site"), "latest")
		.select(($) => ({
			date: $.date,
			...metrics({
				clicks: CH.sum($.clicks),
				impressions: CH.sum($.impressions),
				positionSum: CH.sum($.positionSum),
			}),
		}))
		.groupBy("date")
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
