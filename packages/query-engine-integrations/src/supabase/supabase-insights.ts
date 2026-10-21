// /infra/supabase insights read from the polled Supabase logs (service `supabase`, resource
// `supabase.project.ref`, log attribute `supabase.log.source`) and from the org's own client spans
// that call a project. Raw tables only: every read is bounded by OrgId, time and ServiceName.

import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import {
	defineFn,
	from,
	fromQuery,
	inSubquery,
	param,
	type ColumnAccessor,
} from "@maple-dev/effect-orm/clickhouse"
import { finiteOrZero, isoBucket, leftUTF8 } from "@maple/query-engine/ch/format"
import { Logs, Traces, orgIdParam, utcSecondsParam } from "@maple/query-engine/ch/tables"
import type { DateTime } from "effect"

/** The `service.name` the logs poller stamps on every Supabase log record. */
export const SUPABASE_LOGS_SERVICE_NAME = "supabase"
export const SUPABASE_LOG_PROJECT_REF_ATTRIBUTE = "supabase.project.ref"
export const SUPABASE_LOG_SOURCE_ATTRIBUTE = "supabase.log.source"

const EDGE_LOGS = "edge_logs"
/** OTLP WARN. The poller maps Postgres WARNING, service `warn` levels and HTTP 4xx here. */
const WARN_SEVERITY = 13
const TOP_PATHS_LIMIT = 10
const LOG_ISSUES_LIMIT = 20
const ISSUE_MESSAGE_CHARS = 200
/** The callers table's rows; the sparkline series reads exactly these services. */
const CALLERS_LIMIT = 100

const toFloat64OrNull = defineFn<[CH.Expr<string>], number | null>("toFloat64OrNull", T.nullable(T.float64))
const replaceRegexpAll = defineFn<[CH.Expr<string>, CH.Expr<string>, CH.Expr<string>], string>(
	"replaceRegexpAll",
	T.string,
)

type LogColumns = ColumnAccessor<typeof Logs.columns>
type TraceColumns = ColumnAccessor<typeof Traces.columns>

/** Seconds in the requested window, at least one, for per-minute rates. */
const windowSeconds = () =>
	CH.greatest_(
		CH.toUnixTimestamp(CH.toDateTime(utcSecondsParam("endTime"))).sub(
			CH.toUnixTimestamp(CH.toDateTime(utcSecondsParam("startTime"))),
		),
		CH.lit(1),
	)

/** Supabase log records of the window; `TimestampTime` prunes partitions, `Timestamp` is exact. */
const supabaseLogsWindow = ($: LogColumns) => [
	$.OrgId.eq(orgIdParam),
	$.ServiceName.eq(SUPABASE_LOGS_SERVICE_NAME),
	$.TimestampTime.gte(utcSecondsParam("startTime")),
	$.TimestampTime.lte(utcSecondsParam("endTime")),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
]

const projectRefOf = ($: LogColumns) => $.ResourceAttributes.get(SUPABASE_LOG_PROJECT_REF_ATTRIBUTE)
const sourceOf = ($: LogColumns) => $.LogAttributes.get(SUPABASE_LOG_SOURCE_ATTRIBUTE)
const isEdge = ($: LogColumns) => sourceOf($).eq(EDGE_LOGS)
/** Edge `response.status_code` arrives as text ("401"); 0 when absent. */
const statusOf = ($: LogColumns) => CH.toUInt16OrZero($.LogAttributes.get("response.status_code"))
const statusIn = ($: LogColumns, low: number) => statusOf($).between(low, low + 99)
/** `response.origin_time` is the upstream time in ms, as text; null when absent. */
const originMsOf = ($: LogColumns) => toFloat64OrNull($.LogAttributes.get("response.origin_time"))
/** The path without its query string or fragment. */
const edgePathOf = ($: LogColumns) => CH.extract_($.LogAttributes.get("request.path"), "^[^?#]*")

const edgeLogsOfProject = ($: LogColumns) => [
	...supabaseLogsWindow($),
	projectRefOf($).eq(param.string("projectRef")),
	isEdge($),
]

// API TRAFFIC

export interface SupabaseApiTrafficSeriesOutput {
	readonly bucket: string
	readonly status2xx: number
	readonly status3xx: number
	readonly status4xx: number
	readonly status5xx: number
}

/** Edge requests per bucket by status class, for one project. */
export function supabaseApiTrafficSeriesSQL() {
	return from(Logs)
		.select(($) => ({
			bucket: isoBucket($.TimestampTime),
			status2xx: CH.countIf(statusIn($, 200)),
			status3xx: CH.countIf(statusIn($, 300)),
			status4xx: CH.countIf(statusIn($, 400)),
			status5xx: CH.countIf(statusIn($, 500)),
		}))
		.where(edgeLogsOfProject)
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")
}

export interface SupabaseApiTrafficTotalsOutput {
	readonly requests: number
	readonly errors5xx: number
	readonly p95OriginMs: number
}

