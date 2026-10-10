import type { Expr } from "@maple-dev/effect-orm/expr"
import * as CH from "@maple-dev/effect-orm/expr"
import { compile } from "@maple-dev/effect-orm/sql"

/** Prefix of the stored name of an HTTP server span: `http.server GET`. */
export const HTTP_SERVER_SPAN_PREFIX = "http.server "

/** Stored names that are a bare HTTP method. */
export const HTTP_METHOD_SPAN_NAMES = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const

/** The stored names {@link normalizedSpanNameExpr} can rewrite; every other name is its own display name. */
export const isHttpSpanName = (spanName: Expr<string>) =>
	spanName.like(`${HTTP_SERVER_SPAN_PREFIX}%`).or(spanName.in_(...HTTP_METHOD_SPAN_NAMES))

/**
 * Canonical operation-name expression shared by runtime queries and generated
 * trace rollup SQL. HTTP server spans become `METHOD /route`; every other span,
 * including internal operations, keeps its original name.
 */
export function normalizedSpanNameExpr(
	spanName: Expr<string>,
	route: Expr<string>,
	urlPath: Expr<string>,
): Expr<string> {
	return CH.if_(
		isHttpSpanName(spanName).and(route.neq("").or(urlPath.neq(""))),
		CH.concat(
			CH.if_(
				spanName.like(`${HTTP_SERVER_SPAN_PREFIX}%`),
				CH.replaceOne(spanName, HTTP_SERVER_SPAN_PREFIX, ""),
				spanName,
			),
			CH.lit(" "),
			CH.if_(route.neq(""), route, urlPath),
		),
		spanName,
	)
}

const spanAttributes = CH.dynamicColumn<Record<string, string>>("SpanAttributes")

/** SQL text required by Tinybird materialization and ClickHouse migration DDL. */
export const NORMALIZED_SPAN_NAME_SQL = compile(
	normalizedSpanNameExpr(
		CH.dynamicColumn<string>("SpanName"),
		CH.mapGet(spanAttributes, "http.route"),
		CH.mapGet(spanAttributes, "url.path"),
	).toFragment(),
)
