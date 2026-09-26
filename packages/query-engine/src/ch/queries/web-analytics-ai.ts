// The Web Analytics AI tab. Two sources with different reach:
// - referrals: browser sessions whose referrer or `utm_source` names an AI
//   product, read from `session_replays` under the page's normal filters;
// - crawls: `ai_crawler_requests`, Server spans from AI fetchers, which never
//   run the browser SDK. Only `host` / `pagePath` narrow them.

import * as CH from "@maple-dev/effect-clickhouse/expr"
import { Schema } from "effect"
import { param, from, compileFnCall, compileTypedFnCall } from "@maple-dev/effect-clickhouse"
import type { CHQuery, ColumnAccessor } from "@maple-dev/effect-clickhouse"
import { AI_PRODUCTS } from "@maple/domain/ai-traffic"
import { AiCrawlerRequests, SessionReplays } from "../tables"
import { replaysWhere, type WebAnalyticsFilters } from "./web-analytics"

const stringArray = (values: ReadonlyArray<string>) => CH.arrayOf(...values.map((value) => CH.lit(value)))

/** `transform(value, from, to, '')`: an exact-match lookup table. */
function lookup(value: CH.Expr<string>, pairs: ReadonlyArray<readonly [string, string]>): CH.Expr<string> {
	return compileTypedFnCall<string>(
		"transform",
		Schema.String,
		value,
		stringArray(pairs.map(([key]) => key)),
		stringArray(pairs.map(([, id]) => id)),
		CH.lit(""),
	)
}

const REFERRER_PAIRS = AI_PRODUCTS.flatMap((product) =>
	product.referrerHosts.map((host) => [host, product.id] as const),
)
const UTM_PAIRS = AI_PRODUCTS.flatMap((product) =>
	product.utmSources.map((source) => [source, product.id] as const),
)

const normalizedReferrer = (referrerHost: CH.Expr<string>) =>
	compileFnCall<string>("replaceRegexpOne", CH.lower_(referrerHost), "^www\\.", "")

/**
 * The AI product a session came from, `''` for none. The referrer wins; the
 * UTM tag covers the ChatGPT links that arrive with no referrer at all.
 */
export function aiReferralProductExpr(referrerHost: CH.Expr<string>, utmSource: CH.Expr<string>) {
	const byReferrer = lookup(normalizedReferrer(referrerHost), REFERRER_PAIRS)
	return CH.if_(byReferrer.neq(""), byReferrer, lookup(CH.lower_(utmSource), UTM_PAIRS))
}

/** Same population as `aiReferralProductExpr(...) != ''`, as two cheap set tests. */
function isAiReferral(referrerHost: CH.Expr<string>, utmSource: CH.Expr<string>): CH.Condition {
	return CH.inList(
		normalizedReferrer(referrerHost),
		REFERRER_PAIRS.map(([host]) => host),
	).or(
		CH.inList(
			CH.lower_(utmSource),
			UTM_PAIRS.map(([source]) => source),
		),
	)
}

// AI referrals

export interface WebAnalyticsAiReferralsOpts extends WebAnalyticsFilters {
	readonly bucketSeconds?: number
}

export interface WebAnalyticsAiReferralsOutput {
	readonly bucket: string
	readonly product: string
	readonly sessions: number
}

/**
 * Sessions sent by each AI product, per bucket. Bucketed on `StartTime` like the
 * visitor timeseries, so a session lands in one bucket and per-product totals are
 * the sum of the buckets.
 */
export function webAnalyticsAiReferralsQuery(
	opts: WebAnalyticsAiReferralsOpts = {},
): CHQuery<any, WebAnalyticsAiReferralsOutput, any> {
	const bucketSeconds = opts.bucketSeconds ?? 3600
	return from(SessionReplays)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.StartTime, bucketSeconds),
			product: aiReferralProductExpr($.ReferrerHost, $.UtmSource),
			// uniq, not count: an un-merged session has a v1 and a v2 row.
			sessions: CH.uniq($.SessionId),
		}))
		.where(($) => [...replaysWhere($, opts), isAiReferral($.ReferrerHost, $.UtmSource)])
		.groupBy("bucket", "product")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// AI crawlers

type CrawlerAccessor = ColumnAccessor<typeof AiCrawlerRequests.columns>

/** Crawler filters: the time window plus the two URL filters a request carries. */
export type WebAnalyticsAiCrawlerFilters = Pick<WebAnalyticsFilters, "host" | "pagePath">

