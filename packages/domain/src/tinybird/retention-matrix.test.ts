import { describe, expect, it } from "vitest"
import { tinybirdProjectManifest } from "../generated/tinybird-project-manifest"
import { Array as Arr, Option, Record as Rec } from "effect"

const RETENTION_DAYS = {
	alert_checks: 365,
	// CI projections outlive their raw traces on purpose: a year of run history.
	ci_jobs: 365,
	ci_runs: 365,
	// Two years and a month: every month keeps the same month a year earlier beside it.
	cost_daily: 760,
	// Raw-tier projection of `traces`: rebuilt from it, so holding
	// it past the source's own retention would store rows detection can no
	// longer cross-check against a raw trace.
	ai_trace_index: 30,
	// Same raw-tier rule, and it matches the session_replays window the AI tab reads beside it.
	ai_crawler_requests: 30,
	// Past its 30-day sources on purpose: score trends outlive the traces they grade.
	ai_evaluations: 90,
	// Six years — HIPAA's documentation retention floor. Never rebuildable.
	audit_log: 2190,
	// Thirteen months: a year of audit history plus a month to compare against.
	audit_trail_events: 400,
	attribute_keys_hourly: 90,
	attribute_values_hourly: 90,
	error_events: 90,
	error_events_by_time: 90,
	error_fingerprints_minutely: 90,
	// Only read while a fingerprint version bump settles; the re-key needs a recent occurrence.
	error_fingerprint_lineage: 30,
	logs: 30,
	// Two weeks: a release's profile stays comparable with the previous week's.
	profiles: 14,
	logs_aggregates_hourly: 365,
	metric_catalog: 90,
	// As long as the raw metrics it rolls up.
	aws_metrics_hourly: 90,
	metrics_exponential_histogram: 90,
	metrics_gauge: 90,
	metrics_histogram: 90,
	metrics_sum: 90,
	// Raw-tier projection of `traces`, like `ai_crawler_requests`.
	scanner_requests: 30,
	// Google keeps 16 months of Search Console data; a month past that keeps a full year-over-year window.
	search_console_daily: 520,
	service_address_resolutions_hourly: 365,
	// Hour-grain only, read for windows of days; a year would be a second annual table.
	service_endpoint_details_hourly: 90,
	service_external_edges_hourly: 365,
	service_map_children: 30,
	service_map_db_edges_hourly: 365,
	// Serves only the partial hours of a map window, which raw traces answered before it: 30 like them.
	service_map_db_edges_minutely: 30,
	service_map_db_query_shapes_hourly: 365,
	service_map_edges_hourly: 365,
	service_map_spans: 30,
	service_operations_hourly: 365,
	service_operations_minutely: 90,
	service_overview_hourly: 365,
	// Only reachable for windows under ~5 days (sub-hour buckets), so 90 is
	// generous rather than tight. A second annual tier here would be a second
	// table that cannot be rebuilt past the 30-day source retention.
	service_overview_minutely: 90,
	service_overview_spans: 30,
	service_platforms_hourly: 365,
	// Read for the last week; 90 days shows when a service last changed its runtime.
	service_runtimes_hourly: 90,
	service_usage: 365,
	source_usage_hourly: 90,
	session_events: 30,
	session_replay_events: 30,
	session_replays: 30,
	span_metrics_calls_hourly: 90,
	trace_index: 30,
	// Capped at its source trace_list_mv's default and expiring each row with its span's
	// period: facet counts past the list's own window would filter the list down to nothing.
	trace_facets_hourly: 30,
	trace_list_mv: 30,
	traces: 30,
	traces_aggregates_hourly: 365,
	// Users' PII: last seen up to a quarter back, not a year; raw drill-down needs only 30.
	user_activity_hourly: 90,
	// Counts per user.id and day only (no name, email or route), as long as product_events keeps
	// the same user.id: the activity calendar's year.
	user_activity_daily: 365,
	// Browser rows past 30 days can never be rebuilt from `session_events`, but
	// direct-ingested (server/mobile) rows have no source: this table IS the copy.
	product_events: 365,
	identity_links: 365,
	// A year past a property's last write. Browser traits refresh it every session; no email or name.
	person_properties: 365,
} as const

const ZERO_RETENTION_DATASOURCES = ["service_map_edges_hourly_ingest"] as const

/** One row per span or trace, fed from `traces`: they keep what the span keeps. Rollups keep their own periods. */
const SPAN_PROJECTIONS = [
	"ai_crawler_requests",
	"ai_trace_index",
	"scanner_requests",
	"service_map_children",
	"service_map_spans",
	"service_overview_spans",
	"trace_index",
	"trace_list_mv",
] as const

/**
 * Days a datasource keeps a row: its fixed TTL or cap, or for a row-level TTL the period an
 * unstamped row gets.
 */
