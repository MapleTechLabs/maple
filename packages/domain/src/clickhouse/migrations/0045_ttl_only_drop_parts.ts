/**
 * Migration 0045: expire whole parts instead of rewriting them.
 *
 * Every date-partitioned table gets `ttl_only_drop_parts = 1`, so TTL eviction
 * drops a part once all of its rows are expired instead of rewriting it to
 * delete some. Tables partitioned by `tuple()` or nothing (`identity_links`,
 * `service_usage`) are left out: their parts never fully expire, so the
 * setting would stop eviction there.
 *
 * The TTLs that keyed off a raw timestamp move to `toDate(...)`, the
 * expression their partition uses, so a day's rows expire together. The
 * setting goes first, so eviction under the new TTLs already drops whole parts.
 */
const partitionedTables = [
	"logs",
	"traces",
	"service_map_spans",
	"service_map_children",
	"service_map_edges_hourly",
	"service_map_db_edges_hourly",
	"service_map_db_query_shapes_hourly",
	"service_external_edges_hourly",
	"service_address_resolutions_hourly",
	"service_platforms_hourly",
	"service_overview_spans",
	"service_overview_hourly",
	"service_overview_minutely",
	"error_events",
	"error_events_by_time",
	"error_fingerprints_minutely",
	"trace_list_mv",
	"trace_facets_hourly",
	"trace_index",
	"ai_trace_index",
	"ai_crawler_requests",
	"metrics_sum",
	"metrics_gauge",
	"metrics_histogram",
	"metrics_exponential_histogram",
	"metric_catalog",
	"attribute_keys_hourly",
	"attribute_values_hourly",
	"alert_checks",
	"audit_log",
	"service_operations_minutely",
	"service_operations_hourly",
	"traces_aggregates_hourly",
	"span_metrics_calls_hourly",
	"logs_aggregates_hourly",
	"session_replays",
	"session_replay_events",
	"session_events",
	"product_events",
] as const

const alignedTtls = [
	["service_map_spans", "toDate(Timestamp) + INTERVAL 30 DAY"],
	["service_map_children", "toDate(Timestamp) + INTERVAL 30 DAY"],
	["service_overview_spans", "toDate(Timestamp) + INTERVAL 30 DAY"],
	["error_events", "toDate(Timestamp) + INTERVAL 90 DAY"],
	["error_events_by_time", "toDate(Timestamp) + INTERVAL 90 DAY"],
	["error_fingerprints_minutely", "toDate(Minute) + INTERVAL 90 DAY"],
	["trace_list_mv", "toDate(Timestamp) + INTERVAL 30 DAY"],
	["trace_facets_hourly", "toDate(Hour) + INTERVAL 30 DAY"],
	["metric_catalog", "toDate(Hour) + INTERVAL 90 DAY"],
	["attribute_keys_hourly", "toDate(Hour) + INTERVAL 90 DAY"],
	["attribute_values_hourly", "toDate(Hour) + INTERVAL 90 DAY"],
] as const

export const migration_0045_ttl_only_drop_parts = {
	version: 45,
	description: "Drop wholly expired parts on TTL, and align raw-timestamp TTLs to their daily partitions",
	requiredForIngest: false,
	statements: [
		...partitionedTables.map((table) => `ALTER TABLE ${table} MODIFY SETTING ttl_only_drop_parts = 1`),
		...alignedTtls.map(([table, ttl]) => `ALTER TABLE ${table} MODIFY TTL ${ttl}`),
	],
} as const
