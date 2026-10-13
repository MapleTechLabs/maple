import type { BackfillSpec } from "../backfill"

const TRACE_FACETS_PROJECTION_SQL = `OrgId,
          toStartOfHour(Timestamp) AS Hour,
          ServiceName,
          SpanName,
          HttpMethod,
          HttpStatusCode,
          DeploymentEnv,
          ServiceNamespace,
          HasError,
          count() AS TraceCount,
          min(Duration) AS DurationMin,
          max(Duration) AS DurationMax,
          quantilesTDigestState(0.5, 0.95)(Duration) AS DurationQuantiles`

const TRACE_FACETS_GROUP_BY =
	"OrgId, Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode, DeploymentEnv, ServiceNamespace, HasError"

/**
 * Backfills the 30 days `trace_list_mv` retains (the rollup's own retention).
 * Shares the view's projection; day chunks never split an hourly group.
 */
export const traceFacetsHourlyBackfill: BackfillSpec = {
	kind: "backfill",
	target: "trace_facets_hourly",
	columns: [
		"OrgId",
		"Hour",
		"ServiceName",
		"SpanName",
		"HttpMethod",
		"HttpStatusCode",
		"DeploymentEnv",
		"ServiceNamespace",
		"HasError",
		"TraceCount",
		"DurationMin",
		"DurationMax",
		"DurationQuantiles",
	],
	from: "trace_list_mv",
	tsColumn: "Timestamp",
	select: TRACE_FACETS_PROJECTION_SQL,
	groupBy: TRACE_FACETS_GROUP_BY,
}

/**
 * Migration 0034: `trace_facets_hourly`, the hourly rollup behind the traces
 * sidebar facets. Statement order as in 0015: the truncate makes a re-apply
 * converge, and is safe only because the view is detached first.
 *
 * The CREATE statements are the verbatim DDL the schema emitter produced at v34.
 * Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0034_trace_facets_hourly = {
	version: 34,
	description:
		"Create trace_facets_hourly + trace_facets_hourly_mv: hourly rollup for the traces sidebar facets",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS trace_facets_hourly_mv",
		"CREATE TABLE IF NOT EXISTS trace_facets_hourly (\n    OrgId LowCardinality(String),\n    Hour DateTime,\n    ServiceName LowCardinality(String),\n    SpanName String,\n    HttpMethod LowCardinality(String),\n    HttpStatusCode LowCardinality(String),\n    DeploymentEnv LowCardinality(String),\n    ServiceNamespace LowCardinality(String),\n    HasError UInt8,\n    TraceCount SimpleAggregateFunction(sum, UInt64),\n    DurationMin SimpleAggregateFunction(min, UInt64),\n    DurationMax SimpleAggregateFunction(max, UInt64),\n    DurationQuantiles AggregateFunction(quantilesTDigest(0.5, 0.95), UInt64)\n)\nENGINE = AggregatingMergeTree\nPARTITION BY toDate(Hour)\nORDER BY (OrgId, Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode, DeploymentEnv, ServiceNamespace, HasError)\nTTL Hour + INTERVAL 30 DAY",
		"TRUNCATE TABLE IF EXISTS trace_facets_hourly",
		traceFacetsHourlyBackfill,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS trace_facets_hourly_mv TO trace_facets_hourly AS\nSELECT\n          ${TRACE_FACETS_PROJECTION_SQL}\n        FROM trace_list_mv\n        GROUP BY ${TRACE_FACETS_GROUP_BY}`,
	],
} as const
