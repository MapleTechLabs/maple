// ---------------------------------------------------------------------------
// Typed Logs Queries
//
// DSL-based query definitions for logs timeseries and breakdown.
// ---------------------------------------------------------------------------

import { compileCH } from "../compile"
import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery, type ColumnAccessor } from "../query"
import type { ColumnDefs } from "../types"
import { unionAll, type CHUnionQuery } from "../union"
import { Logs, LogsAggregatesHourly } from "../tables"

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

interface LogsQueryOpts {
	serviceName?: string
	severity?: string
	traceId?: string
	spanId?: string
	search?: string
	environments?: readonly string[]
	matchModes?: {
		deploymentEnv?: "contains"
	}
}

function environmentCondition(
	$: ColumnAccessor<typeof Logs.columns>,
	opts: LogsQueryOpts,
): CH.Condition | undefined {
	if (!opts.environments?.length) return undefined
	const envAttr = $.ResourceAttributes.get("deployment.environment")
	if (opts.matchModes?.deploymentEnv === "contains" && opts.environments.length === 1) {
		return CH.positionCaseInsensitive(envAttr, CH.lit(opts.environments[0]!)).gt(0)
	}
	return CH.inList(envAttr, opts.environments)
}

// ---------------------------------------------------------------------------
// Timeseries query
// ---------------------------------------------------------------------------

export interface LogsTimeseriesOpts extends LogsQueryOpts {
	groupBy?: readonly string[]
	/**
	 * Bucket size in seconds, supplied here so the query builder can route to
	 * `logs_aggregates_hourly` when the bucket is hour-aligned. Optional: when
	 * absent (or sub-hour), the raw `logs` table is used.
	 */
	bucketSeconds?: number
}

export interface LogsTimeseriesOutput {
	readonly bucket: string
	readonly groupName: string
	readonly count: number
}

/**
 * Predicate for routing to the pre-aggregated hourly MV.
 *
 * The MV stores per-hour buckets keyed by (OrgId, Hour, ServiceName,
 * SeverityText, DeploymentEnv). It cannot answer queries that need raw row
 * lookups (traceId, full-text search on Body) or sub-hour granularity, but for
 * the dashboard log-volume chart at 1h+ ranges it cuts scan volume by orders
 * of magnitude.
 */
export function canUseLogsAggregatesHourly(
	opts: LogsTimeseriesOpts,
	bucketSeconds: number | undefined,
): boolean {
	if (bucketSeconds === undefined || bucketSeconds < 3600 || bucketSeconds % 3600 !== 0) {
		return false
	}
	if (opts.traceId) return false
	if (opts.search) return false
	// MV stores DeploymentEnv as a top-level column; the `contains` substring
	// match is only supported via positionCaseInsensitive on the raw map column.
	if (opts.matchModes?.deploymentEnv === "contains") return false
	return true
}

function mvEnvironmentCondition(
	$: ColumnAccessor<typeof LogsAggregatesHourly.columns>,
	opts: LogsTimeseriesOpts,
): CH.Condition | undefined {
	if (!opts.environments?.length) return undefined
	return CH.inList($.DeploymentEnv, opts.environments)
}

