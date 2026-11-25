/**
 * Migration 0075: `RetentionDays` on the raw tables, the days a row is stored for. Each default
 * is the period the table keeps today and nothing reads the column yet, so no TTL changes.
 * `product_events` is left out: views fill it, and it gets the column when it is rebuilt.
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
		"ALTER TABLE profiles ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT 14",
	],
} as const
