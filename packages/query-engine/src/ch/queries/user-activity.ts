// Per end user reads for the `/users` pages. Counts come from `user_activity_hourly` (migration
// 0056), one hour-grain tier floored to whole hours like `serviceEndpointDetails*`, so nothing
// splices. Raw trace and log reads take the services and window its slices name, so the sort-key
// prefix prunes instead of a full-range attribute bloom scan.

import { Schema, type DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { CHNumber } from "../schema"
import { DateTimeUtcFromWarehouse, DateTimeUtcFromWarehouse64 } from "../../datetime"
import { Logs, Traces, UserActivityHourly, orgIdParam, utcSecondsParam } from "../tables"
import { utcHourFloor } from "./query-helpers"

/** The page's namespace scope: the org-global pin, else the rail's picks. Empty means all. */
export interface UserNamespaceScope {
	readonly namespaces?: readonly string[]
}

export interface UserScopeOpts extends UserNamespaceScope {
	readonly userId: string
}

type ActivityColumns = ColumnAccessor<typeof UserActivityHourly.columns>
type TraceColumns = ColumnAccessor<typeof Traces.columns>
type LogColumns = ColumnAccessor<typeof Logs.columns>

const NEVER = CH.rawCond("1 = 0")

const namespaceCondition = (column: CH.Expr<string>, scope: UserNamespaceScope) =>
	scope.namespaces?.length ? CH.inList(column, scope.namespaces) : undefined

const activityWindow = ($: ActivityColumns, scope: UserNamespaceScope) => [
	$.OrgId.eq(orgIdParam),
	namespaceCondition($.ServiceNamespace, scope),
	$.Hour.gte(utcHourFloor("startTime")),
	$.Hour.lte(utcHourFloor("endTime")),
]

/** Entry-point latency in ms; an empty digest merges to nan, so a row with no requests reads 0. */
const requestQuantileMs = (index: 1 | 2) =>
	CH.rawExpr(
		`if(sum(RequestCount) > 0, arrayElement(quantilesTDigestIfMerge(0.5, 0.95)(RequestDurationQuantiles), ${index}) / 1000000, 0)`,
		T.float64,
	)

// A. Slices: the (hour, service, namespace) buckets a user was active in

export interface UserActivitySlicesOpts extends UserScopeOpts {
	readonly limit?: number
}

export interface UserActivitySliceOutput {
	readonly hour: DateTime.Utc
	readonly serviceName: string
	readonly serviceNamespace: string
	readonly spanCount: number
	readonly requestCount: number
	readonly logCount: number
}

export const userActivitySliceRowSchema = Schema.Struct({
	hour: DateTimeUtcFromWarehouse,
	serviceName: Schema.String,
	serviceNamespace: Schema.String,
	spanCount: CHNumber,
	requestCount: CHNumber,
	logCount: CHNumber,
})

/** Feeds `userTracesQuery` / `userLogsQuery`: their services and window come from these rows. */
export function userActivitySlicesQuery(opts: UserActivitySlicesOpts) {
	return from(UserActivityHourly)
		.select(($) => ({
			hour: $.Hour,
			serviceName: $.ServiceName,
			serviceNamespace: $.ServiceNamespace,
			spanCount: CH.sum($.SpanCount),
			requestCount: CH.sum($.RequestCount),
			logCount: CH.sum($.LogCount),
		}))
		.where(($) => [...activityWindow($, opts), $.UserId.eq(opts.userId)])
		.groupBy("hour", "serviceName", "serviceNamespace")
		.orderBy(["hour", "desc"], ["serviceName", "asc"])
		.limit(opts.limit ?? 5000)
		.format("JSON")
}

// B. One user's totals, and the services they touched

export interface UserActivitySummaryOutput {
	readonly spanCount: number
	readonly errorSpanCount: number
	readonly requestCount: number
	readonly failedRequestCount: number
	readonly traceCount: number
	readonly sessionCount: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly logCount: number
	readonly warnLogCount: number
	readonly errorLogCount: number
	readonly topRoutes: ReadonlyArray<string>
	readonly topRouteCounts: ReadonlyArray<number>
	readonly firstSeen: DateTime.Utc
	readonly lastSeen: DateTime.Utc
}

export const userActivitySummaryRowSchema = Schema.Struct({
	spanCount: CHNumber,
	errorSpanCount: CHNumber,
	requestCount: CHNumber,
	failedRequestCount: CHNumber,
	traceCount: CHNumber,
	sessionCount: CHNumber,
	p50DurationMs: CHNumber,
	p95DurationMs: CHNumber,
	logCount: CHNumber,
	warnLogCount: CHNumber,
	errorLogCount: CHNumber,
	topRoutes: Schema.Array(Schema.String),
	topRouteCounts: Schema.Array(CHNumber),
	firstSeen: DateTimeUtcFromWarehouse,
	lastSeen: DateTimeUtcFromWarehouse,
})

// Non-entry spans and logs write '' into the top-k; it is not a route.
const TOP_ROUTES_SQL = "arrayFilter(x -> x.1 != '', approx_top_kMerge(10)(TopRoutes))"

/** Always one row: no GROUP BY, so a user with nothing in the window reads as zeros. */
export function userActivitySummaryQuery(opts: UserScopeOpts) {
	return from(UserActivityHourly)
		.select(($) => ({
			spanCount: CH.sum($.SpanCount),
			errorSpanCount: CH.sum($.ErrorSpanCount),
			requestCount: CH.sum($.RequestCount),
			failedRequestCount: CH.sum($.FailedRequestCount),
			traceCount: CH.rawExpr("uniqIfMerge(TraceIds)", T.uint64),
			sessionCount: CH.rawExpr("uniqIfMerge(SessionIds)", T.uint64),
			p50DurationMs: requestQuantileMs(1),
			p95DurationMs: requestQuantileMs(2),
			logCount: CH.sum($.LogCount),
			warnLogCount: CH.sum($.WarnLogCount),
			errorLogCount: CH.sum($.ErrorLogCount),
			topRoutes: CH.rawExpr<ReadonlyArray<string>>(
				`arrayMap(x -> x.1, ${TOP_ROUTES_SQL})`,
				T.array(T.string),
			),
			topRouteCounts: CH.rawExpr<ReadonlyArray<number>>(
				`arrayMap(x -> x.2, ${TOP_ROUTES_SQL})`,
				T.array(T.uint64),
			),
			firstSeen: CH.min_($.FirstSeen),
			lastSeen: CH.max_($.LastSeen),
		}))
		.where(($) => [...activityWindow($, opts), $.UserId.eq(opts.userId)])
		.format("JSON")
}

export interface UserActivityServiceOutput {
	readonly serviceName: string
	readonly serviceNamespace: string
	readonly requestCount: number
	readonly failedRequestCount: number
	readonly errorSpanCount: number
	readonly logCount: number
	readonly lastSeen: DateTime.Utc
}

export const userActivityServiceRowSchema = Schema.Struct({
	serviceName: Schema.String,
	serviceNamespace: Schema.String,
	requestCount: CHNumber,
	failedRequestCount: CHNumber,
	errorSpanCount: CHNumber,
	logCount: CHNumber,
	lastSeen: DateTimeUtcFromWarehouse,
})

/** The services (with namespace) a user's signals reached, busiest first. */
export function userActivityServicesQuery(opts: UserScopeOpts & { readonly limit?: number }) {
	return from(UserActivityHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			serviceNamespace: $.ServiceNamespace,
			requestCount: CH.sum($.RequestCount),
			failedRequestCount: CH.sum($.FailedRequestCount),
			errorSpanCount: CH.sum($.ErrorSpanCount),
			logCount: CH.sum($.LogCount),
			lastSeen: CH.max_($.LastSeen),
		}))
		.where(($) => [...activityWindow($, opts), $.UserId.eq(opts.userId)])
		.groupBy("serviceName", "serviceNamespace")
		.orderBy(["requestCount", "desc"], ["serviceName", "asc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

// C. Totals for a page of users (the directory's requests and errors columns)

export interface UserActivityTotalsOpts extends UserNamespaceScope {
	readonly userIds: readonly string[]
}

export interface UserActivityTotalsOutput {
	readonly userId: string
	readonly requestCount: number
	readonly failedRequestCount: number
	readonly errorSpanCount: number
	readonly logCount: number
	readonly errorLogCount: number
	readonly firstSeen: DateTime.Utc
	readonly lastSeen: DateTime.Utc
}

export const userActivityTotalsRowSchema = Schema.Struct({
	userId: Schema.String,
	requestCount: CHNumber,
	failedRequestCount: CHNumber,
	errorSpanCount: CHNumber,
	logCount: CHNumber,
	errorLogCount: CHNumber,
	firstSeen: DateTimeUtcFromWarehouse,
	lastSeen: DateTimeUtcFromWarehouse,
})

export function userActivityTotalsQuery(opts: UserActivityTotalsOpts) {
	return from(UserActivityHourly)
		.select(($) => ({
			userId: $.UserId,
			requestCount: CH.sum($.RequestCount),
			failedRequestCount: CH.sum($.FailedRequestCount),
			errorSpanCount: CH.sum($.ErrorSpanCount),
			logCount: CH.sum($.LogCount),
			errorLogCount: CH.sum($.ErrorLogCount),
			firstSeen: CH.min_($.FirstSeen),
			lastSeen: CH.max_($.LastSeen),
		}))
		.where(($) => [
			...activityWindow($, opts),
			opts.userIds.length ? CH.inList($.UserId, opts.userIds) : NEVER,
		])
		.groupBy("userId")
		.limit(opts.userIds.length)
		.format("JSON")
}

// D. Raw reads, pruned by the slices

export interface UserRawReadOpts extends UserScopeOpts {
	/** The services `userActivitySlicesQuery` returned; `startTime`/`endTime` span its hours. */
	readonly serviceNames: readonly string[]
	readonly limit?: number
}

/** `user.id`, else `enduser.id`, as plain map equalities so the attribute-value bloom index applies. */
const traceUserCondition = ($: TraceColumns, userId: string) =>
	CH.or(
		$.SpanAttributes.get("user.id").eq(userId),
		CH.and($.SpanAttributes.get("user.id").eq(""), $.SpanAttributes.get("enduser.id").eq(userId)),
	)

const logUserCondition = ($: LogColumns, userId: string) =>
	CH.or(
		$.LogAttributes.get("user.id").eq(userId),
		CH.and($.LogAttributes.get("user.id").eq(""), $.LogAttributes.get("enduser.id").eq(userId)),
	)

const servicesCondition = (column: CH.Expr<string>, serviceNames: readonly string[]) =>
	serviceNames.length ? CH.inList(column, serviceNames) : NEVER

export interface UserTraceOutput {
	readonly traceId: string
	readonly spanId: string
	readonly timestamp: DateTime.Utc
	readonly serviceName: string
	readonly spanName: string
	readonly spanKind: string
	readonly durationMs: number
	readonly statusCode: string
	readonly isRoot: number
}

export const userTraceRowSchema = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	timestamp: DateTimeUtcFromWarehouse64,
	serviceName: Schema.String,
	spanName: Schema.String,
	spanKind: Schema.String,
	durationMs: CHNumber,
	statusCode: Schema.String,
	isRoot: CHNumber,
})

