/**
 * Migration 0043: the `idx_span_name` bloom index on `traces`.
 *
 * The snapshot re-sorts `traces` by `(OrgId, ServiceName, 5-minute bucket,
 * TraceId)`, which drops `SpanName` from the key; the index keeps rare-name
 * filters pruning granules. Only new installs get the new key: a sort key cannot
 * be altered in place, and existing clusters keep the old one, which still
 * answers every query (the `trace_index` lookup is a filter, not a key seek).
 *
 * Unmaterialized: parts written before this migration are read without it
 * until they merge, which only costs pruning.
 */
export const migration_0043_traces_span_name_index = {
	version: 43,
	description: "Add the idx_span_name bloom index to traces",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE traces ADD INDEX IF NOT EXISTS idx_span_name SpanName TYPE bloom_filter(0.01) GRANULARITY 1",
	],
} as const
