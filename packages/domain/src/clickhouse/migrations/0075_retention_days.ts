/**
 * Migration 0075: `RetentionDays` on the eleven raw tables, the days a row is stored for. Each
 * default is the period the table keeps today and nothing reads the column yet, so no TTL changes.
 * The two `product_events` views are recreated to write it: `ALTER` first, then the views.
 *
 * `requiredForIngest: false`: the gateway's insert never names the column
 * (`INGEST_UNWRITTEN_COLUMNS` in `tinybird/ingest-token.ts`), so a cluster below 75 keeps
 * ingesting. Frozen v75 DDL: never re-derive it from a later snapshot.
 */
export const migration_0075_retention_days = {
	version: 75,
	description: "Add RetentionDays to the raw tables, defaulted to the period each keeps today",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE traces ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 30",
		"ALTER TABLE logs ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 30",
		"ALTER TABLE metrics_sum ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 90",
		"ALTER TABLE metrics_gauge ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 90",
		"ALTER TABLE metrics_histogram ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 90",
		"ALTER TABLE metrics_exponential_histogram ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 90",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 30",
		"ALTER TABLE session_replay_events ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 30",
		"ALTER TABLE session_events ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 30",
		"ALTER TABLE product_events ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 365",
		"ALTER TABLE profiles ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 14",
		"DROP VIEW IF EXISTS product_events_mv",
		"DROP VIEW IF EXISTS product_events_traces_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS product_events_mv TO product_events AS\nSELECT\n          OrgId,\n          Timestamp,\n          'browser' AS Source,\n          SessionId,\n          Seq,\n          VisitorId,\n          UserId,\n          GroupId,\n          Type AS Kind,\n          if(Type = 'navigation', '$pageview', Message) AS EventName,\n          domain(Url) AS Host,\n          path(Url) AS PagePath,\n          Url,\n          '' AS ServiceName,\n          Attributes,\n          '' AS TraceId,\n          '' AS SpanId,\n          toUInt16(365) AS RetentionDays\n        FROM session_events\n        WHERE Type IN ('navigation', 'custom')",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS product_events_traces_mv TO product_events AS\nSELECT\n          OrgId,\n  Timestamp,\n  'trace' AS Source,\n  SpanAttributes['session.id'] AS SessionId,\n  0 AS Seq,\n  SpanAttributes['maple.product_event.visitor_id'] AS VisitorId,\n  SpanAttributes['maple.product_event.user_id'] AS UserId,\n  SpanAttributes['maple.product_event.group_id'] AS GroupId,\n  'custom' AS Kind,\n  SpanAttributes['maple.product_event.name'] AS EventName,\n  domain(SpanAttributes['maple.product_event.url']) AS Host,\n  path(SpanAttributes['maple.product_event.url']) AS PagePath,\n  SpanAttributes['maple.product_event.url'] AS Url,\n  ServiceName,\n  mapUpdate(\n    CAST(\n      mapFilter(\n        (k, v) -> NOT startsWith(k, 'maple.product_event.')\n          AND (\n            NOT has(mapKeys(SpanAttributes), 'maple.product_event.include')\n            OR has(\n              arrayMap(\n                key -> trimBoth(key),\n                splitByChar(',', SpanAttributes['maple.product_event.include'])\n              ),\n              k\n            )\n          ),\n        SpanAttributes\n      ),\n      'Map(String, String)'\n    ),\n    mapApply(\n      (k, v) -> (substring(k, 26), v),\n      mapFilter((k, v) -> startsWith(k, 'maple.product_event.prop.'), SpanAttributes)\n    )\n  ) AS Attributes,\n  TraceId,\n  SpanId,\n  toUInt16(365) AS RetentionDays\n        FROM traces\n        WHERE SpanAttributes['maple.product_event.name'] != ''",
	],
} as const
