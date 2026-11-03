import type { BackfillSpec } from "../backfill"

/**
 * Migration 0048: the HTTP facts the service API tab reads.
 *
 * 1. Six additive measures on `service_operations_minutely/_hourly`, the same trade as
 *    0023: HttpClassifiedSpanCount is the coverage marker (0 = bucket predates 0048, so
 *    the status mix there is UNKNOWN), plus HttpStatusCount, Http4xxCount, Http5xxCount,
 *    RequestBodyBytes and RequestBodyCount over Server spans. Not backfilled: the
 *    rollups outlive raw `traces`, and the splice computes recent edges from raw.
 * 2. `service_endpoint_details_hourly` and its view: per endpoint, status code and
 *    `error.type`, latency and body digests, top user agents and the slowest request.
 *    Backfilled from the retained 30 days of `traces` in the 0034 order (view detached,
 *    target truncated, backfill, view created) so a replay converges. Spans written
 *    while the backfill runs are missed, as in 0034.
 *
 * `requiredForIngest: false`: every table here is MV-populated.
 * The CREATE statements are the verbatim DDL the schema emitter produced at v48.
 * Frozen history: never re-derive it from a later snapshot.
 */
const ENDPOINT_DETAILS_PROJECTION_SQL =
	"          OrgId,\n          ServiceName,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS SpanName,\n          if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) AS HttpStatusCode,\n          SpanAttributes['error.type'] AS ErrorType,\n          count() AS SpanCount,\n          sum(SampleRate) AS EstimatedSpanCount,\n          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,\n          quantilesTDigestIfState(0.5, 0.95, 0.99)(ifNull(toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])), 0), toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])) IS NOT NULL) AS BodySizeQuantiles,\n          maxIf(ifNull(toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])), 0), toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])) IS NOT NULL) AS BodySizeMax,\n          countIf(toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])) IS NOT NULL) AS BodyCount,\n          approx_top_kState(10)(coalesce(nullIf(SpanAttributes['user_agent.original'], ''), nullIf(SpanAttributes['http.user_agent'], ''), '')) AS UserAgents,\n          max(Duration) AS SlowestDuration,\n          argMaxState(TraceId, Duration) AS SlowestTraceId,\n          argMaxState(Timestamp, Duration) AS SlowestTimestamp,\n          argMaxState(ifNull(toInt64(toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length']))), -1), Duration) AS SlowestBodySize"
const ENDPOINT_DETAILS_FILTER =
	"SpanKind = 'Server'\n          AND if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) != ''"
/**
 * Positional: a chunked backfill sets `prefer_column_name_to_alias`, so `GROUP BY SpanName`
 * would bind to the raw column instead of the normalized name the projection aliases.
 */
const ENDPOINT_DETAILS_GROUP_BY = "1, 2, 3, 4, 5, 6, 7"

const endpointDetailsBackfill: BackfillSpec = {
	kind: "backfill",
	target: "service_endpoint_details_hourly",
	columns: [
		"OrgId",
		"ServiceName",
		"Hour",
		"DeploymentEnv",
		"SpanName",
		"HttpStatusCode",
		"ErrorType",
		"SpanCount",
		"EstimatedSpanCount",
		"DurationQuantiles",
		"BodySizeQuantiles",
		"BodySizeMax",
		"BodyCount",
		"UserAgents",
		"SlowestDuration",
		"SlowestTraceId",
		"SlowestTimestamp",
		"SlowestBodySize",
	],
	from: "traces",
	tsColumn: "Timestamp",
	select: ENDPOINT_DETAILS_PROJECTION_SQL,
	where: ENDPOINT_DETAILS_FILTER,
	groupBy: ENDPOINT_DETAILS_GROUP_BY,
}

