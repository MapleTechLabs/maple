/**
 * Migration 0044: drop `trace_detail_spans`, the TraceId-sorted copy of `traces`.
 * Every trace-id read seeks `traces` through `trace_index` (0042) now.
 *
 * The view goes before its table: dropping the target first leaves a view
 * whose inserts fail with UNKNOWN_TABLE, which wedges ingest into `traces`.
 */
export const migration_0044_drop_trace_detail_spans = {
	version: 44,
	description: "Drop trace_detail_spans and its view; trace-id reads seek traces through trace_index",
	requiredForIngest: false,
	statements: ["DROP VIEW IF EXISTS trace_detail_spans_mv", "DROP TABLE IF EXISTS trace_detail_spans"],
} as const
