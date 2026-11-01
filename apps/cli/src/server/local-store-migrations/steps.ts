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
	serviceMapSpansTraceKeyRekey,
	tracesTraceKeyRekey,
} from "./backfills"
import {
	addColumns,
	addIndex,
	backfill,
	dropColumns,
	dropTables,
	dropViews,
	modifyTtl,
	unchangedRowCount,
	type StepSpec,
} from "./step-executor"
import type { StateDispositionEntry } from "../local-store-migration-module"

/** Rebuilds the facet rollup from every retained root span; the truncate makes a resumed step converge. */
const TRACE_FACETS_HOURLY_BACKFILL = [
	"TRUNCATE TABLE IF EXISTS trace_facets_hourly",
	"INSERT INTO trace_facets_hourly (OrgId, Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode, DeploymentEnv, ServiceNamespace, HasError, TraceCount, DurationMin, DurationMax, DurationQuantiles) SELECT OrgId, toStartOfHour(Timestamp) AS Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode, DeploymentEnv, ServiceNamespace, HasError, count() AS TraceCount, min(Duration) AS DurationMin, max(Duration) AS DurationMax, quantilesTDigestState(0.5, 0.95)(Duration) AS DurationQuantiles FROM trace_list_mv GROUP BY OrgId, Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode, DeploymentEnv, ServiceNamespace, HasError",
] as const

/** Indexes every retained span; the truncate makes a resumed step converge. */
const TRACE_INDEX_BACKFILL = [
	"TRUNCATE TABLE IF EXISTS trace_index",
	"INSERT INTO trace_index (OrgId, TraceId, ServiceName, Bucket, MinTimestamp, MaxTimestamp) SELECT OrgId, TraceId, ServiceName, toStartOfFiveMinutes(Timestamp) AS Bucket, min(Timestamp) AS MinTimestamp, max(Timestamp) AS MaxTimestamp FROM traces GROUP BY OrgId, TraceId, ServiceName, Bucket",
] as const

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

