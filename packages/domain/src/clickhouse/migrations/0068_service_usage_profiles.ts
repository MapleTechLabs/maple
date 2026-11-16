// Migration 0068: profile counts and estimated bytes on `service_usage`, fed by a view from `profiles`, so
// the billing page's daily usage includes continuous profiling. No backfill: earlier hours hold 0. Frozen v68 DDL.
export const migration_0068_service_usage_profiles = {
	version: 68,
	description: "Add ProfileCount and ProfileSizeBytes to service_usage and create its view from profiles",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE service_usage ADD COLUMN IF NOT EXISTS ProfileCount UInt64 DEFAULT 0",
		"ALTER TABLE service_usage ADD COLUMN IF NOT EXISTS ProfileSizeBytes UInt64 DEFAULT 0",
		"DROP VIEW IF EXISTS service_usage_profiles_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_usage_profiles_mv TO service_usage AS\nSELECT\n          OrgId,\n          ServiceName,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          0 AS LogCount,\n          0 AS LogSizeBytes,\n          0 AS TraceCount,\n          0 AS TraceSizeBytes,\n          0 AS SumMetricCount,\n          0 AS SumMetricSizeBytes,\n          0 AS GaugeMetricCount,\n          0 AS GaugeMetricSizeBytes,\n          0 AS HistogramMetricCount,\n          0 AS HistogramMetricSizeBytes,\n          0 AS ExpHistogramMetricCount,\n          0 AS ExpHistogramMetricSizeBytes,\n          count() AS ProfileCount,\n          sum(length(Frames) * 16 + 200) AS ProfileSizeBytes\n        FROM profiles\n        GROUP BY OrgId, ServiceName, Hour",
	],
} as const