const keptDays = (content: string): number | undefined => {
	const fixed =
		/ENGINE_TTL "[^"]+ \+ INTERVAL (\d+) DAY"/.exec(content) ??
		/ENGINE_TTL "[^"]+ \+ toIntervalDay\(least\(RetentionDays, (\d+)\)\)"/.exec(content)
	const perRow = /ENGINE_TTL "[^"]+ \+ toIntervalDay\(RetentionDays\)"/.test(content)
		? /\bRetentionDays UInt16 [^\n]*DEFAULT (\d+)/.exec(content)
		: null
	const days = fixed?.[1] ?? perRow?.[1]
	return days === undefined ? undefined : Number(days)
}

describe("Tinybird retention matrix", () => {
	it("assigns every stored datasource to the intended tier, a raw row its default period", () => {
		const actualNames = Arr.map(tinybirdProjectManifest.datasources, ({ name }) => name).sort()
		expect(actualNames).toEqual([...Rec.keys(RETENTION_DAYS), ...ZERO_RETENTION_DATASOURCES].sort())

		for (const [name, expectedDays] of Rec.toEntries(RETENTION_DAYS)) {
			const datasource = Option.getOrUndefined(
				Arr.findFirst(tinybirdProjectManifest.datasources, (candidate) => candidate.name === name),
			)
			expect(datasource, name).toBeDefined()
			expect(keptDays(datasource!.content), datasource!.name).toBe(expectedDays)
		}
	})

	it("expires a row-level projection of traces with its span, at the span's own period", () => {
		for (const name of SPAN_PROJECTIONS) {
			const content = Option.getOrUndefined(
				Arr.findFirst(tinybirdProjectManifest.datasources, (candidate) => candidate.name === name),
			)?.content
			expect(content, name).toMatch(/ENGINE_PARTITION_KEY "\(RetentionDays, toDate\(\w+\)\)"/)
			expect(content, name).toMatch(/ENGINE_TTL "toDate\(\w+\) \+ toIntervalDay\(RetentionDays\)"/)
			expect(content, name).toContain(`ENGINE_SETTINGS "ttl_only_drop_parts=1"`)
		}
		const fedByTraces = Arr.filter(tinybirdProjectManifest.pipes, (pipe) =>
			Arr.some(SPAN_PROJECTIONS, (name) =>
				new RegExp(`\\nDATASOURCE ${name}(\\n|$)`).test(pipe.content),
			),
		)
		expect(fedByTraces).toHaveLength(SPAN_PROJECTIONS.length)
		for (const pipe of fedByTraces) {
			expect(pipe.content, pipe.name).toMatch(/\bRetentionDays\n\s+FROM traces\b/)
		}
	})

	it("does not retain Null-engine ingestion bridges", () => {
		for (const name of ZERO_RETENTION_DATASOURCES) {
			const datasource = Option.getOrUndefined(
				Arr.findFirst(tinybirdProjectManifest.datasources, (candidate) => candidate.name === name),
			)
			expect(datasource, name).toBeDefined()
			expect(datasource?.content, name).toContain("ENGINE Null")
			expect(datasource?.content, name).not.toContain("ENGINE_TTL")
		}
	})

	/**
	 * A materialized view whose target outlives its source cannot be rebuilt.
	 *
	 * Tinybird's default for a changed MV node is to REPLAY the source into the
	 * target. For these two that means `traces` (30 days) into a 90-day rollup,
	 * and that 90-day rollup into a 365-day one — so the deploy warns and then
	 * drops history that no longer exists anywhere to be reconstructed from.
	 * `DEPLOYMENT_METHOD alter` applies additive column changes in place with no
	 * data movement, which is the only correct shape here. Migration 0023's first
	 * deploy attempt failed on exactly this.
	 */
	it("applies service-operations, service-overview, endpoint-details and user-activity rollup changes by ALTER, never by rebuild", () => {
		for (const name of [
			"service_operations_minutely_mv",
			"service_operations_hourly_mv",
			"service_overview_minutely_mv",
			"service_overview_hourly_mv",
			"service_endpoint_details_hourly_mv",
			"user_activity_hourly_traces_mv",
			"user_activity_hourly_logs_mv",
		]) {
			const pipe = Option.getOrUndefined(
				Arr.findFirst(tinybirdProjectManifest.pipes, (candidate) => candidate.name === name),
			)
			expect(pipe, name).toBeDefined()
			expect(pipe?.content, name).toContain("DEPLOYMENT_METHOD alter")
		}
	})

	/**
	 * The error views also replay 30-day `traces` into 90-day targets, and a rebuild
	 * recomputes FingerprintHash for every stored row, re-keying every issue. The
	 * fingerprint fixes in #2071 sat undeployable behind this refusal.
	 */
	it("applies error-events view changes by ALTER, never by rebuild", () => {
		for (const name of ["error_events_mv", "error_events_by_time_mv"]) {
			const pipe = Option.getOrUndefined(
				Arr.findFirst(tinybirdProjectManifest.pipes, (candidate) => candidate.name === name),
			)
			expect(pipe, name).toBeDefined()
			expect(pipe?.content, name).toContain("DEPLOYMENT_METHOD alter")
		}
	})
})
