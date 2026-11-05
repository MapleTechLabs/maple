// Per end user reads for the `/users` pages. Counts come from `user_activity_hourly` (migration
// 0056), one hour-grain tier floored to whole hours like `serviceEndpointDetails*`, so nothing
// splices. Raw trace and log reads take the services and window its slices name, so the sort-key
// prefix prunes instead of a full-range attribute bloom scan.

import { Schema, type DateTime, Array as Arr } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, inSubquery, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { CHNumber } from "../schema"
import { DateTimeUtcFromWarehouse, DateTimeUtcFromWarehouse64 } from "../../datetime"
import {
	ErrorEvents,
	ErrorEventsByTime,
	Logs,
	Traces,
	UserActivityHourly,
	orgIdParam,
	utcSecondsParam,
} from "../tables"
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

// A. Slices: per service, the hours a user's requests and logs span

/** `minIf`/`maxIf` over the `Hour` column, typed as the hour (the DSL's take numbers only). */
const hourIf = (fn: "minIf" | "maxIf", hour: ActivityColumns["Hour"], condition: CH.Condition) =>
	CH.compileTypedFnCall(fn, T.dateTime.schema, hour, condition)

export type UserActivitySlicesOpts = UserScopeOpts

/**
 * One (service, namespace) the user was active in, with the first and last hour that held a
 * request and a log line. An hour bound is meaningless when its count is 0.
 */
export interface UserActivitySliceOutput {
	readonly serviceName: string
	readonly serviceNamespace: string
	readonly spanCount: number
	readonly requestCount: number
	readonly logCount: number
	readonly firstRequestHour: DateTime.Utc
	readonly lastRequestHour: DateTime.Utc
	readonly firstLogHour: DateTime.Utc
	readonly lastLogHour: DateTime.Utc
}

export const userActivitySliceRowSchema = Schema.Struct({
	serviceName: Schema.String,
	serviceNamespace: Schema.String,
	spanCount: CHNumber,
	requestCount: CHNumber,
	logCount: CHNumber,
	firstRequestHour: DateTimeUtcFromWarehouse,
	lastRequestHour: DateTimeUtcFromWarehouse,
	firstLogHour: DateTimeUtcFromWarehouse,
	lastLogHour: DateTimeUtcFromWarehouse,
})

/**
 * Feeds `userTracesQuery` / `userLogsQuery`: their services and window come from these rows. One
 * row per service, uncapped, so a long window cannot drop a service's older hours.
 */
export function userActivitySlicesQuery(opts: UserActivitySlicesOpts) {
	return from(UserActivityHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			serviceNamespace: $.ServiceNamespace,
			spanCount: CH.sum($.SpanCount),
			requestCount: CH.sum($.RequestCount),
			logCount: CH.sum($.LogCount),
			// Counts are never negative, so a part with a count above 0 marks an hour that held one.
			firstRequestHour: hourIf("minIf", $.Hour, $.RequestCount.gt(0)),
			lastRequestHour: hourIf("maxIf", $.Hour, $.RequestCount.gt(0)),
			firstLogHour: hourIf("minIf", $.Hour, $.LogCount.gt(0)),
			lastLogHour: hourIf("maxIf", $.Hour, $.LogCount.gt(0)),
		}))
		.where(($) => [...activityWindow($, opts), $.UserId.eq(opts.userId)])
		.groupBy("serviceName", "serviceNamespace")
		.orderBy(["serviceName", "asc"])
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
	/** Requests per hour, as {@link UserActivityTotalsOutput} has them. */
	readonly requestHours: ReadonlyArray<number>
	readonly requestHourCounts: ReadonlyArray<number>
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
	requestHours: Schema.Array(CHNumber),
	requestHourCounts: Schema.Array(CHNumber),
	firstSeen: DateTimeUtcFromWarehouse,
	lastSeen: DateTimeUtcFromWarehouse,
})

