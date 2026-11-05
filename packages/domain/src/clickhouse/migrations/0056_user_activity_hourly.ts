import type { BackfillSpec } from "../backfill"

// Migration 0056: `user_activity_hourly`, the per end user rollup of `traces` and `logs`, backfilled
// over 30 days in day chunks before its views exist (the 0048 order). Frozen v56 DDL: never
// re-derive it from a later snapshot.
const USER_ACTIVITY_COLUMNS = [
	"OrgId",
	"ServiceNamespace",
	"UserId",
	"Hour",
	"ServiceName",
	"SpanCount",
	"ErrorSpanCount",
	"RequestCount",
	"FailedRequestCount",
	"TraceIds",
	"SessionIds",
	"RequestDurationQuantiles",
	"TopRoutes",
	"LogCount",
	"WarnLogCount",
	"ErrorLogCount",
	"FirstSeen",
	"LastSeen",
]

/** Positional: a chunked backfill sets `prefer_column_name_to_alias`, see 0048. */
const USER_ACTIVITY_GROUP_BY = "1, 2, 3, 4, 5"

const tracesBackfill: BackfillSpec = {
	kind: "backfill",
	target: "user_activity_hourly",
	columns: USER_ACTIVITY_COLUMNS,
	from: "traces",
	tsColumn: "Timestamp",
	select: "          OrgId,\n          ResourceAttributes['service.namespace'] AS ServiceNamespace,\n          if(SpanAttributes['user.id'] != '', SpanAttributes['user.id'], SpanAttributes['enduser.id']) AS UserId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          ServiceName,\n          count() AS SpanCount,\n          countIf(StatusCode = 'Error') AS ErrorSpanCount,\n          countIf(IsEntryPoint = 1) AS RequestCount,\n          countIf(IsEntryPoint = 1 AND StatusCode = 'Error') AS FailedRequestCount,\n          uniqIfState(TraceId, TraceId != '') AS TraceIds,\n          uniqIfState(SpanAttributes['session.id'], SpanAttributes['session.id'] != '') AS SessionIds,\n          quantilesTDigestIfState(0.5, 0.95)(Duration, IsEntryPoint = 1) AS RequestDurationQuantiles,\n          approx_top_kState(10)(if(IsEntryPoint = 1, if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName), '')) AS TopRoutes,\n          toUInt64(0) AS LogCount,\n          toUInt64(0) AS WarnLogCount,\n          toUInt64(0) AS ErrorLogCount,\n          min(toDateTime(Timestamp)) AS FirstSeen,\n          max(toDateTime(Timestamp)) AS LastSeen",
	where: "if(SpanAttributes['user.id'] != '', SpanAttributes['user.id'], SpanAttributes['enduser.id']) != ''",
	groupBy: USER_ACTIVITY_GROUP_BY,
}

const logsBackfill: BackfillSpec = {
	kind: "backfill",
	target: "user_activity_hourly",
	columns: USER_ACTIVITY_COLUMNS,
	from: "logs",
	tsColumn: "TimestampTime",
	select: "          OrgId,\n          ResourceAttributes['service.namespace'] AS ServiceNamespace,\n          if(LogAttributes['user.id'] != '', LogAttributes['user.id'], LogAttributes['enduser.id']) AS UserId,\n          toStartOfHour(TimestampTime) AS Hour,\n          ServiceName,\n          toUInt64(0) AS SpanCount,\n          toUInt64(0) AS ErrorSpanCount,\n          toUInt64(0) AS RequestCount,\n          toUInt64(0) AS FailedRequestCount,\n          uniqIfState(TraceId, toUInt8(0)) AS TraceIds,\n          uniqIfState(LogAttributes['session.id'], LogAttributes['session.id'] != '') AS SessionIds,\n          quantilesTDigestIfState(0.5, 0.95)(toUInt64(0), toUInt8(0)) AS RequestDurationQuantiles,\n          approx_top_kState(10)('') AS TopRoutes,\n          count() AS LogCount,\n          countIf(SeverityNumber >= 13 AND SeverityNumber < 17) AS WarnLogCount,\n          countIf(SeverityNumber >= 17) AS ErrorLogCount,\n          min(TimestampTime) AS FirstSeen,\n          max(TimestampTime) AS LastSeen",
	where: "if(LogAttributes['user.id'] != '', LogAttributes['user.id'], LogAttributes['enduser.id']) != ''",
	groupBy: USER_ACTIVITY_GROUP_BY,
}

