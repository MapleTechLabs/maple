// Migration 0063: `cost_daily`, cloud cost per day pulled from each provider's billing data through
// the managed ingest pipeline (pinned like `search_console_daily`), shipped so every ClickHouse mirrors
// the managed table. Nothing writes it in a BYO cluster, so it never gates ingest. Frozen v63 DDL.
export const migration_0063_cost_daily = {
	version: 63,
	description: "Create cost_daily, cloud cost per day, cloud service, usage type, region and resource",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS cost_daily (\n    OrgId LowCardinality(String),\n    SourceId LowCardinality(String),\n    Provider LowCardinality(String),\n    AccountId LowCardinality(String),\n    Date DateTime,\n    CloudService LowCardinality(String),\n    ServiceCategory LowCardinality(String),\n    UsageType LowCardinality(String),\n    Region LowCardinality(String),\n    ResourceId String,\n    ResourceType LowCardinality(String),\n    ServiceName LowCardinality(String),\n    ChargeCategory LowCardinality(String),\n    Basis LowCardinality(String),\n    Currency LowCardinality(String),\n    BilledCost Float64,\n    EffectiveCost Float64,\n    ListCost Float64,\n    ConsumedQuantity Float64,\n    ConsumedUnit LowCardinality(String),\n    Tags Map(LowCardinality(String), String),\n    Estimated UInt8,\n    IngestedAt DateTime64(3)\n)\nENGINE = ReplacingMergeTree\nPARTITION BY toYYYYMM(Date)\nORDER BY (OrgId, SourceId, Date, CloudService, UsageType, Region, ResourceId, ChargeCategory, AccountId, ServiceName, Currency)\nTTL toDate(Date) + INTERVAL 760 DAY",
		"ALTER TABLE cost_daily MODIFY SETTING ttl_only_drop_parts = 1",
	],
} as const