/** v36 TTLs that keyed off a raw timestamp instead of its day. */
const ALIGNED_TTLS = [
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

/** v39: rolls up every retained HTTP server span; the truncate makes a resumed step converge. */
const SERVICE_ENDPOINT_DETAILS_BACKFILL = [
	"TRUNCATE TABLE IF EXISTS service_endpoint_details_hourly",
	"INSERT INTO service_endpoint_details_hourly (OrgId, ServiceName, Hour, DeploymentEnv, SpanName, HttpStatusCode, ErrorType, SpanCount, EstimatedSpanCount, DurationQuantiles, BodySizeQuantiles, BodySizeMax, BodyCount, UserAgents, SlowestDuration, SlowestTraceId, SlowestTimestamp, SlowestBodySize) SELECT OrgId, ServiceName, toStartOfHour(toDateTime(Timestamp)) AS Hour, coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv, if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS SpanName, if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) AS HttpStatusCode, SpanAttributes['error.type'] AS ErrorType, count() AS SpanCount, sum(SampleRate) AS EstimatedSpanCount, quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles, quantilesTDigestIfState(0.5, 0.95, 0.99)(ifNull(toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])), 0), toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])) IS NOT NULL) AS BodySizeQuantiles, maxIf(ifNull(toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])), 0), toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])) IS NOT NULL) AS BodySizeMax, countIf(toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length'])) IS NOT NULL) AS BodyCount, approx_top_kState(10)(coalesce(nullIf(SpanAttributes['user_agent.original'], ''), nullIf(SpanAttributes['http.user_agent'], ''), '')) AS UserAgents, max(Duration) AS SlowestDuration, argMaxState(TraceId, Duration) AS SlowestTraceId, argMaxState(Timestamp, Duration) AS SlowestTimestamp, argMaxState(ifNull(toInt64(toUInt64OrNull(if(SpanAttributes['http.request.body.size'] != '', SpanAttributes['http.request.body.size'], SpanAttributes['http.request_content_length']))), -1), Duration) AS SlowestBodySize FROM traces WHERE SpanKind = 'Server' AND if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) != '' GROUP BY OrgId, ServiceName, Hour, DeploymentEnv, SpanName, HttpStatusCode, ErrorType",
] as const

/** The six HTTP measures v39 adds to both service-operations rollups. */
const SERVICE_OPERATIONS_HTTP_COLUMNS = [
	["HttpClassifiedSpanCount", "SimpleAggregateFunction(sum, UInt64)"],
	["HttpStatusCount", "SimpleAggregateFunction(sum, UInt64)"],
	["Http4xxCount", "SimpleAggregateFunction(sum, UInt64)"],
	["Http5xxCount", "SimpleAggregateFunction(sum, UInt64)"],
	["RequestBodyBytes", "SimpleAggregateFunction(sum, UInt64)"],
	["RequestBodyCount", "SimpleAggregateFunction(sum, UInt64)"],
] as const

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
	{
		// Both objects are new, so the bootstrap's IF NOT EXISTS CREATEs are the whole edge.
		id: "local-0022-to-0023-ai-crawler-requests",
		from: 22,
		to: 23,
		description:
			"Create ai_crawler_requests and its materialized view so the Web Analytics AI tab reads AI crawler fetches without scanning raw traces",
		clonedBefore: "any DDL runs",
		plan: [
			[
				"create-ai-crawler-requests",
				"Create ai_crawler_requests and ai_crawler_requests_mv via the v23 bootstrap (both new, IF NOT EXISTS)",
			],
		],
		verifies: "Verify the v23 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "ai_crawler_requests",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"The projection accrues for spans ingested after the migration; older crawler spans stay in raw traces but are invisible to the AI tab until they age out.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
		],
	},
	{
		// Both objects are new; the backfill rolls up the root spans already retained.
		id: "local-0023-to-0024-trace-facets-hourly",
		from: 23,
		to: 24,
		description:
			"Create trace_facets_hourly and its materialized view, backfilled from trace_list_mv, so the traces sidebar facets read an hourly rollup",
		clonedBefore: "any DDL runs",
		afterBootstrap: [backfill(...TRACE_FACETS_HOURLY_BACKFILL)],
		plan: [
			[
				"create-trace-facets-hourly",
				"Create trace_facets_hourly and trace_facets_hourly_mv via the v24 bootstrap and backfill the rollup from trace_list_mv",
			],
		],
		verifies: "Verify the v24 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "trace_facets_hourly",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee: "Rebuilt from every root span trace_list_mv retains; both keep 30 days.",
				preservationInterval: "source retention horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
		],
	},
	{
		// Partitioning cannot be altered in place, so the rollup is recreated and rebuilt.
		id: "local-0024-to-0025-trace-facets-hourly-daily-partition",
		from: 24,
		to: 25,
		description: "Recreate trace_facets_hourly partitioned by day and rebuild it from trace_list_mv",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [dropViews("trace_facets_hourly_mv"), dropTables("trace_facets_hourly")],
		afterBootstrap: [backfill(...TRACE_FACETS_HOURLY_BACKFILL)],
		plan: [
			[
				"recreate-trace-facets-hourly",
				"Drop trace_facets_hourly and its view, recreate both partitioned by day, and backfill from trace_list_mv",
			],
		],
		verifies: "Verify the v25 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "trace_facets_hourly",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee: "Rebuilt from every root span trace_list_mv retains; both keep 30 days.",
				preservationInterval: "source retention horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
		],
	},
	{
		id: "local-0025-to-0026-ai-trace-index-gateway-stamps",
		from: 25,
		to: 26,
		description: "Recreate ai_trace_index_mv as a projection of the ingest gateway's maple_ai.* stamps",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [dropViews("ai_trace_index_mv")],
		plan: [
			[
				"rebuild-ai-trace-index-view",
				"Rebuild ai_trace_index_mv to project the maple_ai.* facts the ingest gateway stamps on each span",
			],
		],
		verifies: "Verify the v26 physical schema and the retained raw telemetry counts",
		dispositions: [
			AI_TRACE_INDEX_SOURCE,
			{
				name: "ai_trace_index",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched with the values the v25 view gave them; the rebuilt view fills spans materialized after the migration from the gateway's stamps, and the gap closes as the retention window rolls.",
				...AI_TRACE_INDEX_FORWARD,
			},
		],
	},
	{
		id: "local-0026-to-0027-alert-checks-skip-reason",
		from: 26,
		to: 27,
		description: "Add SkipReason to alert_checks",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [addColumns("alert_checks", [["SkipReason", "LowCardinality(String) DEFAULT ''"]])],
		plan: [["widen-alert-checks", "Add SkipReason to alert_checks so skipped checks record why"]],
		verifies: "Verify the v27 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "alert_checks",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"Existing check rows are kept as written with an empty SkipReason; only checks recorded after the migration carry one.",
			},
		],
	},
	{
		id: "local-0027-to-0028-service-overview-spans-span-kind",
		from: 27,
		to: 28,
		description:
			"Add SpanKind and IsRoot to service_overview_spans and recreate service_overview_spans_mv to fill them",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			addColumns("service_overview_spans", [
				["SpanKind", "LowCardinality(String) DEFAULT ''"],
				["IsRoot", "UInt8 DEFAULT 0"],
			]),
			dropViews("service_overview_spans_mv"),
		],
		plan: [
			[
				"widen-service-overview-spans",
				"Add SpanKind and IsRoot to service_overview_spans and rebuild service_overview_spans_mv to fill them",
			],
		],
		verifies: "Verify the v28 physical schema and the retained raw telemetry counts",
		dispositions: [
			TRACES_UNDER_REPLACED_VIEWS,
			{
				name: "service_overview_spans",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched with an empty SpanKind and a zero IsRoot; the rebuilt view fills both for spans materialized after the migration and the gap closes as the 30-day retention window rolls.",
				preservationInterval: "source retention horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
		],
	},
	{
		id: "local-0028-to-0029-external-edges-legacy-db-system",
		from: 28,
		to: 29,
		description:
			"Recreate service_external_edges_hourly_mv so spans with only the legacy db.system are excluded like db.system.name spans",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [dropViews("service_external_edges_hourly_mv")],
		plan: [
			[
				"rebuild-external-edges-view",
				"Rebuild service_external_edges_hourly_mv to exclude spans that set only the legacy db.system",
			],
		],
		verifies: "Verify the v29 physical schema and the retained raw telemetry counts",
		dispositions: [
			TRACES_UNDER_REPLACED_VIEWS,
			{
				name: "service_external_edges_hourly",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Existing rows are preserved untouched, including legacy db.system spans counted as external targets; the rebuilt view excludes them from hours materialized after the migration, and the old rows age out with the table's TTL.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 365,
			},
		],
	},
	{
		// TODO(v29 -> v30): what changes, and what is NOT backfilled. Fill beforeBootstrap
		// with the ADD COLUMN / view drops an IF NOT EXISTS bootstrap cannot do, then the
		// plan line and dispositions. The v30 physical verify fails an unfinished row.
		id: "local-0029-to-0030-error-fingerprint-v3",
		from: 29,
		to: 30,
		description: "Rebuild the error-events views with fingerprint v3 grouping and a version-salted hash",
		clonedBefore: "the views are replaced",
		beforeBootstrap: [dropTables("error_events_mv", "error_events_by_time_mv")],
		plan: [
			[
				"rebuild-error-events-views",
				"Drop and recreate the error-events views so new occurrences are hashed with fingerprint v3",
			],
		],
		verifies: "Verify the v30 physical schema and retained raw telemetry counts",
		dispositions: [
			TRACES_UNDER_REPLACED_VIEWS,
			{
				name: "error_events",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Existing rows keep their v2 FingerprintHash untouched; occurrences materialized after the migration carry v3 hashes, and the v2 rows age out with the retention window.",
				...ERROR_RETENTION,
			},
			{ ...ERROR_EVENTS_BY_TIME_FORWARD_ONLY, disposition: "preserve-exact" },
		],
	},
	{
		id: "local-0030-to-0031-error-fingerprint-span-name-frames",
		from: 30,
		to: 31,
		description: "Drop location-less Effect span frames from the error fingerprint",
		clonedBefore: "the views are replaced",
		beforeBootstrap: [dropTables("error_events_mv", "error_events_by_time_mv")],
		plan: [
			[
				"rebuild-error-events-views",
				"Drop and recreate the error-events views so a location-less span frame no longer enters the hash",
			],
		],
		verifies: "Verify the v31 physical schema and retained raw telemetry counts",
		dispositions: [
			TRACES_UNDER_REPLACED_VIEWS,
			{
				name: "error_events",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Existing rows keep their FingerprintHash untouched; only occurrences whose stack carries a location-less span frame hash differently after the migration.",
				...ERROR_RETENTION,
			},
			{ ...ERROR_EVENTS_BY_TIME_FORWARD_ONLY, disposition: "preserve-exact" },
		],
	},
	{
		id: "local-0031-to-0032-alert-checks-level",
		from: 31,
		to: 32,
		description: "Add Level to alert_checks",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [addColumns("alert_checks", [["Level", "LowCardinality(String) DEFAULT ''"]])],
		plan: [
			[
				"widen-alert-checks",
				"Add Level to alert_checks so checks record the severity tier they breached",
			],
		],
		verifies: "Verify the v32 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "alert_checks",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"Existing check rows are kept as written with an empty Level; only checks recorded after the migration carry one.",
			},
		],
	},
	{
		// Both objects are new; the backfill indexes the spans already retained.
		id: "local-0032-to-0033-trace-index",
		from: 32,
		to: 33,
		description: "Create trace_index and its view: where each trace's spans live in traces",
		clonedBefore: "any DDL runs",
		afterBootstrap: [backfill(...TRACE_INDEX_BACKFILL)],
		plan: [
			[
				"create-trace-index",
				"Create trace_index and trace_index_mv via the v33 bootstrap and index every retained span from traces",
			],
		],
		verifies: "Verify the v33 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "trace_index",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee: "Rebuilt from every span traces retains; both keep 30 days.",
				preservationInterval: "source retention horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
		],
	},
	{
		// The bootstrap keeps the v33 traces (IF NOT EXISTS); the custom step swaps in a
		// v34-keyed copy. Every view and rollup is untouched: none fires on the copy.
		id: "local-0033-to-0034-traces-trace-key",
		from: 33,
		to: 34,
		description: "Re-sort traces by service, 5-minute bucket and trace id, with a span-name bloom index",
		clonedBefore: "any DDL runs",
		custom: tracesTraceKeyRekey,
		plan: [
			[
				"resort-traces",
				"Copy traces into a view-free table with the v34 sort key and span-name index, then exchange it in for traces",
			],
		],
		verifies:
			"Verify the v34 physical schema, the retained raw telemetry counts, and that no staging table is left",
		dispositions: [
			{
				name: "traces",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee:
					"Every span inside its TTL is copied as written into the re-sorted table, keeping the store's TTL; spans already past it are dropped as a merge would. No view fires on the copy, so no rollup counts a span twice.",
			},
		],
	},
	{
		// The view goes before its table, or inserts into traces fail on the missing target.
		id: "local-0034-to-0035-drop-trace-detail-spans",
		from: 34,
		to: 35,
		description: "Drop trace_detail_spans and its view; trace-id reads seek traces through trace_index",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [dropViews("trace_detail_spans_mv"), dropTables("trace_detail_spans")],
		plan: [["drop-trace-detail-spans", "Drop trace_detail_spans and trace_detail_spans_mv"]],
		verifies: "Verify the v35 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "trace_detail_spans",
				classification: "derived",
				disposition: "invalidate",
				guarantee:
					"Dropped permanently with its view. Every trace-id read seeks traces through trace_index, and the rows were a copy of traces.",
			},
		],
	},
	{
		// Rows are not rewritten: each TTL moves to its partition's toDate(...) expression.
		id: "local-0035-to-0036-aligned-ttls",
		from: 35,
		to: 36,
		description: "Align raw-timestamp TTLs to their daily partitions",
		clonedBefore: "any DDL runs",
		beforeBootstrap: ALIGNED_TTLS.map(([table, ttl]) => modifyTtl(table, ttl)),
		plan: [
			[
				"align-ttls",
				"Key the TTL of each table partitioned by day off toDate(...) so a day's rows expire together",
			],
		],
		verifies: "Verify the v36 physical schema and the retained raw telemetry counts",
		dispositions: ALIGNED_TTLS.map(([name]) => ({
			name,
			classification: "derived",
			disposition: "preserve-exact",
			guarantee:
				"Only the TTL expression changes. A row now expires at the start of its day, up to a day earlier than before.",
		})),
	},
	{
		// Purely additive and filled forward only: the sources view reads 24 hours,
		// and local OTLP ingest stamps no maple_source_id, so there is nothing to backfill.
		id: "local-0036-to-0037-source-usage-hourly",
		from: 36,
		to: 37,
		description: "source_usage_hourly + its six views: hourly volume and bytes per source",
		clonedBefore: "additive DDL runs",
		plan: [
			[
				"install-source-usage-hourly",
				"Install the source_usage_hourly rollup and its six materialized views via the v37 bootstrap",
			],
		],
		verifies: "Verify the v37 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "source_usage_hourly",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Filled forward from traces, logs and metrics writes that carry a source id; complete once the 24-hour read window passes.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 90,
			},
		],
	},
	{
		// Purely additive and filled forward only: CI traces come from the GitHub App's
		// webhooks, which never reach a local store, so there is nothing to backfill.
		id: "local-0037-to-0038-ci-runs-jobs",
		from: 37,
		to: 38,
		description: "ci_runs + ci_jobs and their views: CI runs and jobs off github-actions traces",
		clonedBefore: "additive DDL runs",
		plan: [
			[
				"install-ci-runs-jobs",
				"Install the ci_runs and ci_jobs projections and their materialized views via the v38 bootstrap",
			],
		],
		verifies: "Verify the v38 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "ci_runs",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee: "Filled forward from github-actions root spans written after the migration.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 365,
			},
			{
				name: "ci_jobs",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee: "Filled forward from github-actions job spans written after the migration.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 365,
			},
		],
	},
	{
		// Six additive counters on both service-operations rollups (zeros on old rows, which
		// HttpClassifiedSpanCount = 0 marks unknown) plus the new endpoint-details rollup,
		// backfilled from retained traces like trace_facets_hourly at v24.
		id: "local-0038-to-0039-service-api-http-details",
		from: 38,
		to: 39,
		description: "HTTP measures on service_operations_* and the service_endpoint_details_hourly rollup",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [
			addColumns("service_operations_minutely", SERVICE_OPERATIONS_HTTP_COLUMNS),
			addColumns("service_operations_hourly", SERVICE_OPERATIONS_HTTP_COLUMNS),
			dropViews("service_operations_minutely_mv", "service_operations_hourly_mv"),
		],
		afterBootstrap: [backfill(...SERVICE_ENDPOINT_DETAILS_BACKFILL)],
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
				"add-operation-http-measures",
				"Add the six HTTP status and request-body counters to both service-operations rollups and recreate their views",
			],
			[
				"create-service-endpoint-details",
				"Create service_endpoint_details_hourly and its view via the v39 bootstrap and backfill it from retained traces",
			],
		],
		verifies: "Verify the v39 physical schema, retained raw telemetry counts, and the rollup row counts",
		dispositions: [
			{
				name: "service_operations_minutely",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Six counter columns are added as metadata-only defaults; no part is rewritten, the row count is verified unchanged, and existing rows read back as zero, which HttpClassifiedSpanCount marks as unknown.",
			},
			{
				name: "service_operations_hourly",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Six counter columns are added as metadata-only defaults; no part is rewritten and the row count is verified unchanged.",
			},
			{
				name: "service_endpoint_details_hourly",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Rebuilt from every HTTP server span traces retains, then filled forward by its view.",
				preservationInterval: "source retention horizon",
				sourceRetentionDays: 30,
				targetRetentionDays: 90,
			},
		],
	},
	{
		// Like v34: the bootstrap keeps the v39 tables (IF NOT EXISTS); the custom step swaps in
		// re-keyed copies. Their view writes TO them by name, so it follows the swap.
		id: "local-0039-to-0040-service-map-spans-trace-key",
		from: 39,
		to: 40,
		description: "Re-sort service_map_spans and service_map_children by 5-minute bucket and trace id",
		clonedBefore: "any DDL runs",
		custom: serviceMapSpansTraceKeyRekey,
		plan: [
			[
				"resort-service-map-spans",
				"Copy service_map_spans and service_map_children into view-free tables keyed by 5-minute bucket and trace id, then exchange them in",
			],
		],
		verifies:
			"Verify the v40 physical schema, the retained raw telemetry counts, and that no staging table is left",
		dispositions: [
			{
				name: "service_map_spans",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Every row inside its TTL is copied as written into the re-sorted table, keeping the store's TTL. No view fires on the copy.",
			},
			{
				name: "service_map_children",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Every row inside its TTL is copied as written into the re-sorted table, keeping the store's TTL. No view fires on the copy.",
			},
		],
	},
	{
		// Purely additive and filled forward only: the read path keeps raw traces for any
		// minute before the view's first write, so nothing needs backfilling.
		id: "local-0040-to-0041-service-map-db-edges-minutely",
		from: 40,
		to: 41,
		description: "service_map_db_edges_minutely + its view: per-minute service-to-database edges",
		clonedBefore: "additive DDL runs",
		plan: [
			[
				"install-service-map-db-edges-minutely",
				"Install the service_map_db_edges_minutely rollup and its materialized view via the v41 bootstrap",
			],
		],
		verifies: "Verify the v41 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "service_map_db_edges_minutely",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"Filled forward from traces writes; the service map reads raw traces for minutes before the view's first write.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
		],
	},
	{
		// Both objects are new and fill forward; nothing is backfilled.
		id: "local-0041-to-0042-security-telemetry",
		from: 41,
		to: 42,
		description:
			"Create scanner_requests and service_runtimes_hourly with their views for the Security Center's Exposure and Runtimes tabs",
		clonedBefore: "any DDL runs",
		beforeBootstrap: [],
		plan: [
			[
				"create-security-telemetry",
				"Create scanner_requests, service_runtimes_hourly and their views via the v42 bootstrap (all new, IF NOT EXISTS)",
			],
		],
		verifies: "Verify the v42 physical schema and the retained raw telemetry counts",
		dispositions: [
			{
				name: "scanner_requests",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"The projection accrues for spans ingested after the migration; older probe spans stay in raw traces but are invisible to the Exposure tab until they age out.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 30,
			},
			{
				name: "service_runtimes_hourly",
				classification: "derived",
				disposition: "rebuild-within-retention-horizon",
				guarantee:
					"The rollup accrues for spans ingested after the migration; services that sent no spans since then are missing from the Runtimes tab.",
				preservationInterval: "from the migration forward",
				sourceRetentionDays: 30,
				targetRetentionDays: 90,
			},
		],
	},
	{
		id: "local-0042-to-0043-error-fingerprint-fuzz-fixes",
		from: 42,
		to: 43,
		description: "Recreate the error_events MVs with the fingerprint fuzz fixes",
		clonedBefore: "the views are replaced",
		beforeBootstrap: [dropTables("error_events_mv", "error_events_by_time_mv")],
		plan: [
			[
				"rebuild-error-events-views",
				"Drop and recreate the error-events views so scanner paths, opaque tokens, install roots and JSON log lines no longer split one bug",
			],
		],
		verifies: "Verify the v43 physical schema and retained raw telemetry counts",
		dispositions: [
			TRACES_UNDER_REPLACED_VIEWS,
			{
				name: "error_events",
				classification: "derived",
				disposition: "preserve-exact",
				guarantee:
					"Existing rows keep their FingerprintHash untouched; only occurrences whose message or stack carries one of the redacted shapes hash differently after the migration.",
				...ERROR_RETENTION,
			},
			{ ...ERROR_EVENTS_BY_TIME_FORWARD_ONLY, disposition: "preserve-exact" },
		],
	},
	// local-schema:bump appends the next step above this line.
]
