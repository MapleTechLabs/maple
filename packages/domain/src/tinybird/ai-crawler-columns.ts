// SQL for the `ai_crawler_requests` view: which Server spans are AI crawler
// fetches, and the request facts it keeps from them. Compiled from the catalog
// in `../ai-traffic.ts` so the write filter and the read-side labels share one list.

import type { Expr } from "@maple-dev/effect-clickhouse/expr"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import { compile } from "@maple-dev/effect-clickhouse/sql"
import { AI_CRAWLERS } from "../ai-traffic"

interface MapColumnLike {
	get(key: string): Expr<string>
}

const spanAttributes: MapColumnLike = {
	get: (key) => CH.mapGet(CH.dynamicColumn<Record<string, string>>("SpanAttributes"), key),
}

const stringArray = (values: ReadonlyArray<string>) => CH.arrayOf(...values.map((value) => CH.lit(value)))

/** First non-empty of the given expressions, else `''`. */
const firstNonEmpty = (...values: ReadonlyArray<Expr<string>>): Expr<string> =>
	CH.coalesce(...values.map((value) => CH.nullIf(value, "")), CH.lit(""))

/** `user_agent.original`, or the pre-1.26 semconv `http.user_agent`. */
export function userAgentExpr(attrs: MapColumnLike): Expr<string> {
	return firstNonEmpty(attrs.get("user_agent.original"), attrs.get("http.user_agent"))
}

/** 1-based index into {@link AI_CRAWLERS} of the crawler named in the user agent, 0 for none. */
export function aiCrawlerIndexExpr(attrs: MapColumnLike): Expr<number> {
	return CH.compileFnCall<number>(
		"multiSearchFirstIndexCaseInsensitive",
		userAgentExpr(attrs),
		stringArray(AI_CRAWLERS.map((crawler) => crawler.token)),
	)
}

/** The crawler's display name, `''` when the user agent names none. */
export function aiCrawlerNameExpr(attrs: MapColumnLike): Expr<string> {
	return CH.arrayElement(stringArray(AI_CRAWLERS.map((crawler) => crawler.name)), aiCrawlerIndexExpr(attrs))
}

/** Request host without a port: `server.address`, then the legacy and URL spellings. */
export function requestHostExpr(attrs: MapColumnLike): Expr<string> {
	return CH.lower_(
		CH.compileFnCall<string>(
			"replaceRegexpOne",
			firstNonEmpty(
				attrs.get("server.address"),
				attrs.get("http.host"),
				attrs.get("net.host.name"),
				CH.domain_(attrs.get("url.full")),
				CH.domain_(attrs.get("http.url")),
			),
			":[0-9]+$",
			"",
		),
	)
}

/** Longest path kept. Paths are a free-form dimension, so they get a bound. */
export const REQUEST_PATH_MAX = 512

/** Request path without query or fragment: `url.path`, then `http.target`, then the full URL. */
export function requestPathExpr(attrs: MapColumnLike): Expr<string> {
	// Cut in characters, not bytes: `url.path` can hold decoded UTF-8.
	return CH.compileFnCall<string>(
		"leftUTF8",
		firstNonEmpty(
			attrs.get("url.path"),
			CH.compileFnCall<string>("replaceRegexpOne", attrs.get("http.target"), "[?#].*$", ""),
			CH.path_(attrs.get("url.full")),
			CH.path_(attrs.get("http.url")),
		),
		REQUEST_PATH_MAX,
	)
}

/** HTTP response status, 0 when the span carries none. */
export function responseStatusExpr(attrs: MapColumnLike): Expr<number> {
	return CH.toUInt16OrZero(
		firstNonEmpty(attrs.get("http.response.status_code"), attrs.get("http.status_code")),
	)
}

const sql = (expr: Expr<unknown>) => compile(expr.toFragment())

export const AI_CRAWLER_INDEX_SQL = sql(aiCrawlerIndexExpr(spanAttributes))
export const AI_CRAWLER_NAME_SQL = sql(aiCrawlerNameExpr(spanAttributes))
export const REQUEST_HOST_SQL = sql(requestHostExpr(spanAttributes))
export const REQUEST_PATH_SQL = sql(requestPathExpr(spanAttributes))
export const RESPONSE_STATUS_SQL = sql(responseStatusExpr(spanAttributes))
