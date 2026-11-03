// Service API tab: per-endpoint detail off `service_endpoint_details_hourly`
// (migration 0048). Status/error.type breakdown, latency and body distributions,
// top user agents and the slowest requests.
//
// Deliberately approximate, like `serviceHealthSnapshot`: one hour-grain tier
// with both window ends floored to the hour, so the leading and trailing partial
// hours count whole. No raw edge, so nothing here splices and the boundary gate
// never applies. The rollup holds Server spans with a response status only.

import { Schema, type DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { CHNumber } from "../schema"
import { DateTimeUtcFromWarehouse, DateTimeUtcFromWarehouse64 } from "../../datetime"
import { ServiceEndpointDetailsHourly, orgIdParam } from "../tables"
import { utcHourFloor } from "./query-helpers"
import { httpEndpointCondition } from "./service-operations"

export interface ServiceEndpointDetailsScopeOpts {
	readonly serviceName: string
	readonly environments?: readonly string[]
}

type DetailColumns = ColumnAccessor<typeof ServiceEndpointDetailsHourly.columns>

const scopeConditions = ($: DetailColumns, opts: ServiceEndpointDetailsScopeOpts) => [
	$.OrgId.eq(orgIdParam),
	$.ServiceName.eq(opts.serviceName),
	$.Hour.gte(utcHourFloor("startTime")),
	$.Hour.lte(utcHourFloor("endTime")),
	opts.environments?.length ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
]

// D. Status code x error.type breakdown

export interface ServiceEndpointStatusBreakdownOpts extends ServiceEndpointDetailsScopeOpts {
	/** One endpoint; omitted means every HTTP endpoint of the service. */
	readonly spanName?: string
	readonly limit?: number
}

export interface ServiceEndpointStatusBreakdownOutput {
	readonly spanName: string
	readonly httpStatusCode: string
	readonly errorType: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
}

export const serviceEndpointStatusBreakdownRowSchema = Schema.Struct({
	spanName: Schema.String,
	httpStatusCode: Schema.String,
	errorType: Schema.String,
	spanCount: CHNumber,
	estimatedSpanCount: CHNumber,
})

export function serviceEndpointStatusBreakdownQuery(opts: ServiceEndpointStatusBreakdownOpts) {
	return from(ServiceEndpointDetailsHourly)
		.select(($) => ({
			spanName: $.SpanName,
			httpStatusCode: $.HttpStatusCode,
			errorType: $.ErrorType,
			spanCount: CH.sum($.SpanCount),
			estimatedSpanCount: CH.sum($.EstimatedSpanCount),
		}))
		.where(($) => [
			...scopeConditions($, opts),
			opts.spanName !== undefined
				? $.SpanName.eq(opts.spanName)
				: httpEndpointCondition($.SpanName, true),
		])
		.groupBy("spanName", "httpStatusCode", "errorType")
		.orderBy(["spanCount", "desc"], ["spanName", "asc"], ["httpStatusCode", "asc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// E1. One endpoint's distributions and top user agents

/** Latency levels the detail panel draws; finalize-time, so any set reads the stored digests. */
export const ENDPOINT_LATENCY_QUANTILE_LEVELS = [
	0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 0.999,
] as const

export interface ServiceEndpointDetailOpts extends ServiceEndpointDetailsScopeOpts {
	readonly spanName: string
}

export interface ServiceEndpointDistributionOutput {
	readonly spanCount: number
	readonly latencyQuantilesMs: ReadonlyArray<number>
	readonly bodyCount: number
	readonly bodyP50Bytes: number
	readonly bodyP95Bytes: number
	readonly bodyMaxBytes: number
	readonly userAgents: ReadonlyArray<string>
	readonly userAgentCounts: ReadonlyArray<number>
}

export const serviceEndpointDistributionRowSchema = Schema.Struct({
	spanCount: CHNumber,
	latencyQuantilesMs: Schema.Array(CHNumber),
	bodyCount: CHNumber,
	bodyP50Bytes: CHNumber,
	bodyP95Bytes: CHNumber,
	bodyMaxBytes: CHNumber,
	userAgents: Schema.Array(Schema.String),
	userAgentCounts: Schema.Array(CHNumber),
})

const LATENCY_LEVELS_SQL = ENDPOINT_LATENCY_QUANTILE_LEVELS.join(", ")
// An agent-less span still takes an approx_top_k slot as ''; it is not an agent.
const TOP_AGENTS_SQL = "arrayFilter(x -> x.1 != '', approx_top_kMerge(10)(UserAgents))"

/** Always one row: no GROUP BY, so an endpoint with no traffic reads as zeros. */
export function serviceEndpointDistributionQuery(opts: ServiceEndpointDetailOpts) {
	return from(ServiceEndpointDetailsHourly)
		.select(($) => ({
			spanCount: CH.sum($.SpanCount),
			latencyQuantilesMs: CH.rawExpr<ReadonlyArray<number>>(
				`if(sum(SpanCount) > 0, arrayMap(x -> x / 1000000, quantilesTDigestMerge(${LATENCY_LEVELS_SQL})(DurationQuantiles)), [])`,
				T.array(T.float64),
			),
			bodyCount: CH.sum($.BodyCount),
			bodyP50Bytes: CH.rawExpr(
				"if(sum(BodyCount) > 0, arrayElement(quantilesTDigestIfMerge(0.5, 0.95)(BodySizeQuantiles), 1), 0)",
				T.float64,
			),
			bodyP95Bytes: CH.rawExpr(
				"if(sum(BodyCount) > 0, arrayElement(quantilesTDigestIfMerge(0.5, 0.95)(BodySizeQuantiles), 2), 0)",
				T.float64,
			),
			bodyMaxBytes: CH.max_($.BodySizeMax),
			userAgents: CH.rawExpr<ReadonlyArray<string>>(
				`arrayMap(x -> x.1, ${TOP_AGENTS_SQL})`,
				T.array(T.string),
			),
			userAgentCounts: CH.rawExpr<ReadonlyArray<number>>(
				`arrayMap(x -> x.2, ${TOP_AGENTS_SQL})`,
				T.array(T.uint64),
			),
		}))
		.where(($) => [...scopeConditions($, opts), $.SpanName.eq(opts.spanName)])
		.format("JSON")
}

// E2. One endpoint's slowest requests

export interface ServiceEndpointSlowestOpts extends ServiceEndpointDetailOpts {
	readonly limit?: number
}

export interface ServiceEndpointSlowestOutput {
	readonly hour: DateTime.Utc
	readonly traceId: string
	readonly timestamp: DateTime.Utc
	readonly durationMs: number
	readonly httpStatusCode: string
	/** -1 when the request carried no body size. */
	readonly bodyBytes: number
}

export const serviceEndpointSlowestRowSchema = Schema.Struct({
	hour: DateTimeUtcFromWarehouse,
	traceId: Schema.String,
	timestamp: DateTimeUtcFromWarehouse64,
	durationMs: CHNumber,
	httpStatusCode: Schema.String,
	bodyBytes: CHNumber,
})

/**
 * The rollup keeps one slowest request per (hour, status, error.type, env) row;
 * merging per (hour, status) and taking the top `limit` gives the slowest few
 * without reading a raw span. Two of them never come from the same hour and status.
 */
export function serviceEndpointSlowestQuery(opts: ServiceEndpointSlowestOpts) {
	return from(ServiceEndpointDetailsHourly)
		.select(($) => ({
			hour: $.Hour,
			httpStatusCode: $.HttpStatusCode,
			traceId: CH.rawExpr("argMaxMerge(SlowestTraceId)", T.string),
			timestamp: CH.rawExpr("toDateTime64(argMaxMerge(SlowestTimestamp), 3)", T.dateTime64),
			durationMs: CH.rawExpr("max(SlowestDuration) / 1000000", T.float64),
			bodyBytes: CH.rawExpr("argMaxMerge(SlowestBodySize)", T.int64),
		}))
		.where(($) => [...scopeConditions($, opts), $.SpanName.eq(opts.spanName)])
		.groupBy("hour", "httpStatusCode")
		.orderBy(["durationMs", "desc"])
		.limit(opts.limit ?? 5)
		.format("JSON")
}
