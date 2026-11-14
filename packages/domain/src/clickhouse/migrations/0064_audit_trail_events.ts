// Migration 0064: `audit_trail_events`, audit events from connected platforms and Maple itself.
// Written through the managed ingest pipeline (pinned like `audit_log`), so a BYO cluster only
// mirrors the empty table and it never gates ingest. Frozen v64 DDL.
export const migration_0064_audit_trail_events = {
	version: 64,
	description: "Create audit_trail_events, normalized audit events from connected platforms",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS audit_trail_events (\n    OrgId LowCardinality(String),\n    Id String,\n    OccurredAt DateTime64(3),\n    IngestedAt DateTime64(3),\n    Provider LowCardinality(String),\n    Account String,\n    ProviderEventId String,\n    ActorType LowCardinality(String),\n    ActorId String,\n    ActorName String,\n    ActorEmail String,\n    Action LowCardinality(String),\n    Category LowCardinality(String),\n    Outcome LowCardinality(String),\n    OutcomeReason String,\n    TargetType LowCardinality(String),\n    TargetId String,\n    TargetName String,\n    OriginIp String,\n    OriginCountry LowCardinality(String),\n    UserAgent String,\n    Raw String,\n    Version UInt64,\n    INDEX idx_ingested_at IngestedAt TYPE minmax GRANULARITY 1\n)\nENGINE = ReplacingMergeTree\nPARTITION BY toYYYYMM(OccurredAt)\nORDER BY (OrgId, OccurredAt, Id)\nTTL toDate(OccurredAt) + INTERVAL 400 DAY",
		"ALTER TABLE audit_trail_events MODIFY SETTING ttl_only_drop_parts = 1",
	],
} as const
