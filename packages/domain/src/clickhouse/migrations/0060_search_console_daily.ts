// Migration 0060: `search_console_daily`, Google Search Console performance imported daily through the
// managed ingest pipeline (pinned like `audit_log`), shipped so every ClickHouse mirrors the managed
// table. Nothing writes it in a BYO cluster, so it never gates ingest. Frozen v60 DDL.
export const migration_0060_search_console_daily = {
	version: 60,
	description:
		"Create search_console_daily, Google Search Console clicks, impressions and position per day",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS search_console_daily (\n    OrgId LowCardinality(String),\n    SiteUrl LowCardinality(String),\n    Grain LowCardinality(String),\n    SearchType LowCardinality(String),\n    Date DateTime,\n    Page String,\n    Query String,\n    Country LowCardinality(String),\n    Device LowCardinality(String),\n    Clicks UInt64,\n    Impressions UInt64,\n    PositionSum Float64,\n    IngestedAt DateTime64(3)\n)\nENGINE = ReplacingMergeTree\nPARTITION BY toYYYYMM(Date)\nORDER BY (OrgId, SiteUrl, Grain, SearchType, Date, Page, Query, Country, Device)\nTTL toDate(Date) + INTERVAL 520 DAY",
		"ALTER TABLE search_console_daily MODIFY SETTING ttl_only_drop_parts = 1",
	],
} as const
