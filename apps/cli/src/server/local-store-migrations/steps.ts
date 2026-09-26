// The local-store migration chain after v0 -> v1, one row per schema version.
// Append-only: a row's id, versions, operations and journal keys are what an
// unfinished migration resumes against, so never edit a row that has shipped.
import {
	PRODUCT_EVENTS_BROWSER_BACKFILL,
	PRODUCT_EVENTS_SOURCE_FILTER,
	IDENTITY_LINKS_SOURCE_FILTER,
	PRODUCT_EVENTS_TRACE_BACKFILL,
	PRODUCT_EVENTS_TRACE_FILTER,
	errorRollupBackfill,
} from "./backfills"
import {
	addColumns,
	addIndex,
	backfill,
	dropColumns,
	dropTables,
	dropViews,
	unchangedRowCount,
	type StepSpec,
} from "./step-executor"
import type { StateDispositionEntry } from "../local-store-migration-module"

/** Existing rollup rows keep what the old view bodies wrote and age out with their TTL. */
const ERROR_RETENTION = {
	preservationInterval: "error retention horizon",
	sourceRetentionDays: 90,
	targetRetentionDays: 90,
} as const

const TRACES_UNDER_REPLACED_VIEWS: StateDispositionEntry = {
	name: "traces",
	classification: "authoritative",
	disposition: "preserve-exact",
	guarantee:
		"The source of the replaced views is neither read nor rewritten; only the view definitions change.",
}

const ERROR_EVENTS_BY_TIME_FORWARD_ONLY: StateDispositionEntry = {
	name: "error_events_by_time",
	classification: "derived",
	disposition: "rebuild-within-retention-horizon",
	guarantee:
		"Same projection as error_events and treated identically: preserved rows, forward-only correction.",
	...ERROR_RETENTION,
}

const AI_TRACE_INDEX_SOURCE: StateDispositionEntry = {
	name: "traces",
	classification: "authoritative",
	disposition: "preserve-exact",
	guarantee:
		"The source of the replaced view is neither read nor rewritten; only the view definition and the index's column list change.",
}

/** New ai_trace_index columns fill forward only, bounded by the 30-day TTL. */
const AI_TRACE_INDEX_FORWARD = {
	preservationInterval: "from the migration forward",
	sourceRetentionDays: 30,
	targetRetentionDays: 30,
} as const