/** The user's entry-point spans (Server/Consumer or root), newest first. One per request, not per trace. */
export function userTracesQuery(opts: UserRawReadOpts & { readonly errorsOnly?: boolean }) {
	return from(Traces)
		.select(($) => ({
			traceId: $.TraceId,
			spanId: $.SpanId,
			timestamp: $.Timestamp,
			serviceName: $.ServiceName,
			spanName: $.SpanName,
			spanKind: $.SpanKind,
			durationMs: $.Duration.div(1000000),
			statusCode: $.StatusCode,
			isRoot: CH.if_($.ParentSpanId.eq(""), CH.lit(1), CH.lit(0)),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			servicesCondition($.ServiceName, opts.serviceNames),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			namespaceCondition($.ResourceAttributes.get("service.namespace"), opts),
			$.IsEntryPoint.eq(1),
			traceUserCondition($, opts.userId),
			opts.errorsOnly === true ? $.StatusCode.eq("Error") : undefined,
		])
		.orderBy(["timestamp", "desc"])
		.limit(opts.limit ?? 100)
		.format("JSON")
}

export interface UserLogOutput {
	readonly timestamp: DateTime.Utc
	readonly serviceName: string
	readonly severityText: string
	readonly severityNumber: number
	readonly body: string
	readonly traceId: string
	readonly spanId: string
}

export const userLogRowSchema = Schema.Struct({
	timestamp: DateTimeUtcFromWarehouse64,
	serviceName: Schema.String,
	severityText: Schema.String,
	severityNumber: CHNumber,
	body: Schema.String,
	traceId: Schema.String,
	spanId: Schema.String,
})

/** The user's log lines, newest first. `minSeverity` is an OTel SeverityNumber (13 = WARN). */
export function userLogsQuery(opts: UserRawReadOpts & { readonly minSeverity?: number }) {
	return from(Logs)
		.select(($) => ({
			timestamp: $.Timestamp,
			serviceName: $.ServiceName,
			severityText: $.SeverityText,
			severityNumber: $.SeverityNumber,
			body: $.Body,
			traceId: $.TraceId,
			spanId: $.SpanId,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			// TimestampTime prunes partitions; Timestamp is in the sort key after OrgId.
			$.TimestampTime.gte(utcSecondsParam("startTime")),
			$.TimestampTime.lte(utcSecondsParam("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			servicesCondition($.ServiceName, opts.serviceNames),
			namespaceCondition($.ResourceAttributes.get("service.namespace"), opts),
			logUserCondition($, opts.userId),
			opts.minSeverity !== undefined ? $.SeverityNumber.gte(opts.minSeverity) : undefined,
		])
		.orderBy(["timestamp", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}
