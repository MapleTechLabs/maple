import type { BackfillSpec } from "../backfill"

// Migration 0066: `aws_metrics_hourly`, the CloudWatch stream's `aws.*` points per series and hour,
// backfilled over the raw tables' 90 days in day chunks before its views exist (the 0048 order).
// Frozen v65 DDL: never re-derive it from a later snapshot.
const AWS_METRICS_HOURLY_COLUMNS = [
	"OrgId",
	"MetricType",
	"MetricName",
	"Hour",
	"ServiceName",
	"Attributes",
	"CloudRegion",
	"CloudAccountId",
	"Total",
	"Samples",
	"Peak",
	"LastSeen",
]

/** Positional: a chunked backfill sets `prefer_column_name_to_alias`, see 0048. */
const AWS_METRICS_HOURLY_GROUP_BY = "1, 2, 3, 4, 5, 6, 7, 8"

const sumBackfill: BackfillSpec = {
	kind: "backfill",
	target: "aws_metrics_hourly",
	columns: AWS_METRICS_HOURLY_COLUMNS,
	from: "metrics_sum",
	tsColumn: "TimeUnix",
	select: "\n          OrgId,\n          'sum' AS MetricType,\n          MetricName,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          ServiceName,\n          Attributes,\n          ResourceAttributes['cloud.region'] AS CloudRegion,\n          ResourceAttributes['cloud.account.id'] AS CloudAccountId,\n          sum(Value) AS Total,\n          count() AS Samples,\n          max(Value) AS Peak,\n          max(toDateTime(TimeUnix)) AS LastSeen",
	where: "startsWith(MetricName, 'aws.')",
	groupBy: AWS_METRICS_HOURLY_GROUP_BY,
}

const gaugeBackfill: BackfillSpec = {
	kind: "backfill",
	target: "aws_metrics_hourly",
	columns: AWS_METRICS_HOURLY_COLUMNS,
	from: "metrics_gauge",
	tsColumn: "TimeUnix",
	select: "\n          OrgId,\n          'gauge' AS MetricType,\n          MetricName,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          ServiceName,\n          Attributes,\n          ResourceAttributes['cloud.region'] AS CloudRegion,\n          ResourceAttributes['cloud.account.id'] AS CloudAccountId,\n          sum(Value) AS Total,\n          count() AS Samples,\n          max(Value) AS Peak,\n          max(toDateTime(TimeUnix)) AS LastSeen",
	where: "startsWith(MetricName, 'aws.')",
	groupBy: AWS_METRICS_HOURLY_GROUP_BY,
}

export const migration_0066_aws_metrics_hourly = {
	version: 66,
	description:
		"Create aws_metrics_hourly and its views from metrics_sum and metrics_gauge: hourly AWS series for the infra pages",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS aws_metrics_hourly_sum_mv",
		"DROP VIEW IF EXISTS aws_metrics_hourly_gauge_mv",
		"CREATE TABLE IF NOT EXISTS aws_metrics_hourly (\n    OrgId LowCardinality(String),\n    MetricType LowCardinality(String),\n    MetricName LowCardinality(String),\n    Hour DateTime,\n    ServiceName LowCardinality(String),\n    Attributes Map(LowCardinality(String), String),\n    CloudRegion LowCardinality(String),\n    CloudAccountId LowCardinality(String),\n    Total SimpleAggregateFunction(sum, Float64),\n    Samples SimpleAggregateFunction(sum, UInt64),\n    Peak SimpleAggregateFunction(max, Float64),\n    LastSeen SimpleAggregateFunction(max, DateTime)\n)\nENGINE = AggregatingMergeTree\nPARTITION BY toDate(Hour)\nORDER BY (OrgId, MetricType, MetricName, Hour, ServiceName, Attributes, CloudRegion, CloudAccountId)\nTTL toDate(Hour) + INTERVAL 90 DAY",
		"ALTER TABLE aws_metrics_hourly MODIFY SETTING ttl_only_drop_parts = 1",
		"TRUNCATE TABLE IF EXISTS aws_metrics_hourly",
		sumBackfill,
		gaugeBackfill,
		"CREATE MATERIALIZED VIEW IF NOT EXISTS aws_metrics_hourly_sum_mv TO aws_metrics_hourly AS\nSELECT\n          OrgId,\n          'sum' AS MetricType,\n          MetricName,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          ServiceName,\n          Attributes,\n          ResourceAttributes['cloud.region'] AS CloudRegion,\n          ResourceAttributes['cloud.account.id'] AS CloudAccountId,\n          sum(Value) AS Total,\n          count() AS Samples,\n          max(Value) AS Peak,\n          max(toDateTime(TimeUnix)) AS LastSeen\n        FROM metrics_sum\n        WHERE startsWith(MetricName, 'aws.')\n        GROUP BY OrgId, MetricType, MetricName, Hour, ServiceName, Attributes, CloudRegion, CloudAccountId",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS aws_metrics_hourly_gauge_mv TO aws_metrics_hourly AS\nSELECT\n          OrgId,\n          'gauge' AS MetricType,\n          MetricName,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          ServiceName,\n          Attributes,\n          ResourceAttributes['cloud.region'] AS CloudRegion,\n          ResourceAttributes['cloud.account.id'] AS CloudAccountId,\n          sum(Value) AS Total,\n          count() AS Samples,\n          max(Value) AS Peak,\n          max(toDateTime(TimeUnix)) AS LastSeen\n        FROM metrics_gauge\n        WHERE startsWith(MetricName, 'aws.')\n        GROUP BY OrgId, MetricType, MetricName, Hour, ServiceName, Attributes, CloudRegion, CloudAccountId",
	],
} as const