export const migration_0048_service_api_http_details = {
	version: 48,
	description:
		"HTTP status, error and request-body measures on service_operations_* and the service_endpoint_details_hourly rollup for the service API tab",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE service_operations_minutely ADD COLUMN IF NOT EXISTS HttpClassifiedSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_minutely ADD COLUMN IF NOT EXISTS HttpStatusCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_minutely ADD COLUMN IF NOT EXISTS Http4xxCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_minutely ADD COLUMN IF NOT EXISTS Http5xxCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_minutely ADD COLUMN IF NOT EXISTS RequestBodyBytes SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_minutely ADD COLUMN IF NOT EXISTS RequestBodyCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_hourly ADD COLUMN IF NOT EXISTS HttpClassifiedSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_hourly ADD COLUMN IF NOT EXISTS HttpStatusCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_hourly ADD COLUMN IF NOT EXISTS Http4xxCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_hourly ADD COLUMN IF NOT EXISTS Http5xxCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_hourly ADD COLUMN IF NOT EXISTS RequestBodyBytes SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_hourly ADD COLUMN IF NOT EXISTS RequestBodyCount SimpleAggregateFunction(sum, UInt64)",
		"DROP VIEW IF EXISTS service_operations_minutely_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_operations_minutely_mv TO service_operations_minutely AS\nSELECT\n          OrgId,\n          toStartOfMinute(toDateTime(Timestamp)) AS Minute,\n          ServiceName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS SpanName,\n          count() AS SpanCount,\n          sum(SampleRate) AS EstimatedSpanCount,\n          countIf(StatusCode = 'Error') AS ErrorCount,\n          sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,\n          sum(toFloat64(Duration)) AS DurationSum,\n          quantilesTDigestState(0.5, 0.95)(Duration) AS DurationQuantiles,\n          count() AS ClassifiedSpanCount,\n          countIf(SpanKind IN ('Server', 'Consumer')) AS ServerSpanCount,\n          countIf(SpanAttributes['http.route'] != '') AS RoutedSpanCount,\n          count() AS HttpClassifiedSpanCount,\n          countIf(SpanKind = 'Server' AND if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) != '') AS HttpStatusCount,\n          countIf(SpanKind = 'Server' AND toUInt16OrZero(if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code'])) BETWEEN 400 AND 499) AS Http4xxCount,\n          countIf(SpanKind = 'Server' AND toUInt16OrZero(if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code'])) BETWEEN 500 AND 599) AS Http5xxCount,\n          sumIf(ifNull(toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])), 0), SpanKind = 'Server' AND toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])) IS NOT NULL) AS RequestBodyBytes,\n          countIf(SpanKind = 'Server' AND toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])) IS NOT NULL) AS RequestBodyCount\n        FROM traces\n        GROUP BY OrgId, Minute, ServiceName, DeploymentEnv, SpanName",
		"DROP VIEW IF EXISTS service_operations_hourly_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_operations_hourly_mv TO service_operations_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(Minute) AS Hour,\n          ServiceName,\n          DeploymentEnv,\n          SpanName,\n          sum(SpanCount) AS SpanCount,\n          sum(EstimatedSpanCount) AS EstimatedSpanCount,\n          sum(ErrorCount) AS ErrorCount,\n          sum(EstimatedErrorCount) AS EstimatedErrorCount,\n          sum(DurationSum) AS DurationSum,\n          quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles) AS DurationQuantiles,\n          sum(ClassifiedSpanCount) AS ClassifiedSpanCount,\n          sum(ServerSpanCount) AS ServerSpanCount,\n          sum(RoutedSpanCount) AS RoutedSpanCount,\n          sum(HttpClassifiedSpanCount) AS HttpClassifiedSpanCount,\n          sum(HttpStatusCount) AS HttpStatusCount,\n          sum(Http4xxCount) AS Http4xxCount,\n          sum(Http5xxCount) AS Http5xxCount,\n          sum(RequestBodyBytes) AS RequestBodyBytes,\n          sum(RequestBodyCount) AS RequestBodyCount\n        FROM service_operations_minutely\n        GROUP BY OrgId, Hour, ServiceName, DeploymentEnv, SpanName",
		"DROP VIEW IF EXISTS service_endpoint_details_hourly_mv",
		"CREATE TABLE IF NOT EXISTS service_endpoint_details_hourly (\n    OrgId LowCardinality(String),\n    ServiceName LowCardinality(String),\n    Hour DateTime,\n    DeploymentEnv LowCardinality(String),\n    SpanName String,\n    HttpStatusCode LowCardinality(String),\n    ErrorType LowCardinality(String),\n    SpanCount SimpleAggregateFunction(sum, UInt64),\n    EstimatedSpanCount SimpleAggregateFunction(sum, Float64),\n    DurationQuantiles AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt64),\n    BodySizeQuantiles AggregateFunction(quantilesTDigestIf(0.5, 0.95, 0.99), UInt64, UInt8),\n    BodySizeMax SimpleAggregateFunction(max, UInt64),\n    BodyCount SimpleAggregateFunction(sum, UInt64),\n    UserAgents AggregateFunction(approx_top_k(10), String),\n    SlowestDuration SimpleAggregateFunction(max, UInt64),\n    SlowestTraceId AggregateFunction(argMax, String, UInt64),\n    SlowestTimestamp AggregateFunction(argMax, DateTime64(9), UInt64),\n    SlowestBodySize AggregateFunction(argMax, Int64, UInt64)\n)\nENGINE = AggregatingMergeTree\nPARTITION BY toYYYYMM(Hour)\nORDER BY (OrgId, ServiceName, Hour, DeploymentEnv, SpanName, HttpStatusCode, ErrorType)\nTTL toDate(Hour) + INTERVAL 90 DAY",
		"ALTER TABLE service_endpoint_details_hourly MODIFY SETTING ttl_only_drop_parts = 1",
		"TRUNCATE TABLE IF EXISTS service_endpoint_details_hourly",
		endpointDetailsBackfill,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_endpoint_details_hourly_mv TO service_endpoint_details_hourly AS\nSELECT\n${ENDPOINT_DETAILS_PROJECTION_SQL}\n        FROM traces\n        WHERE ${ENDPOINT_DETAILS_FILTER}\n        GROUP BY OrgId, ServiceName, Hour, DeploymentEnv, SpanName, HttpStatusCode, ErrorType`,
	],
} as const
