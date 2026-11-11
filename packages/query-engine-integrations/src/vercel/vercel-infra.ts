// Vercel infrastructure page (/infra/vercel)
//
// Reads what the Vercel drains deliver. The log drain lands in `logs` with
// `cloud.provider = vercel` and the project on `vercel.project.id`; a record is
// a request when it carries `http.request.method`. The trace drain's spans keep
// Vercel's own resource attributes (`vercel.projectId`).

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "@maple/query-engine/ch/tables"
import { isoBucket, leftUTF8 } from "@maple/query-engine/ch/format"

/** Narrows a read to one Vercel project. */
export interface VercelProjectScope {
	readonly projectId?: string
}

type LogColumns = ColumnAccessor<typeof Datasources.logs.columns>
type TraceColumns = ColumnAccessor<typeof Datasources.traces.columns>

/** The trace drain's service for Vercel's edge: one request span per request, plus routing children. */
export const VERCEL_EDGE_SERVICE = "vercel.edge-network"

/**
 * The edge request span. Its children (`Resolve Route`, `Resolve Deployment`,
 * `Route across regions`) are server spans too, but carry no attributes.
 */
export const isEdgeRequest = ($: TraceColumns) =>
	$.ServiceName.eq(VERCEL_EDGE_SERVICE)
		.and($.SpanKind.eq("Server"))
		.and($.SpanAttributes.get("http.response.status_code").neq(""))

/** Logs severity number for ERROR; FATAL is above it. */
const ERROR_SEVERITY = 17

const isRequest = ($: LogColumns) => $.LogAttributes.get("http.request.method").neq("")

const statusCode = ($: LogColumns) => CH.toUInt16OrZero($.LogAttributes.get("http.response.status_code"))

const requestsInClass = ($: LogColumns, low: number) =>
	CH.countIf(isRequest($).and(statusCode($).between(low, low + 99)))

const vercelLogsWhere = ($: LogColumns) => [
	$.OrgId.eq(orgIdParam),
	$.TimestampTime.gte(utcSecondsParam("startTime")),
	$.TimestampTime.lte(utcSecondsParam("endTime")),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
	$.ResourceAttributes.get("cloud.provider").eq("vercel"),
]

/** Answered from Vercel's cache: a hit, a stale copy, or a prerendered page. */
const servedFromCache = ($: LogColumns) =>
	CH.inList($.LogAttributes.get("vercel.cache"), ["HIT", "STALE", "PRERENDER"])

const requestColumns = ($: LogColumns) => ({
	requests: CH.countIf(isRequest($)),
	requests4xx: requestsInClass($, 400),
	requests5xx: requestsInClass($, 500),
	cacheHits: CH.countIf(isRequest($).and(servedFromCache($))),
	/** Requests Vercel reported a cache status for: the hit-ratio denominator. */
	cacheLookups: CH.countIf(isRequest($).and($.LogAttributes.get("vercel.cache").neq(""))),
	errorLogs: CH.countIf($.SeverityNumber.gte(ERROR_SEVERITY)),
})