/** One row: edge requests, 5xx responses and the p95 upstream time over the window. */
export function supabaseApiTrafficTotalsSQL() {
	return from(Logs)
		.select(($) => ({
			requests: CH.count(),
			errors5xx: CH.countIf(statusIn($, 500)),
			p95OriginMs: finiteOrZero(CH.quantile(0.95)(originMsOf($))),
		}))
		.where(edgeLogsOfProject)
		.format("JSON")
}

export interface SupabaseApiTopPathsOutput {
	readonly method: string
	readonly path: string
	readonly requests: number
	readonly errors5xx: number
	readonly p95OriginMs: number
}

/** The ten busiest (method, path) pairs of one project's edge requests. */
export function supabaseApiTopPathsSQL() {
	return from(Logs)
		.select(($) => ({
			method: $.LogAttributes.get("request.method"),
			path: edgePathOf($),
			requests: CH.count(),
			errors5xx: CH.countIf(statusIn($, 500)),
			p95OriginMs: finiteOrZero(CH.quantile(0.95)(originMsOf($))),
		}))
		.where(edgeLogsOfProject)
		.groupBy("method", "path")
		.orderBy(["requests", "desc"], ["method", "asc"], ["path", "asc"])
		.limit(TOP_PATHS_LIMIT)
		.format("JSON")
}

// LOG ISSUES

export interface SupabaseLogIssuesOpts {
	/** Scope to the `projectRef` param; otherwise every project of the org. */
	readonly byProject: boolean
}

export interface SupabaseLogIssuesOutput {
	readonly projectRef: string
	readonly source: string
	readonly message: string
	readonly count: number
	readonly lastSeen: DateTime.Utc
	readonly maxSeverity: number
}

/**
 * WARN-or-worse Supabase log records grouped by (project, source, message), top 20 by count.
 * The message is an edge request's `METHOD path status`, else auth's `msg`, else the body;
 * digit runs collapse to `0` so ids and timings do not split a group.
 */
export function supabaseLogIssuesSQL(opts: SupabaseLogIssuesOpts) {
	const records = from(Logs)
		.select(($) => {
			const authMsg = $.LogAttributes.get("msg")
			const raw = CH.multiIf(
				[
					[
						isEdge($),
						CH.concat(
							$.LogAttributes.get("request.method"),
							" ",
							edgePathOf($),
							" ",
							$.LogAttributes.get("response.status_code"),
						),
					],
					[authMsg.neq(""), authMsg],
				],
				$.Body,
			)
			return {
				projectRef: projectRefOf($),
				source: sourceOf($),
				message: leftUTF8(
					replaceRegexpAll(raw, CH.lit("[0-9]+"), CH.lit("0")),
					CH.lit(ISSUE_MESSAGE_CHARS),
				),
				t: $.Timestamp,
				severity: $.SeverityNumber,
			}
		})
		.where(($) => [
			...supabaseLogsWindow($),
			$.SeverityNumber.gte(WARN_SEVERITY),
			opts.byProject ? projectRefOf($).eq(param.string("projectRef")) : projectRefOf($).neq(""),
		])

	return fromQuery(records, "records")
		.select(($) => ({
			projectRef: $.projectRef,
			source: $.source,
			message: $.message,
			count: CH.count(),
			lastSeen: CH.max_($.t),
			maxSeverity: CH.max_($.severity),
		}))
		.groupBy("projectRef", "source", "message")
		.orderBy(["count", "desc"], ["lastSeen", "desc"])
		.limit(LOG_ISSUES_LIMIT)
		.format("JSON")
}

// PROJECTS SUMMARY

export interface SupabaseLogsProjectSummaryOutput {
	readonly projectRef: string
	readonly requests: number
	readonly requestsPerMinute: number
	readonly errors5xx: number
	/** WARN-or-worse log records of any source. */
	readonly issueCount: number
	readonly lastSeen: DateTime.Utc
}

