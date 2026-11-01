import { defineMaterializedView, node } from "@maple-dev/effect-orm/tinybird"
import {
	chPattern,
	chRedactChain,
	EFFECT_SPAN_FRAME_MARKER,
	ERROR_MSG_REDACTIONS,
	FINGERPRINT_HASH_SALT,
	FRAME_LINE_PATTERN,
	FRAME_REDACTIONS,
	JSON_VALUE_REDACTIONS,
	MAX_FINGERPRINT_FRAMES,
	MSG_SCAN_CHARS,
	MSG_SIGNATURE_CHARS,
	NAMESPACED_TYPE_MAX_FRAMES,
	SCHEMA_PATH_LINE_PATTERN,
	SPAN_NAME_FRAME_PATTERN,
} from "./fingerprint"
import {
	serviceUsage,
	sourceUsageHourly,
	serviceMapEdgesHourly,
	serviceMapSpans,
	serviceMapChildren,
	serviceMapDbEdgesHourly,
	serviceMapDbEdgesMinutely,
	serviceMapDbQuerySignaturesHourly,
	serviceExternalEdgesHourly,
	servicePlatformsHourly,
	serviceOverviewSpans,
	serviceOverviewHourly,
	serviceOverviewMinutely,
	errorEvents,
	errorEventsByTime,
	errorFingerprintsMinutely,
	aiTraceIndex,
	aiCrawlerRequests,
	scannerRequests,
	serviceRuntimesHourly,
	CI_SERVICE_NAME,
	ciJobs,
	ciRuns,
	TRACE_BUCKET_EXPR,
	traceIndex,
	traceListMv,
	traceFacetsHourly,
	attributeKeysHourly,
	attributeValuesHourly,
	tracesAggregatesHourly,
	logsAggregatesHourly,
	metricCatalog,
	spanMetricsCallsHourly,
	serviceOperationsMinutely,
	serviceOperationsHourly,
	serviceEndpointDetailsHourly,
	productEvents,
	identityLinks,
} from "./datasources"
import {
	DB_NAMESPACE_ATTR_SQL,
	DB_QUERY_KEY_SQL,
	DB_QUERY_LABEL_SQL,
	DB_STATEMENT_SQL,
	DB_SYSTEM_ATTR_SQL,
} from "./db-query-shape-sql"
import { MAPLE_AI_SESSION_ID_ATTR, MAPLE_AI_VENDOR_ID_ATTR, MAPLE_AI_VENDOR_VERSION_ATTR } from "../gen-ai"
import { PRODUCT_EVENTS_TRACE_FILTER, PRODUCT_EVENTS_TRACE_PROJECTION_SQL } from "./product-event-attributes"
import { DEPLOYMENT_ENV_SQL, MESSAGING_DESTINATION_SQL } from "./semconv-renames"
import {
	HTTP_SERVER_SPAN_SQL,
	HTTP_STATUS_CODE_SQL,
	REQUEST_BODY_SIZE_SQL,
	SERVICE_OPERATIONS_HTTP_MEASURES as HTTP,
	USER_AGENT_SQL,
} from "./http-endpoint-sql"
import {
	AI_CRAWLER_INDEX_SQL,
	AI_CRAWLER_NAME_SQL,
	REQUEST_HOST_SQL,
	REQUEST_PATH_SQL,
	RESPONSE_STATUS_SQL,
} from "./ai-crawler-columns"
import {
	CLIENT_ADDRESS_SQL,
	CRITICAL_PROBE_INDEX_SQL,
	EXECUTABLE_NAME_SQL,
	OTHER_PROBE_INDEX_SQL,
	PROBE_SIGNATURE_SQL,
	RUNTIME_NAME_SQL,
	RUNTIME_VERSION_SQL,
	SCANNER_HOST_SQL,
	SCANNER_INDEX_SQL,
	SCANNER_NAME_SQL,
	SCANNER_USER_AGENT_SQL,
	SDK_LANGUAGE_SQL,
	SDK_NAME_SQL,
	SDK_VERSION_SQL,
} from "./security-telemetry-columns"
import {
	GENAI_AGENT_NAME_SQL,
	GENAI_CACHE_READ_TOKENS_SQL,
	GENAI_CACHE_WRITE_TOKENS_SQL,
	GENAI_COST_SQL,
	GENAI_ERROR_FINGERPRINT_SQL,
	GENAI_ERROR_TYPE_SQL,
	GENAI_FAILED_TOOL_CALL_RESULT_SQL,
	GENAI_INPUT_TOKENS_SQL,
	GENAI_IS_ERROR_SQL,
	GENAI_IS_LLM_CALL_SQL,
	GENAI_IS_TOOL_CALL_SQL,
	GENAI_MODEL_SQL,
	GENAI_OUTPUT_TOKENS_SQL,
	GENAI_REASONING_TOKENS_SQL,
	GENAI_RESPONSE_ID_SQL,
	GENAI_STATUS_MESSAGE_SQL,
	GENAI_TOKENS_SQL,
	GENAI_TOOL_DESCRIPTION_SQL,
	GENAI_TOOL_NAME_SQL,
} from "./gen-ai-columns"
import { NORMALIZED_SPAN_NAME_SQL } from "./span-display-name"

/**
 * Materialized view to aggregate log usage statistics per service per hour
 */