export function logsTimeseriesQuery(
	opts: LogsTimeseriesOpts,
): CHQuery<ColumnDefs, LogsTimeseriesOutput, {}> {
	const groupByService = opts.groupBy?.includes("service")
	const groupBySeverity = opts.groupBy?.includes("severity")

	if (canUseLogsAggregatesHourly(opts, opts.bucketSeconds)) {
		// MV path: read pre-aggregated hourly buckets. The upper bound is
		// `Hour < toStartOfHour(endTime)` so a partial trailing hour (whose full
		// hour-bucket on the MV would otherwise overcount vs. raw's
		// `Timestamp <= endTime`) is excluded. The leading partial hour is
		// already trimmed downstream by `firstFullBucketIso` /
		// `trimSparseLeadingBuckets`, keeping behavior symmetric across edges.
		const mv = from(LogsAggregatesHourly)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Hour, param.int("bucketSeconds")),
				groupName: buildLogsGroupNameExpr($, groupByService, groupBySeverity),
				count: CH.sum($.Count),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.Hour.gte(param.dateTime("startTime")),
				// `param.dateTime("endTime")` substitutes as a quoted string literal;
				// `toStartOfHour` only accepts Date/DateTime, so wrap with `toDateTime`.
				$.Hour.lt(CH.toStartOfHour(CH.toDateTime(param.dateTime("endTime")))),
				CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
				CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
				mvEnvironmentCondition($, opts),
			])
			.groupBy("bucket", "groupName")
			.orderBy(["bucket", "asc"], ["groupName", "asc"])
			.format("JSON")
		return mv as unknown as CHQuery<ColumnDefs, LogsTimeseriesOutput, {}>
	}

	const raw = from(Logs)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			groupName: buildLogsGroupNameExpr($, groupByService, groupBySeverity),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// TimestampTime is the partition/index key; this filter unlocks
			// partition pruning. Timestamp filter retained for sub-second accuracy.
			$.TimestampTime.gte(param.dateTime("startTime")),
			$.TimestampTime.lte(param.dateTime("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
			environmentCondition($, opts),
		])
		.groupBy("bucket", "groupName")
		.orderBy(["bucket", "asc"], ["groupName", "asc"])
		.format("JSON")
	return raw as unknown as CHQuery<ColumnDefs, LogsTimeseriesOutput, {}>
}

function buildLogsGroupNameExpr(
	$: { ServiceName: CH.Expr<string>; SeverityText: CH.Expr<string> },
	groupByService?: boolean,
	groupBySeverity?: boolean,
): CH.Expr<string> {
	if (!groupByService && !groupBySeverity) {
		return CH.lit("all")
	}

	const parts: CH.Expr<string>[] = []
	if (groupByService) parts.push(CH.toString_($.ServiceName))
	if (groupBySeverity) parts.push(CH.toString_($.SeverityText))

	if (parts.length === 1) {
		return CH.coalesce(CH.nullIf(parts[0]!, ""), CH.lit("all"))
	}

	// Multi-part: filter empty strings before joining with separator
	const filtered = CH.arrayFilter("x -> x != ''", CH.arrayOf(...parts))
	return CH.coalesce(CH.nullIf(CH.arrayStringConcat(filtered, " \u00b7 "), ""), CH.lit("all"))
}

// ---------------------------------------------------------------------------
// Breakdown query
// ---------------------------------------------------------------------------

export interface LogsBreakdownOpts extends LogsQueryOpts {
	groupBy: "service" | "severity"
	limit?: number
}

export interface LogsBreakdownOutput {
	readonly name: string
	readonly count: number
}

