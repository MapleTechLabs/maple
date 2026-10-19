// Vercel infrastructure page (/infra/vercel)
//
// Reads what the Vercel drains deliver. The log drain lands in `logs` with
// `cloud.provider = vercel` and the project on `vercel.project.id`; a record is
// a request when it carries `http.request.method`. Deployment traces keep
// Vercel's own resource attributes (`vercel.projectId`).

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { Logs, Traces, orgIdParam, utcSecondsParam } from "@maple/query-engine/ch/tables"
import { isoBucket, leftUTF8 } from "@maple/query-engine/ch/format"

/** Narrows a read to one Vercel project. */
export interface VercelProjectScope {
	readonly projectId?: string
}

type LogColumns = ColumnAccessor<typeof Logs.columns>

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

const requestColumns = ($: LogColumns) => ({
	requests: CH.countIf(isRequest($)),
	requests4xx: requestsInClass($, 400),
	requests5xx: requestsInClass($, 500),
	cacheHits: CH.countIf(isRequest($).and($.LogAttributes.get("vercel.cache").eq("HIT"))),
	/** Requests Vercel reported a cache status for: the hit-ratio denominator. */
	cacheLookups: CH.countIf(isRequest($).and($.LogAttributes.get("vercel.cache").neq(""))),
	errorLogs: CH.countIf($.SeverityNumber.gte(ERROR_SEVERITY)),
})

/** One row per project over the window: request volume, status mix, cache and error logs. */
export function vercelProjectRequestsSQL() {
	return from(Logs)
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
	return from(Logs)
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			requests: CH.countIf(isRequest($)),
			requests2xx: requestsInClass($, 200),
			requests3xx: requestsInClass($, 300),
			requests4xx: requestsInClass($, 400),
			requests5xx: requestsInClass($, 500),
			cacheHits: CH.countIf(isRequest($).and($.LogAttributes.get("vercel.cache").eq("HIT"))),
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

/** The busiest paths of one project, with their failures and cache hits. */
export function vercelProjectTopPathsSQL() {
	return from(Logs)
		.select(($) => ({
			path: $.LogAttributes.get("url.path"),
			requests: CH.count(),
			requests4xx: CH.countIf(statusCode($).between(400, 499)),
			requests5xx: CH.countIf(statusCode($).between(500, 599)),
			cacheHits: CH.countIf($.LogAttributes.get("vercel.cache").eq("HIT")),
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
export function vercelProjectTopErrorsSQL() {
	return from(Logs)
		.select(($) => ({
			message: leftUTF8($.Body, CH.lit(200)),
			occurrences: CH.count(),
			source: CH.any_($.LogAttributes.get("vercel.source")),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			...vercelLogsWhere($),
			$.ResourceAttributes.get("vercel.project.id").eq(param.string("projectId")),
			$.SeverityNumber.gte(ERROR_SEVERITY),
		])
		.groupBy("message")
		.orderBy(["occurrences", "desc"])
		.limit(20)
		.format("JSON")
}

/**
 * Root-span latency per project from deployment traces (`@vercel/otel` or Vercel's own
 * instrumentation). Empty for projects that send no traces.
 */
export function vercelProjectLatencySQL() {
	return from(Traces)
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
			$.ParentSpanId.eq(""),
		])
		.groupBy("projectId")
		.limit(1000)
		.format("JSON")
}