export const LOCAL_STORE_STEPS: ReadonlyArray<StepSpec> = [
	{
		id: "local-0001-to-0002-error-rollup",
		from: 1,
		to: 2,
		description: "Add the durable minutely error-fingerprint rollup to a v1 local store",
		clonedBefore: "target-only DDL changes",
		beforeBootstrap: [
			dropTables(
				"error_fingerprints_minutely_mv",
				"error_fingerprints_minutely",
				"error_events_by_time_mv",
			),
		],
		custom: errorRollupBackfill,
		plan: [
			[
				"replace-error-rollups",
				"Replace the error fan-out view and backfill the minutely fingerprint rollup",
			],
		],
		verifies: "Verify the v2 physical schema, raw telemetry, and error rollup totals",
		dispositions: [
			{
				name: "error_fingerprints_minutely",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee: "The new rollup is rebuilt from retained canonical error_events rows.",
				preservationInterval: "error_events retention horizon",
				sourceRetentionDays: 90,
				targetRetentionDays: 90,
			},
		],
	},
	{
		// The long-lived error view stays triggered by traces; only the new
		// fingerprint rollup cascades from error_events.
		id: "local-0002-to-0003-service-map-ingest-bridge",
		from: 2,
		to: 3,
		description:
			"Restore the deployment-safe error view trigger and add the service-map ingress bridge to v2",
		clonedBefore: "additive DDL runs",
		beforeBootstrap: [dropTables("error_events_by_time_mv")],
		plan: [
			[
				"install-v3-materializations",
				"Restore the deployed error view trigger and install the service-map ingress bridge",
			],
		],
		verifies: "Verify the v3 physical schema and retained raw telemetry counts",
		dispositions: [
			{
				name: "service_map_edges_hourly",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"The existing aggregate target and its historical rows are not rebuilt or rewritten.",
			},
			{
				name: "error_events_by_time",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Only its insert-trigger view is recreated; all time-ordered historical error rows remain untouched.",
			},
		],
	},
	{
		// Purely additive, and never backfilled: the raw session_events read path
		// covers the window until the shared 30-day TTL makes the rollup complete.
		id: "local-0003-to-0004-web-events",
		from: 3,
		to: 4,
		description: "Add the web_events analytics fact table and its materialized view to v3",
		clonedBefore: "additive DDL runs",
		plan: [["install-web-events", "Install the web_events fact table and its materialized view"]],
		verifies: "Verify the v4 physical schema and retained raw telemetry counts",
		dispositions: [
			{
				name: "session_events",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"The source of the new view is neither read nor rewritten; web_events fills from writes made after the migration.",
			},
			{
				name: "web_events",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Filled forward from session_events writes; complete by construction once the shared 30-day retention horizon passes, with the raw read path covering the interim.",
				preservationInterval: "session_events retention horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
		],
	},
	{
		// Purely additive and filled forward only: the minute tier is read for
		// windows under ~5 days, and the hourly tier answers in the interim.
		id: "local-0004-to-0005-service-overview-minutely",
		from: 4,
		to: 5,
		description: "Add the service_overview_minutely rollup and its materialized view to v4",
		clonedBefore: "additive DDL runs",
		plan: [
			[
				"install-service-overview-minutely",
				"Install the service_overview_minutely rollup and its materialized view",
			],
		],
		verifies: "Verify the v5 physical schema and retained raw telemetry counts",
		dispositions: [
			{
				name: "traces",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"The source of the new view is neither read nor rewritten; service_overview_minutely fills from writes made after the migration.",
			},
			{
				name: "service_overview_minutely",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Filled forward from traces writes; complete by construction once the ~5-day sub-hour bucket horizon passes, with the hourly tier and raw edge covering the interim.",
				preservationInterval: "sub-hour bucket horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 90,
			},
		],
	},
	{
		// A view's SELECT is frozen at creation, so a changed body is dropped before
		// the IF NOT EXISTS bootstrap; dropping a view never touches its target's rows.
		id: "local-0005-to-0006-error-events-fingerprint-hygiene",
		from: 5,
		to: 6,
		description:
			"Rebuild the error-events views: exclude exception-less 4xx client spans and redact ids from fingerprint frames",
		clonedBefore: "the views are replaced",
		beforeBootstrap: [dropTables("error_events_mv", "error_events_by_time_mv")],
		plan: [
			[
				"rebuild-error-events-views",
				"Drop and recreate the error-events views with the 4xx guard and widened id redaction",
			],
		],
		verifies: "Verify the v6 physical schema and retained raw telemetry counts",
		dispositions: [
			TRACES_UNDER_REPLACED_VIEWS,
			{
				name: "error_events",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched; the corrected fingerprint and 4xx exclusion apply to events materialized after the migration and converge as the retention window rolls.",
				...ERROR_RETENTION,
			},
			ERROR_EVENTS_BY_TIME_FORWARD_ONLY,
		],
	},
	{
		// ADD COLUMN is what widens an existing table; the bootstrap's CREATE TABLE
		// IF NOT EXISTS is a no-op against it. Metadata-only, no part is rewritten.
		id: "local-0006-to-0007-error-service-version",
		from: 6,
		to: 7,
		description:
			"Add ServiceVersion to the error-events tables and rebuild the error-events views on fingerprint v2",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			dropTables("error_events_mv", "error_events_by_time_mv", "error_fingerprints_minutely_mv"),
			addColumns("error_events", [["ServiceVersion", "LowCardinality(String)"]]),
			addColumns("error_events_by_time", [["ServiceVersion", "LowCardinality(String)"]]),
			addColumns("error_fingerprints_minutely", [
				["ServiceVersions", "SimpleAggregateFunction(groupUniqArrayArray, Array(String))"],
			]),
		],
		plan: [
			[
				"widen-error-tables",
				"Add ServiceVersion to the error-events tables and rebuild the error-events views",
			],
		],
		verifies: "Verify the v7 physical schema and retained raw telemetry counts",
		dispositions: [
			{
				name: "traces",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"The source of the replaced views is neither read nor rewritten; only the view definitions and the error tables' column list change.",
			},
			{
				name: "error_events",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched with an empty ServiceVersion; the v2 fingerprint and the build attribution apply to events materialized after the migration and converge as the retention window rolls.",
				...ERROR_RETENTION,
			},
			ERROR_EVENTS_BY_TIME_FORWARD_ONLY,
			{
				name: "error_fingerprints_minutely",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Minute-grain rollup cascaded from error_events; preserved rows keep an empty ServiceVersion and new minutes carry the emitting build.",
				...ERROR_RETENTION,
			},
		],
	},
	{
		id: "local-0007-to-0008-apple-crash-frames",
		from: 7,
		to: 8,
		description: "Rebuild the error-events views so the fingerprint recognises Apple crash frames",
		clonedBefore: "the views are replaced",
		beforeBootstrap: [dropTables("error_events_mv", "error_events_by_time_mv")],
		plan: [
			[
				"rebuild-error-events-views",
				"Drop and recreate the error-events views with Apple crash frames in the fingerprint",
			],
		],
		verifies: "Verify the v8 physical schema and retained raw telemetry counts",
		dispositions: [
			TRACES_UNDER_REPLACED_VIEWS,
			{
				name: "error_events",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched; the Apple frame matching applies to events materialized after the migration and converges as the retention window rolls.",
				...ERROR_RETENTION,
			},
			ERROR_EVENTS_BY_TIME_FORWARD_ONLY,
		],
	},
	{
		// Physical verify fails on leftover objects and columns too, so the removed
		// ones are dropped explicitly. Every view precedes the table it writes into.
		id: "local-0008-to-0009-mv-sweep",
		from: 8,
		to: 9,
		description:
			"Drop the unread error_spans table and rebuild the trace-detail, attribute-value and span-metrics views",
		clonedBefore: "any view is replaced",
		beforeBootstrap: [
			dropTables(
				"error_spans_mv",
				"trace_detail_spans_mv",
				"log_attribute_values_mv",
				"metric_attribute_values_mv",
				"trace_span_attribute_values_mv",
				"trace_resource_attribute_values_mv",
				"span_metrics_calls_hourly_mv",
				"error_spans",
			),
			dropColumns("trace_detail_spans", ["EventsTimestamp", "EventsName", "EventsAttributes"]),
		],
		plan: [
			[
				"sweep-materialized-views",
				"Drop the unread error_spans table and rebuild the trace-detail, attribute-value and span-metrics views",
			],
		],
		verifies: "Verify the v9 physical schema and retained raw telemetry counts",
		dispositions: [
			{
				name: "traces",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"The source of every replaced view is neither read nor rewritten; only view definitions and their targets change.",
			},
			{
				name: "error_spans",
				classification: "derived",
				disposition: "invalidate",
				guarantee:
					"Dropped permanently along with its view. It had no readers: every error query reads error_events / error_events_by_time, and the rows were reproducible from traces in any case.",
			},
			{
				name: "trace_detail_spans",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Rows are preserved; the unread EventsTimestamp/EventsName/EventsAttributes columns are gone from the v9 table and converge as the 30-day window rolls.",
				preservationInterval: "trace retention horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
			{
				name: "attribute_values_hourly",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched; the cardinality bound applies to values materialized after the migration and the unbounded history ages out with the 90-day TTL.",
				preservationInterval: "attribute retention horizon",
				sourceRetentionDays: 90,
				targetRetentionDays: 90,
			},
			{
				name: "span_metrics_calls_hourly",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"The rollup was empty because its view matched a name nothing emits; it begins filling from the corrected view and is complete within the 90-day horizon.",
				preservationInterval: "metric rollup horizon",
				sourceRetentionDays: 90,
				targetRetentionDays: 90,
			},
		],
	},
	{
		// Every view pre-extracting a renamed OTel key; the TO targets are unchanged.
		id: "local-0009-to-0010-semconv-key-renames",
		from: 9,
		to: 10,
		description: "Rebuild every view that reads a renamed OTel attribute to accept both spellings",
		clonedBefore: "any view is replaced",
		beforeBootstrap: [
			dropTables(
				"error_events_by_time_mv",
				"error_events_mv",
				"logs_aggregates_hourly_mv",
				"service_external_edges_hourly_mv",
				"service_map_children_mv",
				"service_map_db_edges_hourly_mv",
				"service_map_db_query_shapes_hourly_mv",
				"service_map_spans_mv",
				"service_operations_minutely_mv",
				"service_overview_hourly_mv",
				"service_overview_minutely_mv",
				"service_overview_spans_mv",
				"service_platforms_hourly_mv",
				"trace_list_mv_mv",
				"traces_aggregates_hourly_mv",
			),
		],
		plan: [
			[
				"rebuild-semconv-rename-views",
				"Rebuild every view that reads a renamed OTel key so it accepts both spellings",
			],
		],
		verifies: "Verify the v10 physical schema and retained raw telemetry counts",
		dispositions: [
			{
				name: "traces",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"The source of every replaced view is neither read nor rewritten; only view definitions change.",
			},
			{
				name: "service and trace rollups",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched; buckets materialized after the migration resolve both the environment and the messaging destination under either semconv spelling, and rows written with an empty DeploymentEnv or a system-labelled target age out with the rollup TTL.",
				preservationInterval: "rollup retention horizon",
				sourceRetentionDays: 365,
				targetRetentionDays: 365,
			},
		],
	},
	{
		// web_events is dropped last, once product_events is backfilled from the same
		// session_events window and its writer is live. Every statement is idempotent.
		id: "local-0010-to-0011-product-events",
		from: 10,
		to: 11,
		description:
			"Add identity columns to session_events; replace web_events with the backfilled product_events table and add identity_links",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			addColumns("session_events", [
				["VisitorId", "String DEFAULT ''"],
				["UserId", "String DEFAULT ''"],
				["GroupId", "String DEFAULT ''"],
			]),
		],
		afterBootstrap: [
			backfill(...PRODUCT_EVENTS_BROWSER_BACKFILL),
			dropViews("web_events_mv"),
			dropTables("web_events"),
		],
		// identity_links merges duplicate pairs, so its count is of distinct triples.
		counts: {
			group: "sourceRows",
			measure: [
				[
					"browserEvents",
					`SELECT toString(count()) AS count FROM session_events WHERE ${PRODUCT_EVENTS_SOURCE_FILTER}`,
				],
				[
					"identityPairs",
					`SELECT toString(uniqExact(OrgId, VisitorId, UserId)) AS count FROM session_replays WHERE ${IDENTITY_LINKS_SOURCE_FILTER}`,
				],
			],
			checks: [
				{
					key: "browserEvents",
					failure: () => "source browserEvents changed between preflight and verify",
				},
				{
					key: "browserEvents",
					sql: "SELECT toString(count()) AS count FROM product_events WHERE Source = 'browser'",
					failure: (expected, found) =>
						`backfill verification failed for browserEvents: expected ${expected}, found ${found}`,
				},
				{
					key: "identityPairs",
					failure: () => "source identityPairs changed between preflight and verify",
				},
				{
					key: "identityPairs",
					sql: "SELECT toString(uniqExact(OrgId, VisitorId, UserId)) AS count FROM identity_links",
					failure: (expected, found) =>
						`backfill verification failed for identityPairs: expected ${expected}, found ${found}`,
				},
			],
		},
		plan: [
			["add-session-event-identity", "Add the VisitorId, UserId and GroupId columns to session_events"],
			[
				"install-product-events",
				"Install product_events and identity_links with their materialized views, backfill both from session_events and session_replays, then drop web_events",
			],
		],
		verifies:
			"Verify the v11 physical schema, retained raw telemetry counts, and the backfilled row counts",
		dispositions: [
			{
				name: "session_events",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"Three columns are added as metadata-only defaults; no part is rewritten and every existing row reads back unchanged with '' in the new columns.",
			},
			{
				name: "session_replays",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee: "Read once to seed identity_links; neither rewritten nor re-keyed.",
			},
			{
				name: "product_events",
				classification: "derived",
				disposition: "rebuild-complete",
				guarantee:
					"Browser rows are projected from every retained session_events row and the count is verified; the projection is the view body, so backfilled and live rows agree.",
				preservationInterval: "session_events retention horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 365,
			},
			{
				name: "identity_links",
				classification: "derived",
				disposition: "rebuild-complete",
				guarantee:
					"Every identified (VisitorId, UserId) pair in retained session_replays is linked; distinct-pair count verified against the source.",
				preservationInterval: "session_replays retention horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 365,
			},
			{
				name: "web_events",
				classification: "derived",
				disposition: "invalidate",
				guarantee:
					"Replaced by product_events, which is backfilled from the same session_events window before web_events is dropped; every reader moved in the same release.",
			},
		],
	},
	{
		// Columns and view drops both precede the bootstrap: dropping the views after
		// it deleted them outright (the native probe caught it). Nothing is backfilled.
		id: "local-0011-to-0012-service-map-edge-quantiles",
		from: 11,
		to: 12,
		description:
			"Add a sample-weighted duration t-digest to the service-map database and external edge rollups so edges report a real p95",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			addColumns("service_map_db_edges_hourly", [
				[
					"DurationQuantiles",
					"AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32)",
				],
			]),
			addColumns("service_external_edges_hourly", [
				[
					"DurationQuantiles",
					"AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32)",
				],
			]),
			dropViews("service_map_db_edges_hourly_mv", "service_external_edges_hourly_mv"),
		],
		counts: {
			group: "edgeRows",
			measure: [
				["dbEdges", "SELECT toString(count()) AS count FROM service_map_db_edges_hourly"],
				["externalEdges", "SELECT toString(count()) AS count FROM service_external_edges_hourly"],
			],
			checks: [unchangedRowCount("dbEdges"), unchangedRowCount("externalEdges")],
		},
		plan: [
			[
				"add-edge-duration-quantiles",
				"Add the DurationQuantiles t-digest column to service_map_db_edges_hourly and service_external_edges_hourly",
			],
			[
				"recreate-edge-views",
				"Recreate the two service-map edge materialized views so new rows carry a sample-weighted duration digest",
			],
		],
		verifies: "Verify the v12 physical schema, retained raw telemetry counts, and the rollup row counts",
		dispositions: [
			{
				name: "service_map_db_edges_hourly",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"One column is added as a metadata-only default; no part is rewritten, the row count is verified unchanged, and every existing row reads back with an empty digest.",
			},
			{
				name: "service_external_edges_hourly",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"One column is added as a metadata-only default; no part is rewritten and the row count is verified unchanged.",
			},
			{
				name: "service-map edge duration quantiles",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Digests accrue for buckets sealed after the migration; older buckets keep an empty state and readers fall back to the max, which is preserved alongside.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 365,
			},
		],
	},
	{
		// Only the post-migration view writes ClassifiedSpanCount, so a 0 there marks
		// an older bucket as unknown rather than none. Nothing is backfilled.
		id: "local-0012-to-0013-service-operations-discriminators",
		from: 12,
		to: 13,
		description:
			"Count server and routed spans per service operation so endpoints can be told apart from outbound calls and raw URL paths",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			addColumns("service_operations_minutely", [
				["ClassifiedSpanCount", "SimpleAggregateFunction(sum, UInt64)"],
				["ServerSpanCount", "SimpleAggregateFunction(sum, UInt64)"],
				["RoutedSpanCount", "SimpleAggregateFunction(sum, UInt64)"],
			]),
			addColumns("service_operations_hourly", [
				["ClassifiedSpanCount", "SimpleAggregateFunction(sum, UInt64)"],
				["ServerSpanCount", "SimpleAggregateFunction(sum, UInt64)"],
				["RoutedSpanCount", "SimpleAggregateFunction(sum, UInt64)"],
			]),
			dropViews("service_operations_minutely_mv", "service_operations_hourly_mv"),
		],
		counts: {
			group: "rollupRows",
			measure: [
				["minutely", "SELECT toString(count()) AS count FROM service_operations_minutely"],
				["hourly", "SELECT toString(count()) AS count FROM service_operations_hourly"],
			],
			checks: [unchangedRowCount("minutely"), unchangedRowCount("hourly")],
		},
		plan: [
			[
				"add-operation-discriminators",
				"Add the ClassifiedSpanCount, ServerSpanCount and RoutedSpanCount counters to both service-operations rollups",
			],
			[
				"recreate-operation-views",
				"Recreate both service-operations materialized views so new rows count server and routed spans",
			],
		],
		verifies: "Verify the v13 physical schema, retained raw telemetry counts, and the rollup row counts",
		dispositions: [
			{
				name: "service_operations_minutely",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Three counter columns are added as metadata-only defaults; no part is rewritten, the row count is verified unchanged, and every existing row reads back as zero, which ClassifiedSpanCount marks as unknown rather than none.",
			},
			{
				name: "service_operations_hourly",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Three counter columns are added as metadata-only defaults; no part is rewritten and the row count is verified unchanged.",
			},
			{
				name: "service-operations discriminators",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Counters accrue for buckets sealed after the migration; older buckets keep zeros, which ClassifiedSpanCount = 0 marks as unclassified so readers treat them as unknown rather than as having no server or routed spans.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 365,
			},
		],
	},
	{
		// Both objects are new, so the bootstrap's IF NOT EXISTS CREATEs are the
		// whole edge. Filled forward only, as the managed side accepts.
		id: "local-0013-to-0014-ai-trace-index",
		from: 13,
		to: 14,
		description:
			"Create ai_trace_index and its materialized view so Agent Sessions detection reads a filtered projection instead of scanning raw traces",
		clonedBefore: "any DDL runs",
		plan: [
			[
				"create-ai-trace-index",
				"Create ai_trace_index and ai_trace_index_mv via the v14 bootstrap (both new, IF NOT EXISTS)",
			],
		],
		verifies: "Verify the v14 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "ai_trace_index",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"The projection accrues for spans ingested after the migration; older agent spans stay in raw traces but are invisible to detection until they age out.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
		],
	},
	{
		id: "local-0014-to-0015-commit-sha-vcs-revision",
		from: 14,
		to: 15,
		description:
			"Rebuild the service-overview views so CommitSha reads vcs.ref.head.revision instead of the retired deployment.commit_sha",
		clonedBefore: "any view is replaced",
		beforeBootstrap: [
			dropTables(
				"service_overview_hourly_mv",
				"service_overview_minutely_mv",
				"service_overview_spans_mv",
			),
		],
		plan: [
			[
				"rebuild-commit-sha-views",
				"Rebuild the three service-overview views so CommitSha reads vcs.ref.head.revision instead of the retired deployment.commit_sha",
			],
		],
		verifies: "Verify the v15 physical schema and retained raw telemetry counts",
		dispositions: [
			{
				name: "traces",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"The source of every replaced view is neither read nor rewritten; only view definitions change.",
			},
			{
				name: "service overview rollups",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched; buckets materialized after the migration carry the commit under either key, and rows written with an empty CommitSha age out with the rollup TTL.",
				preservationInterval: "rollup retention horizon",
				sourceRetentionDays: 365,
				targetRetentionDays: 365,
			},
		],
	},
	{
		id: "local-0015-to-0016-ai-trace-index-filter-columns",
		from: 15,
		to: 16,
		description:
			"Add DeploymentEnv, Model, AgentName and ToolName to ai_trace_index and recreate its view",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			dropTables("ai_trace_index_mv"),
			addColumns("ai_trace_index", [
				["DeploymentEnv", "LowCardinality(String)"],
				["Model", "LowCardinality(String)"],
				["AgentName", "LowCardinality(String)"],
				["ToolName", "LowCardinality(String)"],
				["SpanId", "String"],
				["ParentSpanId", "String"],
				["Duration", "UInt64"],
				["IsError", "UInt8"],
				["IsLlmCall", "UInt8"],
				["IsToolCall", "UInt8"],
				["Tokens", "Float64"],
				["Cost", "Float64"],
			]),
		],
		plan: [
			[
				"widen-ai-trace-index",
				"Add the filter dimensions and per-span measures to ai_trace_index and rebuild ai_trace_index_mv to fill them",
			],
		],
		verifies: "Verify the v16 physical schema and the retained raw telemetry counts",
		dispositions: [
			AI_TRACE_INDEX_SOURCE,
			{
				name: "ai_trace_index",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched with empty filter columns; the rebuilt view fills them for spans materialized after the migration and the gap closes as the retention window rolls.",
				...AI_TRACE_INDEX_FORWARD,
			},
		],
	},
	{
		// Purely additive; local mode has no authenticated actors, so it stays empty.
		id: "local-0016-to-0017-audit-log",
		from: 16,
		to: 17,
		description: "Add the audit_log table",
		clonedBefore: "the new table is created",
		plan: [["create-audit-log", "Create the empty audit_log table by bootstrapping the v17 schema"]],
		verifies: "Verify the v17 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "audit_log",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee: "Created empty; no existing table is read, rewritten, or dropped.",
			},
		],
	},
	{
		// The backfill writes product_events directly after the bootstrap, so no view
		// double-fires. Two equalities: nothing disturbed, every annotated span arrived.
		id: "local-0017-to-0018-product-events-from-traces",
		from: 17,
		to: 18,
		description:
			"Add TraceId/SpanId to product_events and project spans annotated with maple.product_event.name into it, backfilled from retained traces",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			addColumns("product_events", [
				["TraceId", "String DEFAULT ''"],
				["SpanId", "String DEFAULT ''"],
			]),
			addIndex("product_events", "idx_trace_id TraceId TYPE bloom_filter GRANULARITY 4"),
			dropViews("product_events_traces_mv", "product_events_mv"),
		],
		afterBootstrap: [backfill(...PRODUCT_EVENTS_TRACE_BACKFILL)],
		counts: {
			group: "productEventRows",
			measure: [
				["existing", "SELECT toString(count()) AS count FROM product_events"],
				[
					"expectedTrace",
					`SELECT toString(count()) AS count FROM traces WHERE ${PRODUCT_EVENTS_TRACE_FILTER}`,
				],
			],
			checks: [
				{
					key: "existing",
					sql: "SELECT toString(count()) AS count FROM product_events WHERE Source != 'trace'",
					failure: (expected, found) =>
						`pre-existing product_events row count changed: expected ${expected}, found ${found}`,
				},
				{
					key: "expectedTrace",
					sql: "SELECT toString(count()) AS count FROM product_events WHERE Source = 'trace'",
					failure: (expected, found) =>
						`backfilled trace product_events row count mismatch: expected ${expected}, found ${found}`,
				},
			],
		},
		plan: [
			[
				"add-product-event-trace-columns",
				"Add TraceId and SpanId to product_events, plus the TraceId bloom filter the trace lookup prunes on",
			],
			[
				"backfill-annotated-spans",
				"Project every retained span carrying maple.product_event.name into product_events as a Source='trace' row",
			],
			[
				"recreate-product-event-views",
				"Recreate product_events_mv and create product_events_traces_mv so new rows carry TraceId and annotated spans keep arriving",
			],
		],
		verifies:
			"Verify the v18 physical schema, retained raw telemetry counts, and that the backfill added exactly the annotated spans and disturbed no existing row",
		dispositions: [
			{
				name: "traces",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"Read-only source of the backfill; the row count is verified unchanged alongside every other raw telemetry table.",
			},
			{
				name: "product_events (browser, server and mobile rows)",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Two columns are added as metadata-only defaults, no part is rewritten, and the count of rows whose Source is not 'trace' is verified unchanged after the backfill. Counts, not contents: the byte-level claim rests on ADD COLUMN being metadata-only, which this edge does not independently verify.",
			},
			{
				name: "product_events (trace rows)",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Every annotated span still inside raw traces retention is re-projected, and the resulting row count is verified to equal the count of matching spans. Annotated spans older than that window are gone from traces and cannot be rebuilt; the table accrues them from the migration forward.",
				preservationInterval: "the raw traces retention window",
				sourceRetentionDays: 30,
				targetRetentionDays: 365,
			},
		],
	},
	{
		id: "local-0018-to-0019-ai-trace-index-usage-conventions",
		from: 18,
		to: 19,
		description:
			"Recreate ai_trace_index_mv so Tokens counts nested cache and reasoning buckets once, and add ResponseId",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			dropViews("ai_trace_index_mv"),
			addColumns("ai_trace_index", [["ResponseId", "String"]]),
		],
		plan: [
			[
				"widen-ai-trace-index",
				"Add ResponseId to ai_trace_index and rebuild ai_trace_index_mv to fill it and to count Tokens under the reporter's usage convention",
			],
		],
		verifies: "Verify the v19 physical schema and the retained raw telemetry counts",
		dispositions: [
			AI_TRACE_INDEX_SOURCE,
			{
				name: "ai_trace_index",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched with their v18 Tokens and an empty ResponseId; the rebuilt view fills both for spans materialized after the migration and the gap closes as the retention window rolls.",
				...AI_TRACE_INDEX_FORWARD,
			},
		],
	},
	{
		id: "local-0019-to-0020-error-events-attribute-fallback",
		from: 19,
		to: 20,
		description:
			"Rebuild the error-events views so an exception-less span is labelled from its exception.* / error.* attributes",
		clonedBefore: "the views are replaced",
		beforeBootstrap: [dropTables("error_events_mv", "error_events_by_time_mv")],
		plan: [
			[
				"rebuild-error-events-views",
				"Drop and recreate the error-events views so an exception-less span is labelled from its exception.* / error.* attributes",
			],
		],
		verifies: "Verify the v20 physical schema and retained raw telemetry counts",
		dispositions: [
			TRACES_UNDER_REPLACED_VIEWS,
			{
				name: "error_events",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Existing rows are preserved untouched; the attribute fallback applies to events materialized after the migration and converges as the retention window rolls.",
				...ERROR_RETENTION,
			},
			{ ...ERROR_EVENTS_BY_TIME_FORWARD_ONLY, disposition: "preserve-exact" },
		],
	},
	{
		id: "local-0020-to-0021-ai-trace-index-list-columns",
		from: 20,
		to: 21,
		description:
			"Add the vendor version and the five token buckets to ai_trace_index and recreate ai_trace_index_mv to fill them",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			addColumns("ai_trace_index", [
				["VendorVersion", "LowCardinality(String)"],
				["InputTokens", "Float64"],
				["CacheReadTokens", "Float64"],
				["CacheWriteTokens", "Float64"],
				["OutputTokens", "Float64"],
				["ReasoningTokens", "Float64"],
			]),
			dropViews("ai_trace_index_mv"),
		],
		plan: [
			[
				"widen-ai-trace-index",
				"Add the vendor version and the five token buckets to ai_trace_index and rebuild ai_trace_index_mv to fill them",
			],
		],
		verifies: "Verify the v21 physical schema and the retained raw telemetry counts",
		dispositions: [
			AI_TRACE_INDEX_SOURCE,
			{
				name: "ai_trace_index",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched with an empty VendorVersion and zeroed token buckets; the rebuilt view fills them for spans materialized after the migration and the gap closes as the retention window rolls.",
				...AI_TRACE_INDEX_FORWARD,
			},
		],
	},
	{
		id: "local-0021-to-0022-ai-trace-index-tool-detail-columns",
		from: 21,
		to: 22,
		description:
			"Add the failure type, the status message, the tool description, a failed tool call's result and the error fingerprint to ai_trace_index and recreate ai_trace_index_mv to fill them",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			addColumns("ai_trace_index", [
				["ErrorType", "LowCardinality(String)"],
				["StatusMessage", "String"],
				["ToolDescription", "String"],
				["FailedToolCallResult", "String"],
				["ErrorFingerprint", "UInt64"],
			]),
			dropViews("ai_trace_index_mv"),
		],
		plan: [
			[
				"widen-ai-trace-index",
				"Add the failure type, the status message, the tool description, a failed tool call's result and the error fingerprint to ai_trace_index and rebuild ai_trace_index_mv to fill them",
			],
		],
		verifies: "Verify the v22 physical schema and the retained raw telemetry counts",
		dispositions: [
			AI_TRACE_INDEX_SOURCE,
			{
				name: "ai_trace_index",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched with an empty failure type, status message, tool description and failed tool call result and a zero error fingerprint; the rebuilt view fills them for spans materialized after the migration and the gap closes as the retention window rolls.",
				...AI_TRACE_INDEX_FORWARD,
			},
		],
	},
	// local-schema:bump appends the next step above this line.
]