export function logsBreakdownQuery(opts: LogsBreakdownOpts) {
	return from(Logs)
		.select(($) => ({
			name: opts.groupBy === "severity" ? $.SeverityText : $.ServiceName,
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimestampTime.gte(param.dateTime("startTime")),
			$.TimestampTime.lte(param.dateTime("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
			environmentCondition($, opts),
		])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 10)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Count query
// ---------------------------------------------------------------------------

export interface LogsCountOutput {
	readonly total: number
}

export function logsCountQuery(opts: LogsQueryOpts) {
	return from(Logs)
		.select(() => ({
			total: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimestampTime.gte(param.dateTime("startTime")),
			$.TimestampTime.lte(param.dateTime("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
			CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
			CH.when(opts.spanId, (v: string) => $.SpanId.eq(v)),
			CH.when(opts.search, (v: string) => $.Body.ilike(`%${v}%`)),
			environmentCondition($, opts),
		])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export interface LogsListOpts extends LogsQueryOpts {
	minSeverity?: number
	cursor?: string
	limit?: number
}

export interface LogsListOutput {
	readonly timestamp: string
	readonly severityText: string
	readonly severityNumber: number
	readonly serviceName: string
	readonly body: string
	readonly traceId: string
	readonly spanId: string
	readonly logAttributes: string
	readonly resourceAttributes: string
}

/**
 * Two-stage list query. The `logs` sort key is
 * `(OrgId, ServiceName, TimestampTime, Timestamp)` — `ServiceName` sits between
 * `OrgId` and the timestamps, so `ORDER BY Timestamp DESC` is not a sort-key
 * prefix and ClickHouse cannot read-in-order. A single-stage query therefore
 * scans the whole window and materializes the heavy `Body` / attribute-map
 * columns for every matching row *before* `LIMIT` discards all but N, which
 * OOMs on busy orgs.
 *
 * Stage 1 reads only `Timestamp` to find the cutoff (the Nth-newest matching
 * timestamp). Stage 2 gates on `Timestamp >= cutoff`, so the heavy columns are
 * materialized only for the small slice of rows at/after the cutoff. The outer
 * `LIMIT` trims any ties at the cutoff timestamp.
 */
export function logsListQuery(opts: LogsListOpts) {
	const limit = opts.limit ?? 50

	const baseWhere = ($: ColumnAccessor<typeof Logs.columns>): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.TimestampTime.gte(param.dateTime("startTime")),
		$.TimestampTime.lte(param.dateTime("endTime")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
		CH.when(opts.minSeverity, (v: number) => $.SeverityNumber.gte(v)),
		CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
		CH.when(opts.spanId, (v: string) => $.SpanId.eq(v)),
		CH.when(opts.cursor, (v: string) => $.Timestamp.lt(v)),
		CH.when(opts.search, (v: string) => $.Body.ilike(`%${v}%`)),
		environmentCondition($, opts),
	]

	// Stage 1: cheap scan — only `Timestamp` is read. Compiled with placeholders
	// intact ({} params) so the outer `CH.compile()` substitutes them once.
	const cutoffInner = from(Logs)
		.select(($) => ({ ts: $.Timestamp }))
		.where(baseWhere)
		.orderBy(["ts", "desc"])
		.limit(limit)
	const cutoffSql = compileCH(cutoffInner, {}, { skipFormat: true }).sql
	const cutoff = CH.rawExpr<string>(`(SELECT min(ts) FROM (${cutoffSql}))`)

	// Stage 2: heavy columns read only for rows at/after the cutoff timestamp.
	return from(Logs)
		.select(($) => ({
			timestamp: $.Timestamp,
			severityText: $.SeverityText,
			severityNumber: $.SeverityNumber,
			serviceName: $.ServiceName,
			body: $.Body,
			traceId: $.TraceId,
			spanId: $.SpanId,
			logAttributes: CH.toJSONString($.LogAttributes),
			resourceAttributes: CH.toJSONString($.ResourceAttributes),
		}))
		.where(($) => [...baseWhere($), $.Timestamp.gte(cutoff)])
		.orderBy(["timestamp", "desc"])
		.limit(limit)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Single log lookup (exact-match by composite key)
//
// Logs have no primary id; a row is identified by Timestamp + ServiceName
// (+ TraceId / SpanId when present). `Timestamp` is DateTime64 (sub-second),
// so the pair is effectively unique per service. Used by the shareable
// `/logs/$logId` detail page.
// ---------------------------------------------------------------------------

export interface LogByKeyOpts {
	serviceName: string
	traceId?: string
	spanId?: string
}

export function getLogByKeyQuery(opts: LogByKeyOpts) {
	return from(Logs)
		.select(($) => ({
			timestamp: $.Timestamp,
			severityText: $.SeverityText,
			severityNumber: $.SeverityNumber,
			serviceName: $.ServiceName,
			body: $.Body,
			traceId: $.TraceId,
			spanId: $.SpanId,
			logAttributes: CH.toJSONString($.LogAttributes),
			resourceAttributes: CH.toJSONString($.ResourceAttributes),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// TimestampTime is the partition/index key; bounding it unlocks
			// partition pruning. Timestamp.eq pins the exact sub-second row.
			$.TimestampTime.gte(param.dateTime("startTime")),
			$.TimestampTime.lte(param.dateTime("endTime")),
			$.Timestamp.eq(param.dateTime("timestamp")),
			$.ServiceName.eq(opts.serviceName),
			CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
			CH.when(opts.spanId, (v: string) => $.SpanId.eq(v)),
		])
		.limit(1)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Error rate by service
// ---------------------------------------------------------------------------

export interface ErrorRateByServiceOutput {
	readonly serviceName: string
	readonly totalLogs: number
	readonly errorLogs: number
	readonly errorRate: number
}

export function errorRateByServiceQuery() {
	return from(Logs)
		.select(($) => ({
			serviceName: $.ServiceName,
			totalLogs: CH.count(),
			errorLogs: CH.countIf(CH.inList($.SeverityText, ["ERROR", "FATAL"])),
			errorRate: CH.round_(
				CH.countIf(CH.inList($.SeverityText, ["ERROR", "FATAL"])).div(CH.count()),
				6,
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimestampTime.gte(param.dateTime("startTime")),
			$.TimestampTime.lte(param.dateTime("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["errorRate", "desc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Logs facets (UNION ALL — severity + service facets)
// ---------------------------------------------------------------------------

export interface LogsFacetsOutput {
	readonly severityText: string
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly count: number
	readonly facetType: string
}

export function logsFacetsQuery(opts: LogsQueryOpts): CHUnionQuery<LogsFacetsOutput> {
	// Facets only filter on dimensions the hourly MV carries (service, severity,
	// deployment env), so route to `logs_aggregates_hourly` and collapse three
	// full raw-`logs` scans into three cheap pre-aggregated reads. The lone
	// exception is the `contains` env match mode, which needs a substring scan on
	// the raw map column — fall back to raw `logs` there (mirrors the
	// `canUseLogsAggregatesHourly` guard used by the timeseries query).
	if (opts.matchModes?.deploymentEnv === "contains") {
		return logsFacetsQueryFromRaw(opts)
	}
	return logsFacetsQueryFromMv(opts)
}

function logsFacetsQueryFromMv(opts: LogsQueryOpts): CHUnionQuery<LogsFacetsOutput> {
	const baseWhere = (
		$: ColumnAccessor<typeof LogsAggregatesHourly.columns>,
	): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.Hour.gte(param.dateTime("startTime")),
		$.Hour.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
		opts.environments?.length ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
	]

	const severityQuery = from(LogsAggregatesHourly)
		.select(($) => ({
			severityText: $.SeverityText,
			serviceName: CH.lit(""),
			deploymentEnv: CH.lit(""),
			count: CH.sum($.Count),
			facetType: CH.lit("severity"),
		}))
		.where(baseWhere)
		.groupBy("severityText")

	const serviceQuery = from(LogsAggregatesHourly)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: $.ServiceName,
			deploymentEnv: CH.lit(""),
			count: CH.sum($.Count),
			facetType: CH.lit("service"),
		}))
		.where(baseWhere)
		.groupBy("serviceName")

	const envQuery = from(LogsAggregatesHourly)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: CH.lit(""),
			deploymentEnv: $.DeploymentEnv,
			count: CH.sum($.Count),
			facetType: CH.lit("deploymentEnv"),
		}))
		.where(($) => [...baseWhere($), $.DeploymentEnv.neq("")])
		.groupBy("deploymentEnv")

	return unionAll(severityQuery, serviceQuery, envQuery)
		.orderBy(["count", "desc"])
		.limit(500)
		.format("JSON")
}

function logsFacetsQueryFromRaw(opts: LogsQueryOpts): CHUnionQuery<LogsFacetsOutput> {
	const baseWhere = ($: ColumnAccessor<typeof Logs.columns>): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.TimestampTime.gte(param.dateTime("startTime")),
		$.TimestampTime.lte(param.dateTime("endTime")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
		environmentCondition($, opts),
	]

	const severityQuery = from(Logs)
		.select(($) => ({
			severityText: $.SeverityText,
			serviceName: CH.lit(""),
			deploymentEnv: CH.lit(""),
			count: CH.count(),
			facetType: CH.lit("severity"),
		}))
		.where(baseWhere)
		.groupBy("severityText")

	const serviceQuery = from(Logs)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: $.ServiceName,
			deploymentEnv: CH.lit(""),
			count: CH.count(),
			facetType: CH.lit("service"),
		}))
		.where(baseWhere)
		.groupBy("serviceName")

	const envQuery = from(Logs)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: CH.lit(""),
			deploymentEnv: $.ResourceAttributes.get("deployment.environment"),
			count: CH.count(),
			facetType: CH.lit("deploymentEnv"),
		}))
		.where(($) => [...baseWhere($), $.ResourceAttributes.get("deployment.environment").neq("")])
		.groupBy("deploymentEnv")

	return unionAll(severityQuery, serviceQuery, envQuery)
		.orderBy(["count", "desc"])
		.limit(500)
		.format("JSON")
}
