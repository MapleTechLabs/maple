// Migration 0067: `profiles`, continuous profiling samples flattened from OTLP profiles at ingest.
// Written through the managed ingest pipeline for now, so a BYO cluster only mirrors the empty
// table and it never gates ingest. Frozen v67 DDL.
export const migration_0067_profiles = {
	version: 67,
	description: "Create profiles, one row per call stack per exported profile",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS profiles (\n    OrgId LowCardinality(String),\n    Timestamp DateTime64(9),\n    ServiceName LowCardinality(String),\n    ServiceVersion LowCardinality(String) DEFAULT '',\n    Environment LowCardinality(String) DEFAULT '',\n    ServiceInstanceId String DEFAULT '',\n    ResourceAttributes Map(LowCardinality(String), String),\n    ProfileId String DEFAULT '',\n    SampleType LowCardinality(String),\n    SampleUnit LowCardinality(String),\n    Value Int64,\n    Samples UInt64 DEFAULT 0,\n    DurationNano UInt64 DEFAULT 0,\n    Frames Array(LowCardinality(String)),\n    FrameFiles Array(LowCardinality(String)),\n    FrameLines Array(Int32),\n    TraceId String DEFAULT '',\n    SpanId String DEFAULT '',\n    SampleAttributes Map(LowCardinality(String), String),\n    StackHash UInt64 DEFAULT cityHash64(Frames, FrameFiles, FrameLines),\n    INDEX idx_span_id SpanId TYPE bloom_filter(0.01) GRANULARITY 1,\n    INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1\n)\nENGINE = MergeTree\nPARTITION BY toDate(Timestamp)\nORDER BY (OrgId, ServiceName, SampleType, toStartOfHour(Timestamp), StackHash)\nTTL toDate(Timestamp) + INTERVAL 14 DAY",
		"ALTER TABLE profiles MODIFY SETTING ttl_only_drop_parts = 1",
	],
} as const