// sumMap keeps only non-zero sums, so an hour with logs and no requests drops out.
const REQUESTS_BY_HOUR_SQL = "sumMap([toUInt32(toUnixTimestamp(Hour))], [toUInt64(RequestCount)])"

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
			requestHours: CH.rawExpr<ReadonlyArray<number>>(
				`tupleElement(${REQUESTS_BY_HOUR_SQL}, 1)`,
				T.array(T.uint32),
			),
			requestHourCounts: CH.rawExpr<ReadonlyArray<number>>(
				`tupleElement(${REQUESTS_BY_HOUR_SQL}, 2)`,
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
	/** The busiest route, `''` when the user made no entry-point request. */
	readonly topRoute: string
	/** Requests per hour: epoch seconds of each hour with requests, ascending, and its count. */
	readonly requestHours: ReadonlyArray<number>
	readonly requestHourCounts: ReadonlyArray<number>
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
	topRoute: Schema.String,
	requestHours: Schema.Array(CHNumber),
	requestHourCounts: Schema.Array(CHNumber),
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
			topRoute: CH.rawExpr<string>(`tupleElement(arrayElement(${TOP_ROUTES_SQL}, 1), 1)`, T.string),
			requestHours: CH.rawExpr<ReadonlyArray<number>>(
				`tupleElement(${REQUESTS_BY_HOUR_SQL}, 1)`,
				T.array(T.uint32),
			),
			requestHourCounts: CH.rawExpr<ReadonlyArray<number>>(
				`tupleElement(${REQUESTS_BY_HOUR_SQL}, 2)`,
				T.array(T.uint64),
			),
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

export interface UserTracesOpts extends UserRawReadOpts {
	readonly errorsOnly?: boolean
	/** Only failed requests and those at least this slow: the Activity timeline's notable ones. */
	readonly notableSlowerThanMs?: number
}

/** The user's entry-point spans (Server/Consumer or root), newest first. One per request, not per trace. */
export function userTracesQuery(opts: UserTracesOpts) {
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
			opts.notableSlowerThanMs === undefined
				? undefined
				: CH.or($.StatusCode.eq("Error"), $.Duration.gte(opts.notableSlowerThanMs * 1_000_000)),
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

// E. Issues: `error_events.UserId` (migration 0057), set on occurrences ingested since

/** Only decimal UInt64 hashes live in the warehouse; alert/integration keys would abort `toUInt64`. */
const fingerprintHashesCondition = (column: CH.Expr<number>, hashes: readonly string[]) => {
	const usable = Arr.filter(hashes, (hash) => /^[0-9]+$/.test(hash))
	return usable.length
		? CH.inExprList(
				column,
				Arr.map(usable, (hash) => CH.toUInt64(CH.lit(hash))),
			)
		: NEVER
}

export interface UserIssueOutput {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly exceptionType: string
	readonly exceptionMessage: string
	readonly errorLabel: string
	readonly hits: number
	readonly firstSeen: DateTime.Utc
	readonly lastSeen: DateTime.Utc
}

export const userIssueRowSchema = Schema.Struct({
	fingerprintHash: Schema.String,
	serviceName: Schema.String,
	exceptionType: Schema.String,
	exceptionMessage: Schema.String,
	errorLabel: Schema.String,
	hits: CHNumber,
	firstSeen: DateTimeUtcFromWarehouse,
	lastSeen: DateTimeUtcFromWarehouse,
})

/**
 * The issues (by FingerprintHash, as the errors queries key them) one user hit, most hits first.
 * `error_events` has no namespace, so a scope narrows to the services the rollup puts it in.
 */
const userErrorRows = ($: ColumnAccessor<typeof ErrorEventsByTime.columns>, opts: UserScopeOpts) => {
	const scopedServices = from(UserActivityHourly)
		.select(($s) => ({ ServiceName: $s.ServiceName }))
		.where(($s) => [...activityWindow($s, opts), $s.UserId.eq(opts.userId)])
	return [
		$.OrgId.eq(orgIdParam),
		$.Timestamp.gte(utcSecondsParam("startTime")),
		$.Timestamp.lte(utcSecondsParam("endTime")),
		$.UserId.eq(opts.userId),
		opts.namespaces?.length ? inSubquery($.ServiceName, scopedServices) : undefined,
	]
}

export function userIssuesQuery(opts: UserScopeOpts & { readonly limit?: number }) {
	return from(ErrorEventsByTime)
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			serviceName: CH.argMax($.ServiceName, $.Timestamp),
			exceptionType: CH.argMax($.ExceptionType, $.Timestamp),
			exceptionMessage: CH.argMax($.ExceptionMessage, $.Timestamp),
			errorLabel: CH.argMax($.ErrorLabel, $.Timestamp),
			hits: CH.count(),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => userErrorRows($, opts))
		.groupBy("fingerprintHash")
		.orderBy(["hits", "desc"], ["lastSeen", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export interface UserIssueTotalsOutput {
	readonly hits: number
	readonly fingerprints: number
}

export const userIssueTotalsRowSchema = Schema.Struct({ hits: CHNumber, fingerprints: CHNumber })

/** All of the user's error occurrences and distinct fingerprints, uncapped, for the profile totals. */
export function userIssueTotalsQuery(opts: UserScopeOpts) {
	return from(ErrorEventsByTime)
		.select(($) => ({ hits: CH.count(), fingerprints: CH.uniqExact($.FingerprintHash) }))
		.where(($) => userErrorRows($, opts))
		.format("JSON")
}

export interface IssueAffectedUsersOpts {
	/** The issue's own fingerprint plus any aliases it owns. */
	readonly fingerprintHashes: readonly string[]
	readonly limit?: number
}

export interface IssueAffectedUserOutput {
	readonly userId: string
	readonly hits: number
	readonly lastSeen: DateTime.Utc
}

export const issueAffectedUserRowSchema = Schema.Struct({
	userId: Schema.String,
	hits: CHNumber,
	lastSeen: DateTimeUtcFromWarehouse,
})

/** The users an issue hit most, on `error_events`' (OrgId, FingerprintHash) prefix. */
export function issueAffectedUsersQuery(opts: IssueAffectedUsersOpts) {
	return from(ErrorEvents)
		.select(($) => ({
			userId: $.UserId,
			hits: CH.count(),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			fingerprintHashesCondition($.FingerprintHash, opts.fingerprintHashes),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
			$.UserId.neq(""),
		])
		.groupBy("userId")
		.orderBy(["hits", "desc"], ["userId", "asc"])
		.limit(opts.limit ?? 20)
		.format("JSON")
}

export interface IssueAffectedUserCountOutput {
	readonly affectedUsers: number
	readonly hitsWithUser: number
	readonly hits: number
}

export const issueAffectedUserCountRowSchema = Schema.Struct({
	affectedUsers: CHNumber,
	hitsWithUser: CHNumber,
	hits: CHNumber,
})

/** Distinct users an issue hit, and how many of its hits named a user at all (coverage). */
export function issueAffectedUserCountQuery(opts: Pick<IssueAffectedUsersOpts, "fingerprintHashes">) {
	return from(ErrorEvents)
		.select(($) => ({
			affectedUsers: CH.uniqIf($.UserId, $.UserId.neq("")),
			hitsWithUser: CH.countIf($.UserId.neq("")),
			hits: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			fingerprintHashesCondition($.FingerprintHash, opts.fingerprintHashes),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
		])
		.format("JSON")
}
