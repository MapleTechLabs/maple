// SQL for the HTTP server facts the API tab reads off `service_operations_*` and
// `service_endpoint_details_hourly`. Literal SQL rather than DSL nodes: the same
// text must appear in the views, the frozen migration DDL and the raw edge
// branches, and the status expression is byte-identical to `trace_list_mv`'s.
import { compile } from "@maple-dev/effect-orm/sql"
import * as CH from "@maple-dev/effect-orm/expr"
import { userAgentExpr } from "./ai-crawler-columns"

/** Response status as written: legacy `http.status_code` first, `''` when absent. */
export const HTTP_STATUS_CODE_SQL =
	"if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code'])"

/** Request body bytes, NULL when the span carries none or an unparseable value. */
export const REQUEST_BODY_SIZE_SQL =
	"toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length']))"

/** Only a span that served the request counts: outbound calls share the endpoint name. */
export const HTTP_SERVER_SPAN_SQL = "SpanKind = 'Server'"

/** `user_agent.original`, or the pre-1.26 `http.user_agent`. */
export const USER_AGENT_SQL = compile(
	userAgentExpr({
		get: (key) => CH.mapGet(CH.dynamicColumn<Record<string, string>>("SpanAttributes"), key),
	}).toFragment(),
)

const status = `toUInt16OrZero(${HTTP_STATUS_CODE_SQL})`

/**
 * The six HTTP measures on `service_operations_minutely`, as one projection so the
 * view and every raw edge branch compute them identically.
 */
export const SERVICE_OPERATIONS_HTTP_MEASURES = {
	HttpClassifiedSpanCount: "count()",
	HttpStatusCount: `countIf(${HTTP_SERVER_SPAN_SQL} AND ${HTTP_STATUS_CODE_SQL} != '')`,
	Http4xxCount: `countIf(${HTTP_SERVER_SPAN_SQL} AND ${status} BETWEEN 400 AND 499)`,
	Http5xxCount: `countIf(${HTTP_SERVER_SPAN_SQL} AND ${status} BETWEEN 500 AND 599)`,
	RequestBodyBytes: `sumIf(ifNull(${REQUEST_BODY_SIZE_SQL}, 0), ${HTTP_SERVER_SPAN_SQL} AND ${REQUEST_BODY_SIZE_SQL} IS NOT NULL)`,
	RequestBodyCount: `countIf(${HTTP_SERVER_SPAN_SQL} AND ${REQUEST_BODY_SIZE_SQL} IS NOT NULL)`,
} as const