/** One row per project with logs in the window: edge requests, 5xx and WARN+ record counts. */
export function supabaseLogsProjectsSummarySQL() {
	return from(Logs)
		.select(($) => ({
			projectRef: projectRefOf($),
			requests: CH.countIf(isEdge($)),
			requestsPerMinute: finiteOrZero(CH.countIf(isEdge($)).mul(60).div(windowSeconds())),
			errors5xx: CH.countIf(isEdge($).and(statusIn($, 500))),
			issueCount: CH.countIf($.SeverityNumber.gte(WARN_SEVERITY)),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [...supabaseLogsWindow($), projectRefOf($).neq("")])
		.groupBy("projectRef")
		.orderBy(["projectRef", "asc"])
		.limit(1000)
		.format("JSON")
}

// CALLERS

const SUPABASE_API_HOST_SUFFIX = ".supabase.co"
const SUPABASE_POOLER_HOST_PATTERN = "%.pooler.supabase.com"

const spanAttr = ($: TraceColumns, key: string) => $.SpanAttributes.get(key)
const spanUrlOf = ($: TraceColumns) =>
	CH.coalesce(CH.nullIf(spanAttr($, "url.full"), ""), spanAttr($, "http.url"))
const spanPathOf = ($: TraceColumns) =>
	CH.if_(spanAttr($, "url.path").neq(""), spanAttr($, "url.path"), CH.path_(spanUrlOf($)))
const dbSystemOf = ($: TraceColumns) =>
	CH.coalesce(CH.nullIf(spanAttr($, "db.system.name"), ""), spanAttr($, "db.system"))
const peerAddressOf = ($: TraceColumns) =>
	CH.coalesce(CH.nullIf(spanAttr($, "server.address"), ""), spanAttr($, "net.peer.name"))

/** `{ref}.supabase.co` as any of the HTTP peer attributes, or the URL's host. */
const callsProjectApi = ($: TraceColumns) => {
	const host = CH.concat(param.string("projectRef"), SUPABASE_API_HOST_SUFFIX)
	return spanAttr($, "server.address")
		.eq(host)
		.or(spanAttr($, "net.peer.name").eq(host))
		.or(spanAttr($, "http.host").eq(host))
		.or(CH.domain_(spanUrlOf($)).eq(host))
}

/** Postgres spans to `db.{ref}.supabase.co`, or to the Supavisor pooler as user `*.{ref}`. */
const callsProjectDatabase = ($: TraceColumns) =>
	dbSystemOf($)
		.eq("postgresql")
		.and(
			peerAddressOf($)
				.eq(CH.concat("db.", param.string("projectRef"), SUPABASE_API_HOST_SUFFIX))
				.or(
					peerAddressOf($)
						.like(SUPABASE_POOLER_HOST_PATTERN)
						.and(spanAttr($, "db.user").like(CH.concat("%.", param.string("projectRef")))),
				),
		)

const projectClientSpans = ($: TraceColumns) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
	$.SpanKind.eq("Client"),
	callsProjectApi($).or(callsProjectDatabase($)),
]

export interface SupabaseProjectCallersOutput {
	readonly serviceName: string
	readonly calls: number
	readonly callsPerMinute: number
	readonly errors: number
	readonly errorRate: number
	readonly p95DurationMs: number
	readonly rest: number
	readonly auth: number
	readonly storage: number
	readonly realtime: number
	readonly functions: number
	readonly postgres: number
	readonly other: number
}

/** The org's services that call one project, by span count, with the product mix of their calls. */
export function supabaseProjectCallersSQL() {
	const spans = from(Traces)
		.select(($) => ({
			serviceName: $.ServiceName,
			duration: $.Duration,
			failed: CH.if_($.StatusCode.eq("Error"), CH.lit(1), CH.lit(0)),
			isPostgres: CH.if_(dbSystemOf($).eq("postgresql"), CH.lit(1), CH.lit(0)),
			path: spanPathOf($),
		}))
		.where(projectClientSpans)

	return fromQuery(spans, "spans")
		.select(($) => {
			const api = (prefix: string) => $.isPostgres.eq(0).and($.path.like(`/${prefix}/%`))
			return {
				serviceName: $.serviceName,
				calls: CH.count(),
				callsPerMinute: finiteOrZero(CH.count().mul(60).div(windowSeconds())),
				errors: CH.sum($.failed),
				errorRate: finiteOrZero(CH.sum($.failed).div(CH.count())),
				p95DurationMs: finiteOrZero(CH.quantile(0.95)($.duration).div(1_000_000)),
				rest: CH.countIf(api("rest")),
				auth: CH.countIf(api("auth")),
				storage: CH.countIf(api("storage")),
				realtime: CH.countIf(api("realtime")),
				functions: CH.countIf(api("functions")),
				postgres: CH.countIf($.isPostgres.eq(1)),
				other: CH.countIf(
					$.isPostgres
						.eq(0)
						.and(CH.not(CH.matchCond($.path, "^/(rest|auth|storage|realtime|functions)/"))),
				),
			}
		})
		.groupBy("serviceName")
		.orderBy(["calls", "desc"], ["serviceName", "asc"])
		.limit(CALLERS_LIMIT)
		.format("JSON")
}

/** The services `supabaseProjectCallersSQL` returns: same spans, ranking and limit. */
const topCallers = () =>
	fromQuery(
		from(Traces)
			.select(($) => ({ serviceName: $.ServiceName, calls: CH.count() }))
			.where(projectClientSpans)
			.groupBy("serviceName")
			.orderBy(["calls", "desc"], ["serviceName", "asc"])
			.limit(CALLERS_LIMIT),
		"callers",
	).select(($) => ({ serviceName: $.serviceName }))

export interface SupabaseProjectCallerSeriesOutput {
	readonly serviceName: string
	readonly bucket: string
	readonly calls: number
}

/** Calls per (service, bucket) for exactly the callers table's services, for its sparklines. */
export function supabaseProjectCallerSeriesSQL() {
	return from(Traces)
		.select(($) => ({
			serviceName: $.ServiceName,
			bucket: isoBucket($.Timestamp),
			calls: CH.count(),
		}))
		.where(($) => [...projectClientSpans($), inSubquery($.ServiceName, topCallers())])
		.groupBy("serviceName", "bucket")
		.orderBy(["serviceName", "asc"], ["bucket", "asc"])
		.limit(10_000)
		.format("JSON")
}