export const migration_0056_user_activity_hourly = {
	version: 56,
	description:
		"Create user_activity_hourly and its views from traces and logs: per end user activity for the users pages",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS user_activity_hourly_traces_mv",
		"DROP VIEW IF EXISTS user_activity_hourly_logs_mv",
		"CREATE TABLE IF NOT EXISTS user_activity_hourly (\n    OrgId LowCardinality(String),\n    ServiceNamespace LowCardinality(String),\n    UserId String,\n    Hour DateTime,\n    ServiceName LowCardinality(String),\n    SpanCount SimpleAggregateFunction(sum, UInt64),\n    ErrorSpanCount SimpleAggregateFunction(sum, UInt64),\n    RequestCount SimpleAggregateFunction(sum, UInt64),\n    FailedRequestCount SimpleAggregateFunction(sum, UInt64),\n    TraceIds AggregateFunction(uniqIf, String, UInt8),\n    SessionIds AggregateFunction(uniqIf, String, UInt8),\n    RequestDurationQuantiles AggregateFunction(quantilesTDigestIf(0.5, 0.95), UInt64, UInt8),\n    TopRoutes AggregateFunction(approx_top_k(10), String),\n    LogCount SimpleAggregateFunction(sum, UInt64),\n    WarnLogCount SimpleAggregateFunction(sum, UInt64),\n    ErrorLogCount SimpleAggregateFunction(sum, UInt64),\n    FirstSeen SimpleAggregateFunction(min, DateTime),\n    LastSeen SimpleAggregateFunction(max, DateTime)\n)\nENGINE = AggregatingMergeTree\nPARTITION BY toDate(Hour)\nORDER BY (OrgId, ServiceNamespace, UserId, Hour, ServiceName)\nTTL toDate(Hour) + INTERVAL 90 DAY",
		"ALTER TABLE user_activity_hourly MODIFY SETTING ttl_only_drop_parts = 1",
		"TRUNCATE TABLE IF EXISTS user_activity_hourly",
		tracesBackfill,
		logsBackfill,
		"CREATE MATERIALIZED VIEW IF NOT EXISTS user_activity_hourly_traces_mv TO user_activity_hourly AS\nSELECT\n          OrgId,\n          ResourceAttributes['service.namespace'] AS ServiceNamespace,\n          if(SpanAttributes['user.id'] != '', SpanAttributes['user.id'], SpanAttributes['enduser.id']) AS UserId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          ServiceName,\n          count() AS SpanCount,\n          countIf(StatusCode = 'Error') AS ErrorSpanCount,\n          countIf(IsEntryPoint = 1) AS RequestCount,\n          countIf(IsEntryPoint = 1 AND StatusCode = 'Error') AS FailedRequestCount,\n          uniqIfState(TraceId, TraceId != '') AS TraceIds,\n          uniqIfState(SpanAttributes['session.id'], SpanAttributes['session.id'] != '') AS SessionIds,\n          quantilesTDigestIfState(0.5, 0.95)(Duration, IsEntryPoint = 1) AS RequestDurationQuantiles,\n          approx_top_kState(10)(if(IsEntryPoint = 1, if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName), '')) AS TopRoutes,\n          toUInt64(0) AS LogCount,\n          toUInt64(0) AS WarnLogCount,\n          toUInt64(0) AS ErrorLogCount,\n          min(toDateTime(Timestamp)) AS FirstSeen,\n          max(toDateTime(Timestamp)) AS LastSeen\n        FROM traces\n        WHERE if(SpanAttributes['user.id'] != '', SpanAttributes['user.id'], SpanAttributes['enduser.id']) != ''\n        GROUP BY OrgId, ServiceNamespace, UserId, Hour, ServiceName",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS user_activity_hourly_logs_mv TO user_activity_hourly AS\nSELECT\n          OrgId,\n          ResourceAttributes['service.namespace'] AS ServiceNamespace,\n          if(LogAttributes['user.id'] != '', LogAttributes['user.id'], LogAttributes['enduser.id']) AS UserId,\n          toStartOfHour(TimestampTime) AS Hour,\n          ServiceName,\n          toUInt64(0) AS SpanCount,\n          toUInt64(0) AS ErrorSpanCount,\n          toUInt64(0) AS RequestCount,\n          toUInt64(0) AS FailedRequestCount,\n          uniqIfState(TraceId, toUInt8(0)) AS TraceIds,\n          uniqIfState(LogAttributes['session.id'], LogAttributes['session.id'] != '') AS SessionIds,\n          quantilesTDigestIfState(0.5, 0.95)(toUInt64(0), toUInt8(0)) AS RequestDurationQuantiles,\n          approx_top_kState(10)('') AS TopRoutes,\n          count() AS LogCount,\n          countIf(SeverityNumber >= 13 AND SeverityNumber < 17) AS WarnLogCount,\n          countIf(SeverityNumber >= 17) AS ErrorLogCount,\n          min(TimestampTime) AS FirstSeen,\n          max(TimestampTime) AS LastSeen\n        FROM logs\n        WHERE if(LogAttributes['user.id'] != '', LogAttributes['user.id'], LogAttributes['enduser.id']) != ''\n        GROUP BY OrgId, ServiceNamespace, UserId, Hour, ServiceName",
	],
} as const
