/**
 * Migration 0033: keep legacy `db.system`-only spans off the external edges.
 *
 * `service_map_db_edges_hourly_mv` selects DB spans with the `db.system.name`
 * -> `db.system` coalesce, but `service_external_edges_hourly_mv` excluded them
 * on `db.system.name` alone. A Client span setting only the legacy key landed in
 * both rollups, so the service map drew it as a database AND an HTTP target.
 * The MV now excludes on the same coalesce as the db MV and the raw read branch.
 *
 * NOTHING IS BACKFILLED. Sealed hours keep their phantom external rows until
 * they age out; new hours and the raw splice edges are correct immediately.
 *
 * `requiredForIngest: false`: the gateway never writes this target. The MV body
 * is a frozen copy of the snapshot as of this migration (see 0019).
 */
export const migration_0033_external_edges_legacy_db_system = {
	version: 33,
	description:
		"Recreate service_external_edges_hourly_mv so spans with only the legacy db.system attribute are excluded like db.system.name spans",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS service_external_edges_hourly_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_external_edges_hourly_mv TO service_external_edges_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          ServiceName,\n          multiIf(\n            coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != '', 'messaging',\n            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', 'rpc',\n            'http'\n          ) AS TargetType,\n          multiIf(\n            coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != '', SpanAttributes['messaging.system'],\n            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', SpanAttributes['rpc.system'],\n            ''\n          ) AS TargetSystem,\n          multiIf(\n            coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != '',\n              if(coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '', coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']), SpanAttributes['messaging.system']),\n            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '',\n              if(SpanAttributes['rpc.service'] != '', SpanAttributes['rpc.service'], SpanAttributes['rpc.system']),\n            if(SpanAttributes['server.address'] != '',\n              SpanAttributes['server.address'],\n              if(SpanAttributes['http.host'] != '',\n                SpanAttributes['http.host'],\n                SpanAttributes['url.authority']))\n          ) AS TargetName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          count() AS CallCount,\n          countIf(StatusCode = 'Error') AS ErrorCount,\n          sum(Duration / 1000000) AS DurationSumMs,\n          max(Duration / 1000000) AS MaxDurationMs,\n          sum(SampleRate) AS SampleRateSum,\n          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles\n        FROM traces\n        WHERE SpanKind IN ('Client', 'Producer')\n          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) = ''\n          AND ServiceName != ''\n          AND (\n               SpanAttributes['server.address'] != ''\n            OR SpanAttributes['http.host'] != ''\n            OR SpanAttributes['url.authority'] != ''\n            OR coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != ''\n            OR SpanAttributes['messaging.system'] != ''\n            OR SpanAttributes['rpc.service'] != ''\n            OR SpanAttributes['rpc.system'] != ''\n          )\n        GROUP BY OrgId, Hour, ServiceName, TargetType, TargetSystem, TargetName, DeploymentEnv\n        HAVING TargetName != ''",
	],
} as const
