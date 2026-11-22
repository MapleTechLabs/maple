import type { BackfillSpec } from "../backfill"

// Migration 0070: `user_activity_daily`, a year of `user_activity_hourly` at UTC-day grain for the
// user page's activity calendar. Backfilled from the hourly table's 90 days in day chunks before
// its view exists (the 0048 order). Frozen v70 DDL: never re-derive it from a later snapshot.
const USER_ACTIVITY_DAILY_COLUMNS = [
	"OrgId",
	"ServiceNamespace",
	"UserId",
	"Day",
	"ServiceName",
	"RequestCount",
	"FailedRequestCount",
	"ErrorSpanCount",
	"LogCount",
	"ErrorLogCount",
	"SessionIds",
]

const dailyBackfill: BackfillSpec = {
	kind: "backfill",
	target: "user_activity_daily",
	columns: USER_ACTIVITY_DAILY_COLUMNS,
	from: "user_activity_hourly",
	tsColumn: "Hour",
	select: "\n          OrgId,\n          ServiceNamespace,\n          UserId,\n          toStartOfDay(Hour) AS Day,\n          ServiceName,\n          sum(RequestCount) AS RequestCount,\n          sum(FailedRequestCount) AS FailedRequestCount,\n          sum(ErrorSpanCount) AS ErrorSpanCount,\n          sum(LogCount) AS LogCount,\n          sum(ErrorLogCount) AS ErrorLogCount,\n          uniqIfMergeState(SessionIds) AS SessionIds",
	// Positional: a chunked backfill sets `prefer_column_name_to_alias`, see 0048.
	groupBy: "1, 2, 3, 4, 5",
}

export const migration_0070_user_activity_daily = {
	version: 70,
	description:
		"Create user_activity_daily and its view from user_activity_hourly: a year of per-user daily counts for the activity calendar",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS user_activity_daily_mv",
		"CREATE TABLE IF NOT EXISTS user_activity_daily (\n    OrgId LowCardinality(String),\n    ServiceNamespace LowCardinality(String),\n    UserId String,\n    Day DateTime,\n    ServiceName LowCardinality(String),\n    RequestCount SimpleAggregateFunction(sum, UInt64),\n    FailedRequestCount SimpleAggregateFunction(sum, UInt64),\n    ErrorSpanCount SimpleAggregateFunction(sum, UInt64),\n    LogCount SimpleAggregateFunction(sum, UInt64),\n    ErrorLogCount SimpleAggregateFunction(sum, UInt64),\n    SessionIds AggregateFunction(uniqIf, String, UInt8)\n)\nENGINE = AggregatingMergeTree\nPARTITION BY toYYYYMM(Day)\nORDER BY (OrgId, ServiceNamespace, UserId, Day, ServiceName)\nTTL toDate(Day) + INTERVAL 365 DAY",
		"ALTER TABLE user_activity_daily MODIFY SETTING ttl_only_drop_parts = 1",
		"TRUNCATE TABLE IF EXISTS user_activity_daily",
		dailyBackfill,
		"CREATE MATERIALIZED VIEW IF NOT EXISTS user_activity_daily_mv TO user_activity_daily AS\nSELECT\n          OrgId,\n          ServiceNamespace,\n          UserId,\n          toStartOfDay(Hour) AS Day,\n          ServiceName,\n          sum(RequestCount) AS RequestCount,\n          sum(FailedRequestCount) AS FailedRequestCount,\n          sum(ErrorSpanCount) AS ErrorSpanCount,\n          sum(LogCount) AS LogCount,\n          sum(ErrorLogCount) AS ErrorLogCount,\n          uniqIfMergeState(SessionIds) AS SessionIds\n        FROM user_activity_hourly\n        GROUP BY OrgId, ServiceNamespace, UserId, Day, ServiceName",
	],
} as const
