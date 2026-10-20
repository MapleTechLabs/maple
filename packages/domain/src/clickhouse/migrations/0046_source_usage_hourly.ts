/**
 * Migration 0046: `source_usage_hourly`, per-source ingestion volume for every
 * signal, read by `sourceUsageHourlyQuery` and `sourceUsageTotalsQuery`.
 *
 * No backfill: the sources UI reads the last 24 hours, so the views fill it
 * within a day, and a backfill would scan every raw signal table's Map column.
 *
 * The CREATE statements are the verbatim DDL the schema emitter produced at v46.
 * Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0046_source_usage_hourly = {
	version: 46,
	description: "Create source_usage_hourly + its views: hourly volume and estimated bytes per source",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS source_usage_hourly (\n    OrgId LowCardinality(String),\n    SourceId String,\n    Hour DateTime,\n    SpanCount UInt64,\n    SpanSizeBytes UInt64,\n    LogCount UInt64,\n    LogSizeBytes UInt64,\n    MetricCount UInt64,\n    MetricSizeBytes UInt64\n)\nENGINE = SummingMergeTree\nORDER BY (OrgId, SourceId, Hour)\nTTL Hour + INTERVAL 90 DAY",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS source_usage_logs_mv TO source_usage_hourly AS\nSELECT\n          OrgId,\n          ResourceAttributes['maple_source_id'] AS SourceId,\n          toStartOfHour(TimestampTime) AS Hour,\n          0 AS SpanCount,\n          0 AS SpanSizeBytes,\n          count() AS LogCount,\n          sum(length(Body) + 200) AS LogSizeBytes,\n          0 AS MetricCount,\n          0 AS MetricSizeBytes\n        FROM logs\n        WHERE ResourceAttributes['maple_source_id'] != ''\n        GROUP BY OrgId, SourceId, Hour",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS source_usage_metrics_exp_histogram_mv TO source_usage_hourly AS\nSELECT\n          OrgId,\n          ResourceAttributes['maple_source_id'] AS SourceId,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          0 AS SpanCount,\n          0 AS SpanSizeBytes,\n          0 AS LogCount,\n          0 AS LogSizeBytes,\n          count() AS MetricCount,\n          count() * 300 AS MetricSizeBytes\n        FROM metrics_exponential_histogram\n        WHERE ResourceAttributes['maple_source_id'] != ''\n        GROUP BY OrgId, SourceId, Hour",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS source_usage_metrics_gauge_mv TO source_usage_hourly AS\nSELECT\n          OrgId,\n          ResourceAttributes['maple_source_id'] AS SourceId,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          0 AS SpanCount,\n          0 AS SpanSizeBytes,\n          0 AS LogCount,\n          0 AS LogSizeBytes,\n          count() AS MetricCount,\n          count() * 150 AS MetricSizeBytes\n        FROM metrics_gauge\n        WHERE ResourceAttributes['maple_source_id'] != ''\n        GROUP BY OrgId, SourceId, Hour",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS source_usage_metrics_histogram_mv TO source_usage_hourly AS\nSELECT\n          OrgId,\n          ResourceAttributes['maple_source_id'] AS SourceId,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          0 AS SpanCount,\n          0 AS SpanSizeBytes,\n          0 AS LogCount,\n          0 AS LogSizeBytes,\n          count() AS MetricCount,\n          count() * 250 AS MetricSizeBytes\n        FROM metrics_histogram\n        WHERE ResourceAttributes['maple_source_id'] != ''\n        GROUP BY OrgId, SourceId, Hour",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS source_usage_metrics_sum_mv TO source_usage_hourly AS\nSELECT\n          OrgId,\n          ResourceAttributes['maple_source_id'] AS SourceId,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          0 AS SpanCount,\n          0 AS SpanSizeBytes,\n          0 AS LogCount,\n          0 AS LogSizeBytes,\n          count() AS MetricCount,\n          count() * 150 AS MetricSizeBytes\n        FROM metrics_sum\n        WHERE ResourceAttributes['maple_source_id'] != ''\n        GROUP BY OrgId, SourceId, Hour",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS source_usage_traces_mv TO source_usage_hourly AS\nSELECT\n          OrgId,\n          ResourceAttributes['maple_source_id'] AS SourceId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          count() AS SpanCount,\n          sum(length(SpanName) + 300) AS SpanSizeBytes,\n          0 AS LogCount,\n          0 AS LogSizeBytes,\n          0 AS MetricCount,\n          0 AS MetricSizeBytes\n        FROM traces\n        WHERE ResourceAttributes['maple_source_id'] != ''\n        GROUP BY OrgId, SourceId, Hour",
	],
} as const
