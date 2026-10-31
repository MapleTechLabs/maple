/**
 * Migration 0049: `service_map_db_edges_minutely` and its view, read by
 * `serviceDbEdges` for the partial hours at the ends of a service map window
 * instead of raw `traces`.
 *
 * No backfill: the read path detects where the table's coverage starts and reads
 * raw `traces` for anything earlier, so an empty table is correct, only slower.
 * Date-partitioned, so it gets `ttl_only_drop_parts = 1` like every table in 0045.
 *
 * The CREATE statements are the verbatim DDL the schema emitter produced at v49.
 * Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0049_service_map_db_edges_minutely = {
	version: 49,
	description: "Create service_map_db_edges_minutely + its view: per-minute service-to-database edges",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS service_map_db_edges_minutely (\n    OrgId LowCardinality(String),\n    Minute DateTime,\n    ServiceName LowCardinality(String),\n    DbSystem LowCardinality(String),\n    DbNamespace LowCardinality(String),\n    DeploymentEnv LowCardinality(String),\n    CallCount SimpleAggregateFunction(sum, UInt64),\n    ErrorCount SimpleAggregateFunction(sum, UInt64),\n    DurationSumMs SimpleAggregateFunction(sum, Float64),\n    MaxDurationMs SimpleAggregateFunction(max, Float64),\n    SampleRateSum SimpleAggregateFunction(sum, Float64),\n    DurationQuantiles AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32),\n    FirstInsertedAt SimpleAggregateFunction(min, DateTime)\n)\nENGINE = AggregatingMergeTree\nPARTITION BY toDate(Minute)\nORDER BY (OrgId, Minute, DeploymentEnv, ServiceName, DbSystem, DbNamespace)\nTTL toDate(Minute) + INTERVAL 30 DAY",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_map_db_edges_minutely_mv TO service_map_db_edges_minutely AS\nSELECT\n          OrgId,\n          toStartOfMinute(toDateTime(Timestamp)) AS Minute,\n          ServiceName,\n          coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) AS DbSystem,\n          if(match(coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name'])) AS DbNamespace,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          count() AS CallCount,\n          countIf(StatusCode = 'Error') AS ErrorCount,\n          sum(Duration / 1000000) AS DurationSumMs,\n          max(Duration / 1000000) AS MaxDurationMs,\n          sum(SampleRate) AS SampleRateSum,\n          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles,\n          now() AS FirstInsertedAt\n        FROM traces\n        WHERE SpanKind IN ('Client', 'Producer')\n          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) != ''\n          AND ServiceName != ''\n        GROUP BY OrgId, Minute, ServiceName, DbSystem, DbNamespace, DeploymentEnv",
		"ALTER TABLE service_map_db_edges_minutely MODIFY SETTING ttl_only_drop_parts = 1",
	],
} as const