function crawlerWhere($: CrawlerAccessor, filters: WebAnalyticsAiCrawlerFilters) {
	return [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTimeString("startTime")),
		$.Timestamp.lte(param.dateTimeString("endTime")),
		CH.when(filters.host, (v: string) => $.Host.eq(v)),
		CH.when(filters.pagePath, (v: string) => $.Path.eq(v)),
	]
}

/** A fetch the site answered. Scanners borrowing crawler user agents mostly get 404s. */
const served = ($: CrawlerAccessor) => $.HttpStatus.lt(400)

/** One page per host + path, so two sites sharing a path count twice. */
const pageKey = ($: CrawlerAccessor) => CH.concat($.Host, $.Path)

export interface WebAnalyticsAiCrawlersOutput {
	readonly crawler: string
	readonly requests: number
	readonly failedRequests: number
	/** Distinct pages served (status below 400). */
	readonly pages: number
	readonly lastSeen: string
}

/** Requests, failures and pages served per crawler. */
export function webAnalyticsAiCrawlersQuery(
	filters: WebAnalyticsAiCrawlerFilters = {},
): CHQuery<any, WebAnalyticsAiCrawlersOutput, any> {
	return from(AiCrawlerRequests)
		.select(($) => ({
			crawler: $.Crawler,
			requests: CH.uniq($.TraceId),
			failedRequests: CH.uniqIf($.TraceId, CH.not(served($))),
			pages: CH.uniqIf(pageKey($), served($)),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => crawlerWhere($, filters))
		.groupBy("crawler")
		.orderBy(["requests", "desc"])
		.format("JSON")
}

/**
 * The document type a path names: Markdown, `llms.txt`, an HTML page (no
 * extension in the last segment, or `.html`), or anything else.
 */
export function aiContentFormatExpr(path: CH.Expr<string>): CH.Expr<string> {
	const lowered = CH.lower_(path)
	return CH.multiIf(
		[
			[CH.matchCond(lowered, "\\.(md|mdx|markdown)$"), CH.lit("markdown")],
			[CH.matchCond(lowered, "(^|/)llms(-full)?\\.txt$"), CH.lit("llms")],
			[CH.matchCond(lowered, "(/[^/.]*|\\.html?)$"), CH.lit("html")],
		],
		CH.lit("other"),
	)
}

export interface WebAnalyticsAiCrawlerFormatsOutput {
	readonly format: string
	readonly requests: number
	readonly failedRequests: number
	readonly pages: number
	readonly crawlers: ReadonlyArray<string>
}

/** Crawler requests by document type, with the crawlers that asked for each. */
export function webAnalyticsAiCrawlerFormatsQuery(
	filters: WebAnalyticsAiCrawlerFilters = {},
): CHQuery<any, WebAnalyticsAiCrawlerFormatsOutput, any> {
	return from(AiCrawlerRequests)
		.select(($) => ({
			format: aiContentFormatExpr($.Path),
			requests: CH.uniq($.TraceId),
			failedRequests: CH.uniqIf($.TraceId, CH.not(served($))),
			pages: CH.uniqIf(pageKey($), served($)),
			crawlers: CH.arraySort(CH.groupUniqArray($.Crawler)),
		}))
		.where(($) => crawlerWhere($, filters))
		.groupBy("format")
		.format("JSON")
}

export interface WebAnalyticsAiCrawledPagesOpts extends WebAnalyticsAiCrawlerFilters {
	readonly limit?: number
}

export interface WebAnalyticsAiCrawledPagesOutput {
	readonly host: string
	readonly path: string
	readonly requests: number
	readonly crawlers: ReadonlyArray<string>
	readonly lastSeen: string
}

/** The pages AI crawlers read most, served fetches only. */
export function webAnalyticsAiCrawledPagesQuery(
	opts: WebAnalyticsAiCrawledPagesOpts = {},
): CHQuery<any, WebAnalyticsAiCrawledPagesOutput, any> {
	return from(AiCrawlerRequests)
		.select(($) => ({
			host: $.Host,
			path: $.Path,
			requests: CH.uniq($.TraceId),
			crawlers: CH.arraySort(CH.groupUniqArray($.Crawler)),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [...crawlerWhere($, opts), served($)])
		.groupBy("host", "path")
		.orderBy(["requests", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}