export const serviceUsageLogsMv = defineMaterializedView("service_usage_logs_mv", {
	description: "Materialized view to aggregate log usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_logs_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(TimestampTime) AS Hour,
          count() AS LogCount,
          sum(length(Body) + 200) AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM logs
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate trace/span usage statistics per service per hour
 */
export const serviceUsageTracesMv = defineMaterializedView("service_usage_traces_mv", {
	description: "Materialized view to aggregate trace/span usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_traces_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          count() AS TraceCount,
          sum(length(SpanName) + 300) AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM traces
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate sum metric usage statistics per service per hour
 */
export const serviceUsageMetricsSumMv = defineMaterializedView("service_usage_metrics_sum_mv", {
	description: "Materialized view to aggregate sum metric usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_metrics_sum_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          count() AS SumMetricCount,
          count() * 150 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM metrics_sum
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate gauge metric usage statistics per service per hour
 */
export const serviceUsageMetricsGaugeMv = defineMaterializedView("service_usage_metrics_gauge_mv", {
	description: "Materialized view to aggregate gauge metric usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_metrics_gauge_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          count() AS GaugeMetricCount,
          count() * 150 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM metrics_gauge
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate histogram metric usage statistics per service per hour
 */
export const serviceUsageMetricsHistogramMv = defineMaterializedView("service_usage_metrics_histogram_mv", {
	description: "Materialized view to aggregate histogram metric usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_metrics_histogram_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          count() AS HistogramMetricCount,
          count() * 250 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM metrics_histogram
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate exponential histogram metric usage statistics per service per hour
 */
export const serviceUsageMetricsExpHistogramMv = defineMaterializedView(
	"service_usage_metrics_exp_histogram_mv",
	{
		description:
			"Materialized view to aggregate exponential histogram metric usage statistics per service per hour",
		datasource: serviceUsage,
		nodes: [
			node({
				name: "service_usage_metrics_exp_histogram_mv_node",
				sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          count() AS ExpHistogramMetricCount,
          count() * 300 AS ExpHistogramMetricSizeBytes
        FROM metrics_exponential_histogram
        GROUP BY OrgId, ServiceName, Hour
      `,
			}),
		],
	},
)

/**
 * One `source_usage_hourly` row per (org, source, hour) from a signal table.
 * Consumed by `sourceUsageHourlyQuery` and `sourceUsageTotalsQuery`; byte
 * estimates match the `service_usage_*_mv` views.
 */
const sourceUsageSql = (opts: {
	readonly table: string
	readonly hour: string
	readonly spans?: readonly [string, string]
	readonly logs?: readonly [string, string]
	readonly metrics?: readonly [string, string]
}) => `
        SELECT
          OrgId,
          ResourceAttributes['maple_source_id'] AS SourceId,
          toStartOfHour(${opts.hour}) AS Hour,
          ${opts.spans?.[0] ?? "0"} AS SpanCount,
          ${opts.spans?.[1] ?? "0"} AS SpanSizeBytes,
          ${opts.logs?.[0] ?? "0"} AS LogCount,
          ${opts.logs?.[1] ?? "0"} AS LogSizeBytes,
          ${opts.metrics?.[0] ?? "0"} AS MetricCount,
          ${opts.metrics?.[1] ?? "0"} AS MetricSizeBytes
        FROM ${opts.table}
        WHERE ResourceAttributes['maple_source_id'] != ''
        GROUP BY OrgId, SourceId, Hour
      `

const sourceUsageMv = (name: string, signal: string, sql: string) =>
	defineMaterializedView(name, {
		description: `Materialized view to aggregate ${signal} usage per source per hour`,
		datasource: sourceUsageHourly,
		nodes: [node({ name: `${name}_node`, sql })],
	})

export const sourceUsageLogsMv = sourceUsageMv(
	"source_usage_logs_mv",
	"log",
	sourceUsageSql({ table: "logs", hour: "TimestampTime", logs: ["count()", "sum(length(Body) + 200)"] }),
)

export const sourceUsageTracesMv = sourceUsageMv(
	"source_usage_traces_mv",
	"span",
	sourceUsageSql({
		table: "traces",
		hour: "toDateTime(Timestamp)",
		spans: ["count()", "sum(length(SpanName) + 300)"],
	}),
)

export const sourceUsageMetricsSumMv = sourceUsageMv(
	"source_usage_metrics_sum_mv",
	"sum metric",
	sourceUsageSql({
		table: "metrics_sum",
		hour: "toDateTime(TimeUnix)",
		metrics: ["count()", "count() * 150"],
	}),
)

export const sourceUsageMetricsGaugeMv = sourceUsageMv(
	"source_usage_metrics_gauge_mv",
	"gauge metric",
	sourceUsageSql({
		table: "metrics_gauge",
		hour: "toDateTime(TimeUnix)",
		metrics: ["count()", "count() * 150"],
	}),
)

export const sourceUsageMetricsHistogramMv = sourceUsageMv(
	"source_usage_metrics_histogram_mv",
	"histogram metric",
	sourceUsageSql({
		table: "metrics_histogram",
		hour: "toDateTime(TimeUnix)",
		metrics: ["count()", "count() * 250"],
	}),
)

export const sourceUsageMetricsExpHistogramMv = sourceUsageMv(
	"source_usage_metrics_exp_histogram_mv",
	"exponential histogram metric",
	sourceUsageSql({
		table: "metrics_exponential_histogram",
		hour: "toDateTime(TimeUnix)",
		metrics: ["count()", "count() * 300"],
	}),
)

/**
 * Materialized view projecting trace spans needed for service dependency map.
 * Extracts deployment.environment from Map columns at write time so the service
 * map JOIN query avoids scanning heavy Map columns.
 */
export const serviceMapSpansMv = defineMaterializedView("service_map_spans_mv", {
	description:
		"Materialized view projecting trace spans needed for service dependency map. Extracts deployment.environment from Map columns at write time.",
	datasource: serviceMapSpans,
	nodes: [
		node({
			name: "service_map_spans_mv_node",
			sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          ServiceName,
          SpanKind,
          Duration,
          StatusCode,
          TraceState,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer', 'Server', 'Consumer')
      `,
		}),
	],
})

/**
 * Materialized view projecting service entry point spans for service overview queries.
 * Includes Server/Consumer spans (service entry points per OTel semantics) plus root spans
 * as a fallback for services with Internal/unset SpanKind (cron jobs, workers).
 * Pre-extracts the deployment environment (either semconv spelling) and `vcs.ref.head.revision`
 * from ResourceAttributes so the service overview query avoids scanning heavy Map columns.
 */
export const serviceOverviewSpansMv = defineMaterializedView("service_overview_spans_mv", {
	description:
		"Materialized view projecting service entry point spans (Server/Consumer + root) for service overview queries. Pre-extracts deployment attributes from ResourceAttributes at write time.",
	datasource: serviceOverviewSpans,
	// Migration 0037's SpanKind/IsRoot are additive and older rows may read ''/0.
	// Without this, Tinybird rebuilds the target by replaying 30 days of `traces`.
	deploymentMethod: "alter",
	nodes: [
		node({
			name: "service_overview_spans_mv_node",
			sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          ServiceName,
          Duration,
          StatusCode,
          TraceState,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          ResourceAttributes['vcs.ref.head.revision'] AS CommitSha,
          SampleRate,
          ResourceAttributes['service.namespace'] AS ServiceNamespace,
          SpanKind,
          toUInt8(ParentSpanId = '') AS IsRoot
        FROM traces
        WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''
      `,
		}),
	],
})

/**
 * Durable service-level rollup for one-year overview and catalog queries.
 * Entry-point semantics intentionally match service_overview_spans_mv.
 */
export const serviceOverviewHourlyMv = defineMaterializedView("service_overview_hourly_mv", {
	description:
		"Pre-aggregates service entry-point spans hourly by environment, namespace, and commit for one-year service history.",
	datasource: serviceOverviewHourly,
	nodes: [
		node({
			name: "service_overview_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          ResourceAttributes['service.namespace'] AS ServiceNamespace,
          ResourceAttributes['vcs.ref.head.revision'] AS CommitSha,
          count() AS SpanCount,
          sum(SampleRate) AS EstimatedSpanCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
          sum(toFloat64(Duration)) AS DurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,
          min(toDateTime(Timestamp)) AS FirstSeen,
          countIf(StatusCode != 'Error' AND Duration < 500000000) AS ApdexSatisfiedCount,
          countIf(StatusCode != 'Error' AND Duration >= 500000000 AND Duration < 2000000000) AS ApdexToleratingCount
        FROM traces
        WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''
        GROUP BY OrgId, Hour, ServiceName, DeploymentEnv, ServiceNamespace, CommitSha
      `,
		}),
	],
})

/**
 * Minute-grain twin of `service_overview_hourly_mv`.
 *
 * Reads `traces` directly rather than cascading `service_overview_hourly_mv` off
 * this table (the shape `service_operations` uses). A cascade would make the
 * minutely backfill — an `INSERT INTO … SELECT`, which fires every MV attached to
 * its target — pour 30 days of duplicate rows into `service_overview_hourly`, the
 * one table that is retained for a year and cannot be rebuilt past its 30-day
 * source. There is no statement ordering that makes that safe, because
 * `service_overview_hourly` can never be truncated.
 *
 * Entry-point semantics intentionally match `service_overview_spans_mv` and
 * `service_overview_hourly_mv`.
 */
export const serviceOverviewMinutelyMv = defineMaterializedView("service_overview_minutely_mv", {
	description:
		"Pre-aggregates service entry-point spans minutely by environment, namespace, and commit, for windows whose bucket size is under an hour.",
	datasource: serviceOverviewMinutely,
	nodes: [
		node({
			name: "service_overview_minutely_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfMinute(toDateTime(Timestamp)) AS Minute,
          ServiceName,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          ResourceAttributes['service.namespace'] AS ServiceNamespace,
          ResourceAttributes['vcs.ref.head.revision'] AS CommitSha,
          count() AS SpanCount,
          sum(SampleRate) AS EstimatedSpanCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
          sum(toFloat64(Duration)) AS DurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,
          min(toDateTime(Timestamp)) AS FirstSeen,
          countIf(StatusCode != 'Error' AND Duration < 500000000) AS ApdexSatisfiedCount,
          countIf(StatusCode != 'Error' AND Duration >= 500000000 AND Duration < 2000000000) AS ApdexToleratingCount
        FROM traces
        WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''
        GROUP BY OrgId, Minute, ServiceName, DeploymentEnv, ServiceNamespace, CommitSha
      `,
		}),
	],
})

/**
 * Materialized view populating trace_list_mv from root spans.
 * Pre-extracts HTTP attributes from SpanAttributes and normalizes span names
 * so the trace list query avoids scanning heavy Map columns and GROUP BY.
 */
/**
 * Materialized view populating service_map_children from Server/Consumer spans.
 * Pre-filters to only spans with a parent and extracts deployment.environment
 * so the service map JOIN query scans far fewer rows on the child side.
 */
export const serviceMapChildrenMv = defineMaterializedView("service_map_children_mv", {
	description:
		"Populates service_map_children with Server/Consumer spans that have a parent for efficient JOIN lookups.",
	datasource: serviceMapChildren,
	nodes: [
		node({
			name: "service_map_children_mv_node",
			sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          ParentSpanId,
          ServiceName,
          SpanKind,
          Duration,
          StatusCode,
          TraceState,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv
        FROM traces
        WHERE SpanKind IN ('Server', 'Consumer')
          AND ParentSpanId != ''
      `,
		}),
	],
})

// The cross-span service-map JOIN remains in `ServiceMapRollupService`: an
// incremental MV cannot recover the downstream service name by joining a
// Client/Producer span to its child Server/Consumer span. The MV below does no
// aggregation or joining; it is only an ingestion bridge. Tinybird's Events
// API writes plain columns with JSONPaths into a Null-engine source, which
// immediately forwards them to the JSONPath-free aggregate target.
//
// Why not a *refreshable* MV (`REFRESH EVERY 1 HOUR`), which can run a join?
//  - This schema deploys to both Tinybird and ClickHouse; Tinybird has no
//    refreshable-MV equivalent, so the rollup (routed via WarehouseQueryService)
//    is the only mechanism that works for both backends.
//  - Refreshable MVs are still experimental on the deployed ClickHouse (24.8).
//  - The job adds bounded-lookback catch-up + skip-existing idempotency that a
//    `REFRESH ... APPEND` MV does not provide.

export const serviceMapEdgesHourlyIngestMv = defineMaterializedView("service_map_edges_hourly_ingest_mv", {
	description:
		"Forwards scheduled service-map rollup rows from the Events API-compatible Null source into the aggregate target.",
	datasource: serviceMapEdgesHourly,
	nodes: [
		node({
			name: "service_map_edges_hourly_ingest_mv_node",
			sql: `
        SELECT
          OrgId,
          Hour,
          SourceService,
          TargetService,
          DeploymentEnv,
          CallCount,
          ErrorCount,
          DurationSumMs,
          MaxDurationMs,
          SampledSpanCount,
          UnsampledSpanCount,
          SampleRateSum
        FROM service_map_edges_hourly_ingest
      `,
		}),
	],
})

/**
 * Materialized view pre-aggregating service-to-database edges per hour.
 * Aggregates Client/Producer spans with a database system set into hourly
 * buckets at write time so the database-node query reads pre-aggregated rows
 * instead of scanning raw span attributes.
 *
 * `DbSystem` uses the `db.system.name` → `db.system` coalesce (`DB_SYSTEM_ATTR_SQL`),
 * matching `service_map_db_query_shapes_hourly_mv`, so spans that emit only the
 * legacy `db.system` attribute are captured here too. `DbNamespace`
 * (`DB_NAMESPACE_ATTR_SQL`: `db.namespace` → `db.name` → `server.address` →
 * `net.peer.name`) splits distinct databases of the same system into distinct
 * service-map nodes; '' when the instrumentation identifies none.
 */
export const serviceMapDbEdgesHourlyMv = defineMaterializedView("service_map_db_edges_hourly_mv", {
	description:
		"Pre-aggregates Client/Producer spans with db.system.name into hourly service-to-database edge buckets for fast service map db-node queries.",
	datasource: serviceMapDbEdgesHourly,
	nodes: [
		node({
			name: "service_map_db_edges_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          ${DB_SYSTEM_ATTR_SQL} AS DbSystem,
          ${DB_NAMESPACE_ATTR_SQL} AS DbNamespace,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          count() AS CallCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sum(Duration / 1000000) AS DurationSumMs,
          max(Duration / 1000000) AS MaxDurationMs,
          countIf(TraceState LIKE '%th:%') AS SampledSpanCount,
          countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS UnsampledSpanCount,
          sum(SampleRate) AS SampleRateSum,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer')
          AND ${DB_SYSTEM_ATTR_SQL} != ''
          AND ServiceName != ''
        GROUP BY OrgId, Hour, ServiceName, DbSystem, DbNamespace, DeploymentEnv
      `,
		}),
	],
})

/**
 * Minute twin of `service_map_db_edges_hourly_mv`, read by `serviceDbEdges` for
 * the partial hours at the ends of a window (see `serviceMapDbEdgesMinutely`).
 * Same filter, keys and derivation as the hourly view, so the two tiers merge; keep
 * them in step. It omits the hourly view's sampled/unsampled counts, which no read uses.
 */
export const serviceMapDbEdgesMinutelyMv = defineMaterializedView("service_map_db_edges_minutely_mv", {
	description:
		"Pre-aggregates Client/Producer spans with db.system.name into per-minute service-to-database edge buckets for the edges of a service map window.",
	datasource: serviceMapDbEdgesMinutely,
	nodes: [
		node({
			name: "service_map_db_edges_minutely_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfMinute(toDateTime(Timestamp)) AS Minute,
          ServiceName,
          ${DB_SYSTEM_ATTR_SQL} AS DbSystem,
          ${DB_NAMESPACE_ATTR_SQL} AS DbNamespace,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          count() AS CallCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sum(Duration / 1000000) AS DurationSumMs,
          max(Duration / 1000000) AS MaxDurationMs,
          sum(SampleRate) AS SampleRateSum,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles,
          now() AS FirstInsertedAt
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer')
          AND ${DB_SYSTEM_ATTR_SQL} != ''
          AND ServiceName != ''
        GROUP BY OrgId, Minute, ServiceName, DbSystem, DbNamespace, DeploymentEnv
      `,
		}),
	],
})

/**
 * Materialized view pre-aggregating database *query shapes* per hour for the
 * service map's database detail panel. For each Client/Producer DB span it
 * derives a normalized shape key + readable label (see `db-query-shape-sql.ts`,
 * shared byte-for-byte with the query-engine read path's raw-fallback branch)
 * and rolls up call/error/sample counts plus a sample-weighted t-digest of
 * duration.
 *
 * NOTE: `DbSystem` uses the `db.system.name` → `db.system` coalesce
 * (`DB_SYSTEM_ATTR_SQL`), the same as `service_map_db_edges_hourly_mv`.
 */
export const serviceMapDbQuerySignaturesHourlyMv = defineMaterializedView(
	"service_map_db_query_shapes_hourly_mv",
	{
		description:
			"Pre-aggregates Client/Producer DB spans into hourly query-shape buckets (normalized fingerprint + label + sample-weighted t-digest) for the service map's database detail panel.",
		datasource: serviceMapDbQuerySignaturesHourly,
		nodes: [
			node({
				name: "service_map_db_query_shapes_hourly_mv_node",
				sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          ${DB_SYSTEM_ATTR_SQL} AS DbSystem,
          ${DB_NAMESPACE_ATTR_SQL} AS DbNamespace,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          ${DB_QUERY_KEY_SQL} AS QueryKey,
          any(substring(${DB_QUERY_LABEL_SQL}, 1, 220)) AS QueryLabel,
          any(substring(${DB_STATEMENT_SQL}, 1, 1000)) AS SampleStatement,
          count() AS CallCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sum(SampleRate) AS EstimatedCount,
          sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
          sum(toFloat64(Duration) * SampleRate / 1000000) AS WeightedDurationSumMs,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer')
          AND ${DB_SYSTEM_ATTR_SQL} != ''
          AND ServiceName != ''
        GROUP BY OrgId, Hour, ServiceName, DbSystem, DbNamespace, DeploymentEnv, QueryKey
      `,
			}),
		],
	},
)

/**
 * Materialized view pre-aggregating service-to-external-target edges per hour.
 * Captures Client/Producer spans with no database system (DB calls go to
 * `service_map_db_edges_hourly_mv`): plain HTTP outbound, messaging producers,
 * and RPC clients. The exclusion uses the same `DB_SYSTEM_ATTR_SQL` coalesce as
 * the db MV, so a span carrying only the legacy `db.system` is never both.
 *
 * `TargetType` precedence: messaging > rpc > http. A span carrying both
 * `messaging.system` and `server.address` (rare, but happens when a queue
 * client also tags the broker address) lands as messaging — its identity is
 * the queue, not the host. RPC is preferred over http for the same reason.
 *
 * For HTTP the fallback chain for `TargetName` is
 * `server.address` → `http.host` → `url.authority` — modern OTel SDKs emit
 * `server.address`; legacy ones still emit `http.host`; some emit `url.authority`.
 */
export const serviceExternalEdgesHourlyMv = defineMaterializedView("service_external_edges_hourly_mv", {
	description:
		"Pre-aggregates Client/Producer spans without a database system into hourly service-to-external-target edges (http / messaging / rpc) for the service-detail Dependencies tab.",
	datasource: serviceExternalEdgesHourly,
	nodes: [
		node({
			name: "service_external_edges_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          multiIf(
            ${MESSAGING_DESTINATION_SQL} != '' OR SpanAttributes['messaging.system'] != '', 'messaging',
            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', 'rpc',
            'http'
          ) AS TargetType,
          multiIf(
            ${MESSAGING_DESTINATION_SQL} != '' OR SpanAttributes['messaging.system'] != '', SpanAttributes['messaging.system'],
            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', SpanAttributes['rpc.system'],
            ''
          ) AS TargetSystem,
          multiIf(
            ${MESSAGING_DESTINATION_SQL} != '' OR SpanAttributes['messaging.system'] != '',
              if(${MESSAGING_DESTINATION_SQL} != '', ${MESSAGING_DESTINATION_SQL}, SpanAttributes['messaging.system']),
            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '',
              if(SpanAttributes['rpc.service'] != '', SpanAttributes['rpc.service'], SpanAttributes['rpc.system']),
            if(SpanAttributes['server.address'] != '',
              SpanAttributes['server.address'],
              if(SpanAttributes['http.host'] != '',
                SpanAttributes['http.host'],
                SpanAttributes['url.authority']))
          ) AS TargetName,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          count() AS CallCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sum(Duration / 1000000) AS DurationSumMs,
          max(Duration / 1000000) AS MaxDurationMs,
          sum(SampleRate) AS SampleRateSum,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer')
          AND ${DB_SYSTEM_ATTR_SQL} = ''
          AND ServiceName != ''
          AND (
               SpanAttributes['server.address'] != ''
            OR SpanAttributes['http.host'] != ''
            OR SpanAttributes['url.authority'] != ''
            OR ${MESSAGING_DESTINATION_SQL} != ''
            OR SpanAttributes['messaging.system'] != ''
            OR SpanAttributes['rpc.service'] != ''
            OR SpanAttributes['rpc.system'] != ''
          )
        GROUP BY OrgId, Hour, ServiceName, TargetType, TargetSystem, TargetName, DeploymentEnv
        HAVING TargetName != ''
      `,
		}),
	],
})

/**
 * Materialized view pre-aggregating per-service hosting-platform attributes per hour.
 * Picks `max()` per attribute string so non-empty values dominate empty ones —
 * "did any span in this window carry this resource attribute" semantics, which
 * is what the platform classifier needs (kubernetes / cloudflare / lambda).
 */
export const servicePlatformsHourlyMv = defineMaterializedView("service_platforms_hourly_mv", {
	description:
		"Pre-aggregates per-service hosting-platform resource attributes (k8s.*, cloud.*, faas.*) into hourly buckets for the service map's runtime-icon resolver.",
	datasource: servicePlatformsHourly,
	nodes: [
		node({
			name: "service_platforms_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          max(ResourceAttributes['k8s.cluster.name']) AS K8sCluster,
          max(ResourceAttributes['k8s.pod.name']) AS K8sPodName,
          max(ResourceAttributes['k8s.deployment.name']) AS K8sDeploymentName,
          max(ResourceAttributes['k8s.statefulset.name']) AS K8sStatefulSetName,
          max(ResourceAttributes['k8s.daemonset.name']) AS K8sDaemonSetName,
          max(ResourceAttributes['k8s.namespace.name']) AS K8sNamespaceName,
          max(ResourceAttributes['cloud.platform']) AS CloudPlatform,
          max(ResourceAttributes['cloud.provider']) AS CloudProvider,
          max(ResourceAttributes['faas.name']) AS FaasName,
          max(ResourceAttributes['maple.sdk.type']) AS MapleSdkType,
          max(ResourceAttributes['process.runtime.name']) AS ProcessRuntimeName,
          count() AS SpanCount
        FROM traces
        WHERE ServiceName != ''
        GROUP BY OrgId, Hour, ServiceName, DeploymentEnv
      `,
		}),
	],
})

/**
 * Materialized view populating error_events from traces where StatusCode='Error'.
 * Unwraps the first OTel `exception` event. When both the event and StatusMessage
 * are absent, reads `exception.*` then `error.*` span attributes. Computes a
 * cityHash64 FingerprintHash used to group occurrences into Issues.
 *
 * Fingerprint inputs: (OrgId, ServiceName, ExceptionType, top-3 normalized frames
 * (1 for a namespaced type), message signature, FINGERPRINT_HASH_SALT).
 * - Stack lines are filtered by frame SHAPE — one alternative per runtime's frame
 *   syntax — not by "contains `:NUMBER`". The old rule accepted any colon-digit
 *   line, so Drizzle's `params:` line (actual row values) and `Type: message`
 *   headers were hashed as frames. Over 90 days that produced 68,550 fingerprints
 *   from 114 distinct error labels; shape matching plus the signature below brings
 *   the same corpus to 2,080.
 * - Line numbers (`:123`), hex pointers (`0x...`), URL origins and Vite bundle
 *   content hashes are stripped so minor code moves, preview hosts and redeploys
 *   don't rotate the fingerprint.
 * - Top 3 frames are hashed (not just 1) so errors raised inside shared library
 *   code still distinguish between different call sites.
 * - A redacted signature of StatusMessage is folded in ALWAYS, not only when
 *   frames are absent. Bundled runtimes minify every module into one file, so the
 *   top frames alone cannot separate two bugs in the same Worker, and generic
 *   types ("HttpServerError", "Error") would monopolize one bucket per service.
 *   Redaction runs before hashing, so the signature discriminates without
 *   reintroducing cardinality.
 *
 * DeploymentEnv is intentionally NOT part of the hash: the same bug across
 * staging/prod should stay one issue; filter by env at query/triage time.
 *
 * The normalization below is mirrored in `./fingerprint.ts` (TS) for unit tests
 * across Node/Python/Java/Go stack shapes. If you change one, change both.
 */
/**
 * Shared SELECT for the error-events materializations. `error_events` (sorted by
 * FingerprintHash) and `error_events_by_time` (sorted by Timestamp) are populated
 * from the SAME projection of `traces WHERE StatusCode='Error'`; only their target
 * datasource's sort key differs. Keep the fingerprint/label logic in ONE place so the
 * two tables can never diverge — see the long note above about mirroring `fingerprint.ts`.
 */
/**
 * Exported so the fingerprint tests can assert the SQL is really rendered from
 * the shared constants. The tests exercise the TypeScript mirror; without this
 * they would prove nothing about what the warehouse actually computes.
 */
export { errorEventsSelectSql as ERROR_EVENTS_MV_SQL }

const errorEventsSelectSql = `
        WITH
          arrayFirstIndex(n -> n = 'exception', EventsName) AS _ei,
          -- Only fill the old Unknown Error bucket. Event values (including
          -- empty fields) and spans with StatusMessage keep every hash input.
          _ei = 0 AND StatusMessage = '' AS _useAttrs,
          if(
            _ei > 0, EventsAttributes[_ei]['exception.type'],
            if(_useAttrs, coalesce(nullIf(SpanAttributes['exception.type'], ''), SpanAttributes['error.type']), '')
          ) AS _exType,
          if(
            _ei > 0, EventsAttributes[_ei]['exception.message'],
            if(_useAttrs, coalesce(nullIf(SpanAttributes['exception.message'], ''), SpanAttributes['error.message']), StatusMessage)
          ) AS _exMsg,
          if(
            _ei > 0, EventsAttributes[_ei]['exception.stacktrace'],
            if(_useAttrs, SpanAttributes['exception.stacktrace'], '')
          ) AS _exStack,
          if(_useAttrs, _exMsg, StatusMessage) AS _msgText,
          -- JSON detection for the message signature below.
          isValidJSON(_msgText) AS _isJson,
          _isJson AND JSONType(_msgText) = 'Object' AS _isJsonObj,
          -- General, KEY-NAME-AGNOSTIC canonical signature: iterate ALL top-level
          -- keys, redact volatile tokens (long hex / numbers) in each raw value, then
          -- sort by "key=value" so key order & whitespace don't matter. No assumption
          -- about which keys exist — works for any producer's JSON shape. (Nested
          -- objects are hashed as their raw substring; only top-level is canonicalized.)
          arrayStringConcat(
            arraySort(
              arrayMap(
                kv -> concat(kv.1, '=', ${chRedactChain("kv.2", JSON_VALUE_REDACTIONS)}),
                JSONExtractKeysAndValuesRaw(_msgText)
              )
            ),
            '|'
          ) AS _jsonSig,
          -- The message signature is folded in ALWAYS, not only when there are no
          -- frames. Bundled runtimes minify every module into one file, so the top
          -- three frames of a Worker error are \`toDatabaseError (worker.js)\` for
          -- every failing query alike: on frames alone, 25 distinct DatabaseError
          -- bugs (316k occurrences) collapse into a single issue. The signature
          -- restores that discrimination, and it cannot reinflate cardinality the
          -- way a raw prefix would because everything variable is redacted first:
          -- emails, URL origins, home directories, query strings, quoted values,
          -- then ids and every digit run. See ERROR_MSG_REDACTIONS for the order,
          -- what is deliberately kept, and the one residual it cannot reach.
          multiIf(
            _isJsonObj, _jsonSig,
            substringUTF8(
              ${chRedactChain(`substringUTF8(_msgText, 1, ${MSG_SCAN_CHARS})`, ERROR_MSG_REDACTIONS)},
              1, ${MSG_SIGNATURE_CHARS}
            )
          ) AS _msgSig,
          -- Frame lines are matched by SHAPE, not by "contains :NUMBER". The old
          -- rule accepted any line with a colon-digit, which let non-frame lines
          -- in: Drizzle's \`params: <row values>\` line, and the \`Type: message\`
          -- header (\`Code: 62\`, \`position 1628\`, embedded timestamps). Row values
          -- and message text then entered the hash and split one bug into
          -- thousands of issues — 23,035 fingerprints for six real
          -- AnomalyPersistenceError call sites, 15,051 for thirteen DatabaseError
          -- ones.
          --
          -- The pattern is rendered from FRAME_LINE_PATTERN in fingerprint.ts,
          -- as is every redaction below. They used to be hand-copied here, which
          -- let the reference implementation the tests exercise drift away from
          -- the SQL that actually runs, silently.
          arraySlice(
            arrayFilter(
              line -> match(line, ${chPattern(FRAME_LINE_PATTERN)})
                AND position(line, ${chPattern(EFFECT_SPAN_FRAME_MARKER)}) = 0
                AND NOT match(line, ${chPattern(SCHEMA_PATH_LINE_PATTERN)})
                AND NOT match(line, ${chPattern(SPAN_NAME_FRAME_PATTERN)}),
              splitByChar('\\n', _exStack)
            ),
            -- A namespaced type plus its message names one failure: keep only the
            -- throw site. With no message the frames are all that is left; keep 3.
            1, if(position(_exType, '/') > 0 AND _msgSig != '', ${NAMESPACED_TYPE_MAX_FRAMES}, ${MAX_FINGERPRINT_FRAMES})
          ) AS _rawFrames,
          -- Redact every volatile token a frame line can carry: the URL origin
          -- (so preview hosts share one fingerprint), Vite's 8-char bundle
          -- content hash (so a deploy does not re-split every triaged browser and
          -- Worker issue), then line numbers, hex pointers and long id runs. See
          -- FRAME_REDACTIONS for the order and the reasoning.
          arrayMap(
            line -> ${chRedactChain("line", FRAME_REDACTIONS)},
            _rawFrames
          ) AS _topFrames,
          if(length(_topFrames) > 0, _topFrames[1], '') AS _topFrame,
          arrayStringConcat(_topFrames, '\\n') AS _fpFrames,
          -- Display-only, best-effort human label (decoupled from the fingerprint:
          -- many labels may map to one hash). The broad key list here is a DISPLAY
          -- heuristic only; the fingerprint above makes no key-name assumption.
          multiIf(
            JSONExtractString(_msgText, 'title')   != '', JSONExtractString(_msgText, 'title'),
            JSONExtractString(_msgText, 'message') != '', JSONExtractString(_msgText, 'message'),
            JSONExtractString(_msgText, 'error')   != '', JSONExtractString(_msgText, 'error'),
            JSONExtractString(_msgText, '_tag')    != '', JSONExtractString(_msgText, '_tag'),
            JSONExtractString(_msgText, 'reason')  != '', JSONExtractString(_msgText, 'reason'),
            JSONExtractString(_msgText, 'name')    != '', JSONExtractString(_msgText, 'name'),
            JSONExtractString(_msgText, 'type')    != '', extract(JSONExtractString(_msgText, 'type'), '([^/]+)$'),
            'JSON error'
          ) AS _jsonLabel,
          multiIf(
            _msgText = '', 'Unknown Error',
            position(_msgText, '{ readonly') = 1 OR position(_msgText, '└─') > 0,
              if(
                extract(_msgText, 'readonly (\\\\w+)') != '',
                concat('Schema parse error: ', extract(_msgText, 'readonly (\\\\w+)')),
                'Schema parse error'
              ),
            _isJsonObj OR position(_msgText, '[') = 1, _jsonLabel,
            left(_msgText, multiIf(
              position(_msgText, ': ')  > 3, toInt64(position(_msgText, ': '))  - 1,
              position(_msgText, ' (')  > 3, toInt64(position(_msgText, ' (')) - 1,
              position(_msgText, '\\n') > 3, toInt64(position(_msgText, '\\n')) - 1,
              least(toInt64(length(_msgText)), 150)
            ))
          ) AS _statusLabel,
          if(_exType != '', _exType, _statusLabel) AS _errorLabel,
          -- Both semconv spellings; the current key wins when both are present.
          toUInt16OrZero(
            if(
              SpanAttributes['http.response.status_code'] != '',
              SpanAttributes['http.response.status_code'],
              SpanAttributes['http.status_code']
            )
          ) AS _httpStatus
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          ServiceName,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          _exType AS ExceptionType,
          _exMsg AS ExceptionMessage,
          _exStack AS ExceptionStacktrace,
          _topFrame AS TopFrame,
          cityHash64(OrgId, ServiceName, _exType, _fpFrames, _msgSig, ${chPattern(FINGERPRINT_HASH_SALT)}) AS FingerprintHash,
          StatusMessage,
          Duration,
          _errorLabel AS ErrorLabel,
          ResourceAttributes['service.version'] AS ServiceVersion
        FROM traces
        WHERE StatusCode = 'Error'
          -- Client-side runtimes (notably the native Cloudflare Workers
          -- observability) mark ANY non-2xx fetch span as Error, so 404s from bot
          -- traffic arrived here as unlabelled "Unknown Error" issues. Drop a
          -- span only when all hold: 4xx, no exception event, no exception.type
          -- attribute, and no error.type beyond the status code itself (HTTP
          -- semconv sets error.type to the bare status on a non-2xx response,
          -- which carries no exception). 5xx and anything carrying a real
          -- exception still count, and SpanKind is deliberately not consulted —
          -- these are Client spans.
          AND NOT (
            _httpStatus >= 400 AND _httpStatus < 500
            AND _ei = 0
            AND SpanAttributes['exception.type'] = ''
            AND (SpanAttributes['error.type'] = '' OR SpanAttributes['error.type'] = toString(_httpStatus))
          )
      `

export const errorEventsMv = defineMaterializedView("error_events_mv", {
	description:
		"Materializes per-occurrence error events from traces. Unwraps the first OTel exception event (falling back to exception.* / error.* span attributes) and computes a cityHash64 FingerprintHash for issue grouping.",
	datasource: errorEvents,
	nodes: [
		node({
			name: "error_events_mv_node",
			sql: errorEventsSelectSql,
		}),
	],
})

/**
 * Same per-occurrence projection as `error_events_mv`, written to the time-ordered
 * `error_events_by_time` datasource so recent-window scans can prune by Timestamp.
 *
 * Keep this pipe triggered by `traces`: Tinybird does not support changing the
 * trigger datasource of an existing materialized pipe in-place. The compact
 * evaluator rollup can still cascade independently from `error_events` below.
 */
export const errorEventsByTimeMv = defineMaterializedView("error_events_by_time_mv", {
	description:
		"Time-ordered copy of error_events_mv's projection, written to error_events_by_time (sorted by OrgId, Timestamp, FingerprintHash) for recent-window error scans.",
	datasource: errorEventsByTime,
	nodes: [
		node({
			name: "error_events_by_time_mv_node",
			sql: errorEventsSelectSql,
		}),
	],
})

/**
 * Compact source for the per-minute error issue evaluator. This cascades from
 * `error_events`, so fingerprint extraction happens once at ingest and the tick
 * scans one aggregate row per fingerprint/minute instead of raw span payloads.
 */
export const errorFingerprintsMinutelyMv = defineMaterializedView("error_fingerprints_minutely_mv", {
	description:
		"Pre-aggregates error_events by org, minute, and fingerprint for the scheduled issue evaluator.",
	datasource: errorFingerprintsMinutely,
	nodes: [
		node({
			name: "error_fingerprints_minutely_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfMinute(Timestamp) AS Minute,
          FingerprintHash,
          anyLast(ServiceName) AS ServiceName,
          anyLast(ExceptionType) AS ExceptionType,
          anyLast(ExceptionMessage) AS ExceptionMessage,
          anyLast(ErrorLabel) AS ErrorLabel,
          anyLast(TopFrame) AS TopFrame,
          count() AS OccurrenceCount,
          min(Timestamp) AS FirstSeen,
          max(Timestamp) AS LastSeen,
          -- Distinct builds, not a sample: see ServiceVersions on the datasource.
          groupUniqArray(ServiceVersion) AS ServiceVersions
        FROM error_events
        GROUP BY OrgId, Minute, FingerprintHash
      `,
		}),
	],
})

/**
 * Populates `trace_index` with each (trace, service, bucket) a batch of spans
 * lands in. Partial rows from separate inserts merge on `min`/`max`; readers
 * only test membership, so an unmerged duplicate is harmless.
 */
export const traceIndexMv = defineMaterializedView("trace_index_mv", {
	description:
		"Populates trace_index with the (service, 5-minute bucket) ranges each trace's spans occupy in traces",
	datasource: traceIndex,
	nodes: [
		node({
			name: "trace_index_mv_node",
			sql: `
        SELECT
          OrgId,
          TraceId,
          ServiceName,
          ${TRACE_BUCKET_EXPR} AS Bucket,
          min(Timestamp) AS MinTimestamp,
          max(Timestamp) AS MaxTimestamp
        FROM traces
        GROUP BY OrgId, TraceId, ServiceName, Bucket
      `,
		}),
	],
})

/**
 * Populates `ai_trace_index` with only the spans the ingest gateway stamped as
 * GenAI (`maple_ai.vendor.id`). This filter IS Agent Sessions' detection
 * predicate, moved to insert time: the read side
 * (`query-engine-integrations/src/ai/ai-sessions.ts`) carries no vendor
 * predicate at all any more and treats membership in this table as the guard.
 * Narrowing this filter narrows detection.
 *
 * A missing Map key reads back as `''`, so the single `!= ''` comparison is
 * both the presence check and the non-empty check.
 *
 * Every other GenAI column is a projection of the facts the gateway decided
 * for the span and stamped on it (`MAPLE_AI_STAMP_ATTRS`, SQL from
 * `gen-ai-columns.ts`) since migration 0035: the view holds no vendor rule,
 * and a dialect is taught to the gateway instead. Rows materialized before it
 * keep the values the view's own rules gave them until the 30-day TTL. Before
 * 0035 the view coalesced the dialects and classified the span itself.
 * Migration 0026 added the columns; rows materialized before
 * it carry `''`/0 throughout, which the facets drop, the filters never match
 * and the sums count as nothing. Migration 0027 changed `Tokens` to count a
 * nested cache or reasoning bucket once, under the reporter's usage
 * convention; rows materialized between the two keep the over-count.
 * Migration 0031 added the vendor version and the five token buckets, which
 * is what lets the list render a row without touching `trace_detail_spans`;
 * rows materialized before it carry `''`/0 for those too. Migration 0032 added
 * the failure's type, the status message, the tool's description, a failed tool
 * call's result and the failure's fingerprint, which does the same for the tool
 * detail page; rows before it read `''`/0 there, so a failure older than the
 * migration groups under `unknown` and a tool whose only calls predate it shows
 * no description.
 */
export const aiTraceIndexMv = defineMaterializedView("ai_trace_index_mv", {
	description:
		"Populates ai_trace_index with GenAI agent spans (maple_ai.vendor.id stamped), projecting the facts the ingest gateway stamped on each (maple_ai.*: identity, model/agent/tool, kind, usage, failure, a failed tool call's result, the tool's description) plus the environment, the error.type, the status message and the failure's fingerprint, to plain columns.",
	datasource: aiTraceIndex,
	// Migration 0026's columns are additive, and the rows already in the target
	// are explicitly allowed to carry ''/0 for them (see above). Without this,
	// Tinybird migrates the target by replaying `traces` through this pipe — the
	// backfill that crashed the maple_us deploy with an internal error. `alter`
	// adds the columns at promotion with no data movement.
	deploymentMethod: "alter",
	nodes: [
		node({
			name: "ai_trace_index_mv_node",
			sql: `
        SELECT
          OrgId,
          Timestamp,
          TraceId,
          SpanAttributes['${MAPLE_AI_SESSION_ID_ATTR}'] AS SessionId,
          SpanAttributes['${MAPLE_AI_VENDOR_ID_ATTR}'] AS VendorId,
          ServiceName,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          ${GENAI_MODEL_SQL} AS Model,
          ${GENAI_AGENT_NAME_SQL} AS AgentName,
          ${GENAI_TOOL_NAME_SQL} AS ToolName,
          SpanId,
          ParentSpanId,
          Duration,
          ${GENAI_IS_ERROR_SQL} AS IsError,
          ${GENAI_IS_LLM_CALL_SQL} AS IsLlmCall,
          ${GENAI_IS_TOOL_CALL_SQL} AS IsToolCall,
          ${GENAI_TOKENS_SQL} AS Tokens,
          ${GENAI_COST_SQL} AS Cost,
          ${GENAI_RESPONSE_ID_SQL} AS ResponseId,
          SpanAttributes['${MAPLE_AI_VENDOR_VERSION_ATTR}'] AS VendorVersion,
          ${GENAI_INPUT_TOKENS_SQL} AS InputTokens,
          ${GENAI_CACHE_READ_TOKENS_SQL} AS CacheReadTokens,
          ${GENAI_CACHE_WRITE_TOKENS_SQL} AS CacheWriteTokens,
          ${GENAI_OUTPUT_TOKENS_SQL} AS OutputTokens,
          ${GENAI_REASONING_TOKENS_SQL} AS ReasoningTokens,
          ${GENAI_ERROR_TYPE_SQL} AS ErrorType,
          ${GENAI_STATUS_MESSAGE_SQL} AS StatusMessage,
          ${GENAI_TOOL_DESCRIPTION_SQL} AS ToolDescription,
          ${GENAI_FAILED_TOOL_CALL_RESULT_SQL} AS FailedToolCallResult,
          ${GENAI_ERROR_FINGERPRINT_SQL} AS ErrorFingerprint
        FROM traces
        WHERE SpanAttributes['${MAPLE_AI_VENDOR_ID_ATTR}'] != ''
      `,
		}),
	],
})

/**
 * Populates `ai_crawler_requests` with Server spans whose user agent names an AI
 * crawler from `AI_CRAWLERS`. Spans without a request path are skipped: they
 * cannot be attributed to a page (the ingest gateway's own spans are the bulk).
 */
export const aiCrawlerRequestsMv = defineMaterializedView("ai_crawler_requests_mv", {
	description:
		"Populates ai_crawler_requests with Server spans whose user agent names an AI crawler, pre-extracting the crawler, request host, path and HTTP status.",
	datasource: aiCrawlerRequests,
	nodes: [
		node({
			name: "ai_crawler_requests_mv_node",
			sql: `
        SELECT
          OrgId,
          Timestamp,
          TraceId,
          ServiceName,
          ${AI_CRAWLER_NAME_SQL} AS Crawler,
          ${REQUEST_HOST_SQL} AS Host,
          ${REQUEST_PATH_SQL} AS Path,
          ${RESPONSE_STATUS_SQL} AS HttpStatus
        FROM traces
        WHERE SpanKind = 'Server'
          AND ${AI_CRAWLER_INDEX_SQL} > 0
          AND ${REQUEST_PATH_SQL} != ''
      `,
		}),
	],
})

/**
 * Populates `scanner_requests` with Server spans that probe for something an application should
 * not serve, or come from a named scanning tool. Spans without a request path are skipped.
 */
export const scannerRequestsMv = defineMaterializedView("scanner_requests_mv", {
	description:
		"Populates scanner_requests with Server spans whose path matches a probe signature or whose user agent names a scanning tool, pre-extracting the signature, scanner, host, path, status, client address and user agent.",
	datasource: scannerRequests,
	nodes: [
		node({
			name: "scanner_requests_mv_node",
			sql: `
        SELECT
          OrgId,
          Timestamp,
          TraceId,
          ServiceName,
          ${PROBE_SIGNATURE_SQL} AS Signature,
          ${SCANNER_NAME_SQL} AS Scanner,
          ${SCANNER_HOST_SQL} AS Host,
          ${REQUEST_PATH_SQL} AS Path,
          ${RESPONSE_STATUS_SQL} AS HttpStatus,
          ${CLIENT_ADDRESS_SQL} AS ClientAddress,
          ${SCANNER_USER_AGENT_SQL} AS UserAgent
        FROM traces
        WHERE SpanKind = 'Server'
          AND (${CRITICAL_PROBE_INDEX_SQL} > 0 OR ${OTHER_PROBE_INDEX_SQL} > 0 OR ${SCANNER_INDEX_SQL} > 0)
          AND ${REQUEST_PATH_SQL} != ''
      `,
		}),
	],
})

/** Populates `service_runtimes_hourly` with the runtime and SDK each service reports, per hour. */
export const serviceRuntimesHourlyMv = defineMaterializedView("service_runtimes_hourly_mv", {
	description:
		"Counts spans hourly per service, environment, process runtime and telemetry SDK name and version, for the Security Center Runtimes tab.",
	datasource: serviceRuntimesHourly,
	nodes: [
		node({
			name: "service_runtimes_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          ${RUNTIME_NAME_SQL} AS RuntimeName,
          ${RUNTIME_VERSION_SQL} AS RuntimeVersion,
          ${EXECUTABLE_NAME_SQL} AS ExecutableName,
          ${SDK_LANGUAGE_SQL} AS SdkLanguage,
          ${SDK_NAME_SQL} AS SdkName,
          ${SDK_VERSION_SQL} AS SdkVersion,
          count() AS SpanCount
        FROM traces
        WHERE ServiceName != ''
        GROUP BY OrgId, Hour, ServiceName, DeploymentEnv, RuntimeName, RuntimeVersion, ExecutableName, SdkLanguage, SdkName, SdkVersion
      `,
		}),
	],
})

/** Populates `ci_runs` with the root span of each CI trace: one row per workflow run attempt. */
export const ciRunsMv = defineMaterializedView("ci_runs_mv", {
	description:
		"Populates ci_runs with the root span of every github-actions trace, pre-extracting repository, workflow, result, branch, revision and pull request.",
	datasource: ciRuns,
	nodes: [
		node({
			name: "ci_runs_mv_node",
			sql: `
        SELECT
          OrgId,
          Timestamp,
          TraceId,
          SpanId,
          ResourceAttributes['vcs.owner.name'] AS Owner,
          ResourceAttributes['vcs.repository.name'] AS Repository,
          SpanAttributes['cicd.pipeline.name'] AS Pipeline,
          SpanAttributes['cicd.pipeline.run.id'] AS RunId,
          toUInt64OrZero(SpanAttributes['maple.cicd.run_number']) AS RunNumber,
          toUInt16OrZero(SpanAttributes['maple.cicd.run_attempt']) AS Attempt,
          SpanAttributes['cicd.pipeline.result'] AS Result,
          Duration,
          SpanAttributes['cicd.pipeline.run.url.full'] AS Url,
          SpanAttributes['vcs.ref.head.name'] AS Branch,
          SpanAttributes['vcs.ref.head.revision'] AS Revision,
          SpanAttributes['maple.cicd.trigger_event'] AS TriggerEvent,
          SpanAttributes['maple.cicd.actor'] AS Actor,
          toUInt32OrZero(SpanAttributes['vcs.change.id']) AS PullRequest,
          SpanAttributes['maple.cicd.workflow_path'] AS WorkflowPath
        FROM traces
        WHERE ServiceName = '${CI_SERVICE_NAME}'
          AND ParentSpanId = ''
      `,
		}),
	],
})

/** Populates `ci_jobs` with each run's jobs: children that name a task but not a step. */
export const ciJobsMv = defineMaterializedView("ci_jobs_mv", {
	description:
		"Populates ci_jobs with the job spans of every github-actions trace, pre-extracting workflow, job, result, queue time, runner and failure reason.",
	datasource: ciJobs,
	nodes: [
		node({
			name: "ci_jobs_mv_node",
			sql: `
        SELECT
          OrgId,
          Timestamp,
          TraceId,
          SpanId,
          ResourceAttributes['vcs.owner.name'] AS Owner,
          ResourceAttributes['vcs.repository.name'] AS Repository,
          SpanAttributes['cicd.pipeline.name'] AS Pipeline,
          SpanAttributes['cicd.pipeline.run.id'] AS RunId,
          toUInt16OrZero(SpanAttributes['maple.cicd.run_attempt']) AS Attempt,
          SpanAttributes['cicd.pipeline.task.name'] AS Job,
          SpanAttributes['cicd.pipeline.task.run.result'] AS Result,
          StatusCode,
          Duration,
          toUInt32OrZero(SpanAttributes['maple.cicd.queue_duration_ms']) AS QueueMs,
          SpanAttributes['cicd.pipeline.task.run.url.full'] AS Url,
          SpanAttributes['maple.cicd.failure.reason'] AS FailureReason,
          SpanAttributes['cicd.worker.name'] AS RunnerName,
          SpanAttributes['maple.cicd.runner_labels'] AS RunnerLabels
        FROM traces
        WHERE ServiceName = '${CI_SERVICE_NAME}'
          AND ParentSpanId != ''
          AND SpanAttributes['cicd.pipeline.task.name'] != ''
          AND SpanAttributes['maple.cicd.step.number'] = ''
      `,
		}),
	],
})

export const traceListMvMv = defineMaterializedView("trace_list_mv_mv", {
	description:
		"Populates trace_list_mv from root spans with pre-extracted HTTP attributes and normalized span names.",
	datasource: traceListMv,
	nodes: [
		node({
			name: "trace_list_mv_node",
			sql: `
        SELECT
          OrgId,
          TraceId,
          toDateTime(Timestamp) AS Timestamp,
          ServiceName,
          if(
            (SpanName LIKE 'http.server %' OR SpanName IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'))
            AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != ''),
            concat(
              if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName),
              ' ',
              if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])
            ),
            SpanName
          ) AS SpanName,
          SpanKind,
          Duration,
          StatusCode,
          if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) AS HttpMethod,
          if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], if(SpanAttributes['url.path'] != '', SpanAttributes['url.path'], SpanAttributes['http.target'])) AS HttpRoute,
          ${HTTP_STATUS_CODE_SQL} AS HttpStatusCode,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          toUInt8(
            StatusCode = 'Error'
            OR (SpanAttributes['http.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.status_code']) >= 500)
            OR (SpanAttributes['http.response.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.response.status_code']) >= 500)
          ) AS HasError,
          TraceState,
          ResourceAttributes['service.namespace'] AS ServiceNamespace
        FROM traces
        WHERE ParentSpanId = ''
      `,
		}),
	],
})

/** Cascaded off `trace_list_mv`, so it groups by the values the trace list filters on. */
export const traceFacetsHourlyMv = defineMaterializedView("trace_facets_hourly_mv", {
	description:
		"Rolls trace_list_mv up hourly by the traces sidebar facet dimensions, with root-span counts and duration state.",
	datasource: traceFacetsHourly,
	nodes: [
		node({
			name: "trace_facets_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(Timestamp) AS Hour,
          ServiceName,
          SpanName,
          HttpMethod,
          HttpStatusCode,
          DeploymentEnv,
          ServiceNamespace,
          HasError,
          count() AS TraceCount,
          min(Duration) AS DurationMin,
          max(Duration) AS DurationMax,
          quantilesTDigestState(0.5, 0.95)(Duration) AS DurationQuantiles
        FROM trace_list_mv
        GROUP BY OrgId, Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode, DeploymentEnv, ServiceNamespace, HasError
      `,
		}),
	],
})

// Attribute key aggregation MVs

export const traceSpanAttributeKeysMv = defineMaterializedView("trace_span_attribute_keys_mv", {
	description: "Aggregates span attribute keys from traces hourly.",
	datasource: attributeKeysHourly,
	nodes: [
		node({
			name: "trace_span_attribute_keys_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          arrayJoin(mapKeys(SpanAttributes)) AS AttributeKey,
          'span' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        WHERE SpanAttributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
		}),
	],
})

export const traceResourceAttributeKeysMv = defineMaterializedView("trace_resource_attribute_keys_mv", {
	description: "Aggregates resource attribute keys from traces hourly.",
	datasource: attributeKeysHourly,
	nodes: [
		node({
			name: "trace_resource_attribute_keys_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          arrayJoin(mapKeys(ResourceAttributes)) AS AttributeKey,
          'resource' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        WHERE ResourceAttributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
		}),
	],
})

export const logAttributeKeysMv = defineMaterializedView("log_attribute_keys_mv", {
	description: "Aggregates log attribute keys from logs hourly.",
	datasource: attributeKeysHourly,
	nodes: [
		node({
			name: "log_attribute_keys_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          arrayJoin(mapKeys(LogAttributes)) AS AttributeKey,
          'log' AS AttributeScope,
          count() AS UsageCount
        FROM logs
        WHERE LogAttributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
		}),
	],
})

export const metricAttributeKeysMv = defineMaterializedView("metric_attribute_keys_mv", {
	description: "Aggregates metric attribute keys from metrics_sum hourly.",
	datasource: attributeKeysHourly,
	nodes: [
		node({
			name: "metric_attribute_keys_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          arrayJoin(mapKeys(Attributes)) AS AttributeKey,
          'metric' AS AttributeScope,
          count() AS UsageCount
        FROM metrics_sum
        WHERE Attributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
		}),
	],
})

// Metric catalog — one MV per raw metric table, all feeding `metric_catalog`.
// Each hourly-rolls up distinct metrics so the Metrics page discovery queries
// read the tiny catalog instead of scanning raw datapoints.

export const metricCatalogSumMv = defineMaterializedView("metric_catalog_sum_mv", {
	description: "Hourly rollup of distinct sum metrics into metric_catalog.",
	datasource: metricCatalog,
	nodes: [
		node({
			name: "metric_catalog_sum_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          'sum' AS MetricType,
          ServiceName,
          MetricName,
          anyLast(MetricDescription) AS MetricDescription,
          anyLast(MetricUnit) AS MetricUnit,
          anyLast(toUInt8(IsMonotonic)) AS IsMonotonic,
          count() AS DataPointCount,
          min(toDateTime(TimeUnix)) AS FirstSeen,
          max(toDateTime(TimeUnix)) AS LastSeen
        FROM metrics_sum
        GROUP BY OrgId, Hour, MetricType, ServiceName, MetricName
      `,
		}),
	],
})

/**
 * Hourly per-series argMax(value) rollup of the span-metrics calls counter into
 * span_metrics_calls_hourly. Keyed per series-epoch so per-hour increase can be
 * derived as LastValue(hour) − LastValue(prev hour) at read time. The attribute
 * Maps are folded into cityHash64 fingerprints (fixed-width series identity).
 */
export const spanMetricsCallsHourlyMv = defineMaterializedView("span_metrics_calls_hourly_mv", {
	description:
		"Hourly per-series argMax(value) rollup of the span-metrics calls counter into span_metrics_calls_hourly.",
	datasource: spanMetricsCallsHourly,
	nodes: [
		node({
			name: "span_metrics_calls_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          ServiceName,
          MetricName,
          Attributes['span.kind'] AS SpanKind,
          cityHash64(mapKeys(Attributes), mapValues(Attributes)) AS AttrFingerprint,
          cityHash64(mapKeys(ResourceAttributes), mapValues(ResourceAttributes)) AS ResourceFingerprint,
          StartTimeUnix,
          argMaxState(Value, TimeUnix) AS LastValue
        FROM metrics_sum
        -- 'traces.span.metrics.calls' is the name the collector actually emits:
        -- spanmetricsconnector output is namespaced by the pipeline it is attached
        -- to. Without it this MV matched nothing and the target sat at 0 rows since
        -- it was created, while ~880k rows / 2 days of the real counter flowed past
        -- into metrics_sum and every read fell back to the raw window-function scan
        -- (~7s p95 -- see queries/metrics.ts). Keep this list in sync with
        -- SPAN_METRICS_CALLS_NAMES on the read side.
        WHERE MetricName IN ('span.metrics.calls', 'calls', 'traces.span.metrics.calls') AND IsMonotonic
        GROUP BY OrgId, Hour, ServiceName, MetricName, SpanKind, AttrFingerprint, ResourceFingerprint, StartTimeUnix
      `,
		}),
	],
})

export const metricCatalogGaugeMv = defineMaterializedView("metric_catalog_gauge_mv", {
	description: "Hourly rollup of distinct gauge metrics into metric_catalog.",
	datasource: metricCatalog,
	nodes: [
		node({
			name: "metric_catalog_gauge_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          'gauge' AS MetricType,
          ServiceName,
          MetricName,
          anyLast(MetricDescription) AS MetricDescription,
          anyLast(MetricUnit) AS MetricUnit,
          toUInt8(0) AS IsMonotonic,
          count() AS DataPointCount,
          min(toDateTime(TimeUnix)) AS FirstSeen,
          max(toDateTime(TimeUnix)) AS LastSeen
        FROM metrics_gauge
        GROUP BY OrgId, Hour, MetricType, ServiceName, MetricName
      `,
		}),
	],
})

export const metricCatalogHistogramMv = defineMaterializedView("metric_catalog_histogram_mv", {
	description: "Hourly rollup of distinct histogram metrics into metric_catalog.",
	datasource: metricCatalog,
	nodes: [
		node({
			name: "metric_catalog_histogram_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          'histogram' AS MetricType,
          ServiceName,
          MetricName,
          anyLast(MetricDescription) AS MetricDescription,
          anyLast(MetricUnit) AS MetricUnit,
          toUInt8(0) AS IsMonotonic,
          count() AS DataPointCount,
          min(toDateTime(TimeUnix)) AS FirstSeen,
          max(toDateTime(TimeUnix)) AS LastSeen
        FROM metrics_histogram
        GROUP BY OrgId, Hour, MetricType, ServiceName, MetricName
      `,
		}),
	],
})

export const metricCatalogExpHistogramMv = defineMaterializedView("metric_catalog_exp_histogram_mv", {
	description: "Hourly rollup of distinct exponential histogram metrics into metric_catalog.",
	datasource: metricCatalog,
	nodes: [
		node({
			name: "metric_catalog_exp_histogram_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          'exponential_histogram' AS MetricType,
          ServiceName,
          MetricName,
          anyLast(MetricDescription) AS MetricDescription,
          anyLast(MetricUnit) AS MetricUnit,
          toUInt8(0) AS IsMonotonic,
          count() AS DataPointCount,
          min(toDateTime(TimeUnix)) AS FirstSeen,
          max(toDateTime(TimeUnix)) AS LastSeen
        FROM metrics_exponential_histogram
        GROUP BY OrgId, Hour, MetricType, ServiceName, MetricName
      `,
		}),
	],
})

/**
 * Cardinality bound shared by all four `attribute_values_hourly` materializations.
 *
 * That table is an AUTOCOMPLETE INDEX — it exists so the filter builder can
 * suggest values for a key. It is read a couple of hundred times a week. With
 * `AttributeValue != ''` as its only filter it had grown to 1.59 billion rows /
 * 12.3 GB, because `ARRAY JOIN` over an attribute map turns every distinct value
 * into its own row per (org, key, hour).
 *
 * The three rules below were chosen against what was actually in the table, not
 * from intuition — measured over a 6h slice:
 *
 *   - NUMERIC MEASUREMENTS dominated: `idle_ns` (4.9M rows) and `busy_ns` (1.7M)
 *     alone were ~70% of it, with `http.request.body.size` and the
 *     `maple.ingest.*_bytes` counters behind them. Nobody picks
 *     `idle_ns = 486123904` from a dropdown. Digits-only values longer than four
 *     characters are dropped; the threshold deliberately spares HTTP status
 *     codes and ports, which are low-cardinality and genuinely pickable.
 *   - LONG VALUES: `db.query.text` averaged 864 characters, `body` 334,
 *     `http.response.header.report-to` 241, `url.full` 146. Useless as
 *     suggestions and the bulk of the bytes.
 *   - UNBOUNDED IDENTIFIERS: ids and captured HTTP headers (`cf-ray`,
 *     `x-request-id`, `traceparent`, `date`) are unique per request by
 *     definition. Matched by shape rather than by an exact key list so this
 *     generalizes past whichever keys one customer happens to emit.
 *
 * This narrows VALUE suggestions only. `attribute_keys_hourly` is untouched, so
 * every key stays discoverable and filterable — you just do not get a dropdown
 * of values for a nanosecond counter.
 *
 * Regexes use `[.]` rather than an escaped dot to keep the emitted SQL free of
 * backslash escaping across the TS template → DDL → chDB path.
 */
const attributeValueCardinalityBound = `WHERE AttributeValue != ''
          AND length(AttributeValue) <= 128
          AND NOT (length(AttributeValue) > 4 AND match(AttributeValue, '^[0-9]+([.][0-9]+)?$'))
          AND NOT match(AttributeKey, '(_id|[.]id|Id|_ns)$')
          AND AttributeKey NOT LIKE 'http.request.header.%'
          AND AttributeKey NOT LIKE 'http.response.header.%'`

export const logAttributeValuesMv = defineMaterializedView("log_attribute_values_mv", {
	description: "Aggregates log attribute values from logs hourly.",
	datasource: attributeValuesHourly,
	nodes: [
		node({
			name: "log_attribute_values_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          AttributeKey,
          AttributeValue,
          'log' AS AttributeScope,
          count() AS UsageCount
        FROM logs
        ARRAY JOIN
          mapKeys(LogAttributes) AS AttributeKey,
          mapValues(LogAttributes) AS AttributeValue
        ${attributeValueCardinalityBound}
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
		}),
	],
})

export const metricAttributeValuesMv = defineMaterializedView("metric_attribute_values_mv", {
	description: "Aggregates metric attribute values from metrics_sum hourly.",
	datasource: attributeValuesHourly,
	nodes: [
		node({
			name: "metric_attribute_values_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          AttributeKey,
          AttributeValue,
          'metric' AS AttributeScope,
          count() AS UsageCount
        FROM metrics_sum
        ARRAY JOIN
          mapKeys(Attributes) AS AttributeKey,
          mapValues(Attributes) AS AttributeValue
        ${attributeValueCardinalityBound}
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
		}),
	],
})

export const traceSpanAttributeValuesMv = defineMaterializedView("trace_span_attribute_values_mv", {
	description: "Aggregates span attribute values from traces hourly.",
	datasource: attributeValuesHourly,
	nodes: [
		node({
			name: "trace_span_attribute_values_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          AttributeKey,
          AttributeValue,
          'span' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        ARRAY JOIN
          mapKeys(SpanAttributes) AS AttributeKey,
          mapValues(SpanAttributes) AS AttributeValue
        ${attributeValueCardinalityBound}
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
		}),
	],
})

export const traceResourceAttributeValuesMv = defineMaterializedView("trace_resource_attribute_values_mv", {
	description: "Aggregates resource attribute values from traces hourly.",
	datasource: attributeValuesHourly,
	nodes: [
		node({
			name: "trace_resource_attribute_values_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          AttributeKey,
          AttributeValue,
          'resource' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        ARRAY JOIN
          mapKeys(ResourceAttributes) AS AttributeKey,
          mapValues(ResourceAttributes) AS AttributeValue
        ${attributeValueCardinalityBound}
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
		}),
	],
})

/**
 * Populates traces_aggregates_hourly with sample-weighted -State aggregates.
 * One row per (OrgId, Hour, ServiceName, SpanName, SpanKind, StatusCode,
 * IsEntryPoint, DeploymentEnv) tuple. The query layer routes timeseries +
 * breakdown queries here when filters/groupBy align.
 *
 * Cardinality note: SpanName is in the sort key. If any tenant emits high-
 * cardinality span names (per-request data instead of templated routes),
 * the row count grows quickly. See docs/persistence.md and the cardinality
 * pre-flight query in the rollout plan.
 */
export const tracesAggregatesHourlyMv = defineMaterializedView("traces_aggregates_hourly_mv", {
	description:
		"Pre-aggregates spans hourly with sample-weighted state columns (count, duration sum, t-digest quantiles, error count). Sample-correct from day one via SampleRate materialized column on traces.",
	datasource: tracesAggregatesHourly,
	nodes: [
		node({
			name: "traces_aggregates_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          SpanName,
          SpanKind,
          StatusCode,
          IsEntryPoint,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          sum(SampleRate) AS WeightedCount,
          sum(toFloat64(Duration) * SampleRate) AS WeightedDurationSum,
          sumIf(SampleRate, StatusCode = 'Error') AS WeightedErrorCount,
          quantilesTDigestWeightedState(0.5, 0.95, 0.99)(Duration, toUInt32(SampleRate)) AS DurationQuantiles,
          min(Duration) AS DurationMin,
          max(Duration) AS DurationMax
        FROM traces
        GROUP BY OrgId, Hour, ServiceName, SpanName, SpanKind, StatusCode, IsEntryPoint, DeploymentEnv
      `,
		}),
	],
})

/**
 * Precomputes the operation display name and minute-grain aggregates used by
 * the service detail page. All spans are included: internal operations are a
 * deliberate part of the ranking, matching the previous raw query.
 */
export const serviceOperationsMinutelyMv = defineMaterializedView("service_operations_minutely_mv", {
	description:
		"Pre-aggregates every span by service operation and minute with normalized HTTP names, exact/estimated counts, errors, duration sum, and unweighted t-digest state.",
	datasource: serviceOperationsMinutely,
	// Migration 0023 adds three counter columns to the target. Without this,
	// Tinybird treats a changed MV node as a reason to REBUILD the target by
	// replaying its source — and the source here is `traces`, which keeps 30 days
	// against this rollup's 90. The deploy warns and then drops eight months of
	// history that cannot be reconstructed. `alter` applies the column addition
	// with no data movement at promotion, which is what an additive change
	// actually needs, and is also why these rollups need no FORWARD_QUERY (a
	// leftover one makes every later deploy fail — see the note in datasources).
	// Migration 0048's six HTTP measures rely on the same directive.
	deploymentMethod: "alter",
	nodes: [
		node({
			name: "service_operations_minutely_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfMinute(toDateTime(Timestamp)) AS Minute,
          ServiceName,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          ${NORMALIZED_SPAN_NAME_SQL} AS SpanName,
          count() AS SpanCount,
          sum(SampleRate) AS EstimatedSpanCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
          sum(toFloat64(Duration)) AS DurationSum,
          quantilesTDigestState(0.5, 0.95)(Duration) AS DurationQuantiles,
          count() AS ClassifiedSpanCount,
          countIf(SpanKind IN ('Server', 'Consumer')) AS ServerSpanCount,
          countIf(SpanAttributes['http.route'] != '') AS RoutedSpanCount,
          ${HTTP.HttpClassifiedSpanCount} AS HttpClassifiedSpanCount,
          ${HTTP.HttpStatusCount} AS HttpStatusCount,
          ${HTTP.Http4xxCount} AS Http4xxCount,
          ${HTTP.Http5xxCount} AS Http5xxCount,
          ${HTTP.RequestBodyBytes} AS RequestBodyBytes,
          ${HTTP.RequestBodyCount} AS RequestBodyCount
        FROM traces
        GROUP BY OrgId, Minute, ServiceName, DeploymentEnv, SpanName
      `,
		}),
	],
})

/**
 * Cascading hourly rollup. It consumes the already-normalized minutely insert
 * stream, so HTTP route normalization happens once and the t-digest state is
 * merged rather than finalized and rebuilt.
 */
export const serviceOperationsHourlyMv = defineMaterializedView("service_operations_hourly_mv", {
	description: "Merges minutely service-operation aggregates into an hour-grain one-year rollup.",
	datasource: serviceOperationsHourly,
	// Same reason as the minutely view, one tier worse: this target keeps 365 days
	// and its source keeps 90, so a rebuild silently truncates the annual rollup
	// to a quarter.
	deploymentMethod: "alter",
	nodes: [
		node({
			name: "service_operations_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(Minute) AS Hour,
          ServiceName,
          DeploymentEnv,
          SpanName,
          sum(SpanCount) AS SpanCount,
          sum(EstimatedSpanCount) AS EstimatedSpanCount,
          sum(ErrorCount) AS ErrorCount,
          sum(EstimatedErrorCount) AS EstimatedErrorCount,
          sum(DurationSum) AS DurationSum,
          quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles) AS DurationQuantiles,
          sum(ClassifiedSpanCount) AS ClassifiedSpanCount,
          sum(ServerSpanCount) AS ServerSpanCount,
          sum(RoutedSpanCount) AS RoutedSpanCount,
          sum(HttpClassifiedSpanCount) AS HttpClassifiedSpanCount,
          sum(HttpStatusCount) AS HttpStatusCount,
          sum(Http4xxCount) AS Http4xxCount,
          sum(Http5xxCount) AS Http5xxCount,
          sum(RequestBodyBytes) AS RequestBodyBytes,
          sum(RequestBodyCount) AS RequestBodyCount
        FROM service_operations_minutely
        GROUP BY OrgId, Hour, ServiceName, DeploymentEnv, SpanName
      `,
		}),
	],
})

/** Request body bytes as Int64 with -1 for none, so `argMax` keeps the slowest row either way. */
const SLOWEST_BODY_SIZE_SQL = `ifNull(toInt64(${REQUEST_BODY_SIZE_SQL}), -1)`

/**
 * Hourly HTTP endpoint detail off raw `traces`, for the service API tab. Reads Server
 * spans with a response status; the SpanName expression is the operations rollup's so
 * the two tables join on it.
 */
export const serviceEndpointDetailsHourlyMv = defineMaterializedView("service_endpoint_details_hourly_mv", {
	description:
		"Pre-aggregates HTTP server spans hourly per normalized endpoint, status code and error.type: counts, latency and body-size t-digests, top user agents and the slowest request.",
	datasource: serviceEndpointDetailsHourly,
	// The target keeps 90 days and `traces` 30, so a rebuild at promotion would cut it to a
	// month. `alter` keeps every later change in place (live in US and EU since 2026-10-24).
	deploymentMethod: "alter",
	nodes: [
		node({
			name: "service_endpoint_details_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          ${NORMALIZED_SPAN_NAME_SQL} AS SpanName,
          ${HTTP_STATUS_CODE_SQL} AS HttpStatusCode,
          SpanAttributes['error.type'] AS ErrorType,
          count() AS SpanCount,
          sum(SampleRate) AS EstimatedSpanCount,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,
          quantilesTDigestIfState(0.5, 0.95, 0.99)(ifNull(${REQUEST_BODY_SIZE_SQL}, 0), ${REQUEST_BODY_SIZE_SQL} IS NOT NULL) AS BodySizeQuantiles,
          maxIf(ifNull(${REQUEST_BODY_SIZE_SQL}, 0), ${REQUEST_BODY_SIZE_SQL} IS NOT NULL) AS BodySizeMax,
          countIf(${REQUEST_BODY_SIZE_SQL} IS NOT NULL) AS BodyCount,
          approx_top_kState(10)(${USER_AGENT_SQL}) AS UserAgents,
          max(Duration) AS SlowestDuration,
          argMaxState(TraceId, Duration) AS SlowestTraceId,
          argMaxState(Timestamp, Duration) AS SlowestTimestamp,
          argMaxState(${SLOWEST_BODY_SIZE_SQL}, Duration) AS SlowestBodySize
        FROM traces
        WHERE ${HTTP_SERVER_SPAN_SQL}
          AND ${HTTP_STATUS_CODE_SQL} != ''
        GROUP BY OrgId, ServiceName, Hour, DeploymentEnv, SpanName, HttpStatusCode, ErrorType
      `,
		}),
	],
})

/**
 * Populates logs_aggregates_hourly. Severity-aware drop-in for
 * severity-distribution and log-volume dashboards.
 */
export const logsAggregatesHourlyMv = defineMaterializedView("logs_aggregates_hourly_mv", {
	description:
		"Pre-aggregates logs hourly by service × severity × deployment env. Drop-in for severity-distribution and log-volume queries.",
	datasource: logsAggregatesHourly,
	nodes: [
		node({
			name: "logs_aggregates_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(TimestampTime) AS Hour,
          ServiceName,
          SeverityText,
          ${DEPLOYMENT_ENV_SQL} AS DeploymentEnv,
          count() AS Count,
          sum(length(Body) + 200) AS SizeBytes,
          ResourceAttributes['service.namespace'] AS ServiceNamespace
        FROM logs
        GROUP BY OrgId, Hour, ServiceName, SeverityText, DeploymentEnv, ServiceNamespace
      `,
		}),
	],
})

/**
 * Populates the browser half of `product_events` — the product events fact table.
 *
 * A pure row-wise projection: filter to the two product-analytics event types,
 * pre-extract `domain(Url)`/`path(Url)`, re-sort by time in the target. No
 * aggregation, which is what makes this safe as a materialized view.
 *
 * That distinction is load-bearing, because the neighbouring table is not.
 * `session_replays` is a `ReplacingMergeTree(Version)` whose SDK writes a v1 row
 * at session start and a v2 row at session end. A materialized view fires per
 * *inserted block*, so it would see those as two independent sessions and
 * evaluate any per-session predicate against half a session — `PageViews <= 1`
 * against the v1 row (where `PageViews` is 0) would report every session as a
 * bounce, which is exactly the bug `webAnalyticsSummaryQuery`'s doc comment
 * records having shipped once already. `session_events` has no such hazard: it
 * is an append-only MergeTree with no dedup and no versioning, so per-block
 * firing is irrelevant here.
 *
 * `Type` is carried through as `Kind` rather than folded into `EventName`, so
 * the page-view predicate stays provably identical to the pre-rollup
 * `Type = 'navigation'` even if a customer calls `track('$pageview')`.
 *
 * `Source` is the literal `'browser'`: this view is the only writer of browser
 * rows, and the backfill deletes by it. Identity columns are copied through from
 * the SDK-stamped `session_events` row — never joined from `session_replays`,
 * whose v1/v2 rows may land after the event.
 *
 * Column order must match the `product_events` SCHEMA order — enforced by
 * `materialized-projection-order.test.ts`.
 */
export const productEventsMv = defineMaterializedView("product_events_mv", {
	description:
		"Populates product_events from session_events navigation and custom rows, with domain(Url)/path(Url) pre-extracted, the event name normalized and the SDK-stamped identity copied through.",
	datasource: productEvents,
	nodes: [
		node({
			name: "product_events_mv_node",
			sql: `
        SELECT
          OrgId,
          Timestamp,
          'browser' AS Source,
          SessionId,
          Seq,
          VisitorId,
          UserId,
          GroupId,
          Type AS Kind,
          if(Type = 'navigation', '$pageview', Message) AS EventName,
          domain(Url) AS Host,
          path(Url) AS PagePath,
          Url,
          '' AS ServiceName,
          Attributes,
          '' AS TraceId,
          '' AS SpanId
        FROM session_events
        WHERE Type IN ('navigation', 'custom')
      `,
		}),
	],
})

/**
 * Populates `product_events` from spans carrying `maple.product_event.name` —
 * the only feed that carries `TraceId`. The predicate is one map lookup per
 * incoming span (an MV sees the insert block, so no skip index helps). Column
 * order must match the `product_events` SCHEMA order, enforced by
 * `materialized-projection-order.test.ts`.
 */
export const productEventsTracesMv = defineMaterializedView("product_events_traces_mv", {
	description:
		"Populates product_events from spans carrying the maple.product_event.name attribute, projecting the span's identity, attributes (narrowed by maple.product_event.include, merged with maple.product_event.prop.*), service and TraceId/SpanId so the event links back to the trace that produced it.",
	datasource: productEvents,
	nodes: [
		node({
			name: "product_events_traces_mv_node",
			sql: `
        SELECT
          ${PRODUCT_EVENTS_TRACE_PROJECTION_SQL}
        FROM traces
        WHERE ${PRODUCT_EVENTS_TRACE_FILTER}
      `,
		}),
	],
})

/**
 * Populates `identity_links` from `session_replays` rows that carry both a
 * visitor and a user id.
 *
 * Per-block firing is harmless here for the same reason it is fatal for
 * per-session aggregates: this is a pure filter+project of one row, and the
 * target is a ReplacingMergeTree keyed on the pair, so seeing the v1 and v2 rows
 * of one session just re-inserts the same link.
 */
export const identityLinksMv = defineMaterializedView("identity_links_mv", {
	description:
		"Populates identity_links with every (VisitorId, UserId) pair observed on a session_replays row.",
	datasource: identityLinks,
	nodes: [
		node({
			name: "identity_links_mv_node",
			sql: `
        SELECT
          OrgId,
          VisitorId,
          UserId,
          StartTime AS FirstSeen
        FROM session_replays
        WHERE VisitorId != '' AND UserId != ''
      `,
		}),
	],
})
