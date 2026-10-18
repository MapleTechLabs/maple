import type { BackfillSpec } from "../backfill"

const TRACE_INDEX_PROJECTION_SQL = `OrgId,
          TraceId,
          ServiceName,
          toStartOfFiveMinutes(Timestamp) AS Bucket,
          min(Timestamp) AS MinTimestamp,
          max(Timestamp) AS MaxTimestamp`

const TRACE_INDEX_GROUP_BY = "OrgId, TraceId, ServiceName, Bucket"

/** Indexes the 30 days `traces` retains. Day chunks never split a 5-minute bucket. */
export const traceIndexBackfill: BackfillSpec = {
	kind: "backfill",
	target: "trace_index",
	columns: ["OrgId", "TraceId", "ServiceName", "Bucket", "MinTimestamp", "MaxTimestamp"],
	from: "traces",
	tsColumn: "Timestamp",
	select: TRACE_INDEX_PROJECTION_SQL,
	groupBy: TRACE_INDEX_GROUP_BY,
}

/**
 * Migration 0042: `trace_index`, where each trace's spans live in `traces`,
 * the lookup that replaces the TraceId-sorted copy `trace_detail_spans`.
 *
 * The view is created BEFORE the backfill, unlike 0034: a span the gap missed
 * would make its trace unfindable, while a row both write merges on min/max.
 * For the same reason a re-apply needs no truncate.
 *
 * The CREATE statements are the verbatim DDL the schema emitter produced at v42.
 * Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0042_trace_index = {
	version: 42,
	description: "Create trace_index + trace_index_mv: where each trace's spans live in traces",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS trace_index (\n    OrgId LowCardinality(String),\n    TraceId String,\n    ServiceName LowCardinality(String),\n    Bucket DateTime,\n    MinTimestamp SimpleAggregateFunction(min, DateTime64(9)),\n    MaxTimestamp SimpleAggregateFunction(max, DateTime64(9))\n)\nENGINE = AggregatingMergeTree\nPARTITION BY toDate(Bucket)\nORDER BY (OrgId, TraceId, ServiceName, Bucket)\nTTL toDate(Bucket) + INTERVAL 30 DAY",
		`CREATE MATERIALIZED VIEW IF NOT EXISTS trace_index_mv TO trace_index AS\nSELECT\n          ${TRACE_INDEX_PROJECTION_SQL}\n        FROM traces\n        GROUP BY ${TRACE_INDEX_GROUP_BY}`,
		traceIndexBackfill,
	],
} as const