/** One row per project over the window: request volume, status mix, cache and error logs. */
export function vercelProjectRequestsSQL() {
	return from(Datasources.logs)
		.select(($) => ({
			projectId: $.ResourceAttributes.get("vercel.project.id"),
			projectName: CH.any_($.ResourceAttributes.get("vercel.project.name")),
			serviceName: CH.any_($.ServiceName),
			...requestColumns($),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [...vercelLogsWhere($), $.ResourceAttributes.get("vercel.project.id").neq("")])
		.groupBy("projectId")
		.orderBy(["requests", "desc"])
		.limit(1000)
		.format("JSON")
}

/** Requests by status class per bucket, for every project or one. */
export function vercelRequestTimeseriesSQL(scope: VercelProjectScope = {}) {
	return from(Datasources.logs)
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			requests: CH.countIf(isRequest($)),
			requests2xx: requestsInClass($, 200),
			requests3xx: requestsInClass($, 300),
			requests4xx: requestsInClass($, 400),
			requests5xx: requestsInClass($, 500),
			cacheHits: CH.countIf(isRequest($).and(servedFromCache($))),
			cacheLookups: CH.countIf(isRequest($).and($.LogAttributes.get("vercel.cache").neq(""))),
			errorLogs: CH.countIf($.SeverityNumber.gte(ERROR_SEVERITY)),
		}))
		.where(($) => [
			...vercelLogsWhere($),
			CH.when(scope.projectId, (id) => $.ResourceAttributes.get("vercel.project.id").eq(id)),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")
}

/** The log attribute each breakdown of a project's requests groups by. */
export const VERCEL_BREAKDOWN_ATTRIBUTES = {
	path: "url.path",
	host: "server.address",
	region: "vercel.proxy.region",
	source: "vercel.source",
	cache: "vercel.cache",
	waf: "vercel.waf.action",
	status: "http.response.status_code",
} as const
export type VercelBreakdownDimension = keyof typeof VERCEL_BREAKDOWN_ATTRIBUTES

/** Narrows a breakdown to the failing requests. */
export type VercelBreakdownStatus = "all" | "4xx" | "5xx"

/**
 * One project's requests grouped by one log attribute: volume, failures, cache and
 * response bytes. Requests without the attribute group under the empty key.
 */
export function vercelProjectBreakdownSQL(
	dimension: VercelBreakdownDimension,
	status: VercelBreakdownStatus = "all",
) {
	const attribute = VERCEL_BREAKDOWN_ATTRIBUTES[dimension]
	return from(Datasources.logs)
		.select(($) => ({
			key: $.LogAttributes.get(attribute),
			requests: CH.count(),
			requests4xx: CH.countIf(statusCode($).between(400, 499)),
			requests5xx: CH.countIf(statusCode($).between(500, 599)),
			cacheHits: CH.countIf(servedFromCache($)),
			cacheLookups: CH.countIf($.LogAttributes.get("vercel.cache").neq("")),
			bytes: CH.sum(CH.toFloat64OrZero($.LogAttributes.get("http.response.body.size"))),
		}))
		.where(($) => [
			...vercelLogsWhere($),
			$.ResourceAttributes.get("vercel.project.id").eq(param.string("projectId")),
			isRequest($),
			status === "all"
				? undefined
				: statusCode($).between(status === "4xx" ? 400 : 500, status === "4xx" ? 499 : 599),
		])
		.groupBy("key")
		.orderBy(["requests", "desc"])
		.limit(50)
		.format("JSON")
}

/** Edge request latency per bucket, from the trace drain, for every project or one. */
export function vercelEdgeLatencyTimeseriesSQL(scope: VercelProjectScope = {}) {
	return from(Datasources.traces)
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			p50DurationMs: CH.quantile(0.5)($.Duration).div(1_000_000),
			p95DurationMs: CH.quantile(0.95)($.Duration).div(1_000_000),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.mapContains($.ResourceAttributes, "vercel.projectId"),
			scope.projectId === undefined
				? $.ResourceAttributes.get("vercel.projectId").neq("")
				: $.ResourceAttributes.get("vercel.projectId").eq(scope.projectId),
			isEdgeRequest($),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")
}

/** The busiest paths of one project, with their failures and cache hits. */
export function vercelProjectTopPathsSQL() {
	return from(Datasources.logs)
		.select(($) => ({
			path: $.LogAttributes.get("url.path"),
			requests: CH.count(),
			requests4xx: CH.countIf(statusCode($).between(400, 499)),
			requests5xx: CH.countIf(statusCode($).between(500, 599)),
			cacheHits: CH.countIf(servedFromCache($)),
			cacheLookups: CH.countIf($.LogAttributes.get("vercel.cache").neq("")),
		}))
		.where(($) => [
			...vercelLogsWhere($),
			$.ResourceAttributes.get("vercel.project.id").eq(param.string("projectId")),
			isRequest($),
		])
		.groupBy("path")
		.orderBy(["requests", "desc"])
		.limit(25)
		.format("JSON")
}

/** Error and fatal log lines of one project, grouped by their first 200 characters. */
/** How many of the window's newest error logs the error patterns are clustered from. */
export const VERCEL_ERROR_LOG_SAMPLE = 2000

/**
 * The project's newest error and fatal logs, for `clusterVercelErrorLogs`. A raw message makes a
 * poor group key (request ids, call ids and timings differ on every line), so the rows are
 * clustered into templates after the read, and each keeps the trace of its newest line.
 */
export function vercelProjectErrorLogsSQL() {
	return from(Datasources.logs)
		.select(($) => ({
			timestamp: $.Timestamp,
			body: leftUTF8($.Body, CH.lit(2000)),
			source: $.LogAttributes.get("vercel.source"),
			traceId: $.TraceId,
			spanId: $.SpanId,
		}))
		.where(($) => [
			...vercelLogsWhere($),
			$.ResourceAttributes.get("vercel.project.id").eq(param.string("projectId")),
			$.SeverityNumber.gte(ERROR_SEVERITY),
		])
		.orderBy(["timestamp", "desc"])
		.limit(VERCEL_ERROR_LOG_SAMPLE)
		.format("JSON")
}

/**
 * Request latency per project at Vercel's edge, from the trace drain's edge request
 * spans. Empty for projects that send no traces.
 */
export function vercelProjectLatencySQL() {
	return from(Datasources.traces)
		.select(($) => ({
			projectId: $.ResourceAttributes.get("vercel.projectId"),
			serviceName: CH.any_($.ServiceName),
			spans: CH.count(),
			p50DurationMs: CH.quantile(0.5)($.Duration).div(1_000_000),
			p95DurationMs: CH.quantile(0.95)($.Duration).div(1_000_000),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			// The key test lets the `mapKeys(ResourceAttributes)` bloom index skip
			// granules of non-Vercel traces; the value test drops empty ids.
			CH.mapContains($.ResourceAttributes, "vercel.projectId"),
			$.ResourceAttributes.get("vercel.projectId").neq(""),
			// Server spans, not roots: a caller's propagated context gives the request span a parent.
			isEdgeRequest($),
		])
		.groupBy("projectId")
		.limit(1000)
		.format("JSON")
}
