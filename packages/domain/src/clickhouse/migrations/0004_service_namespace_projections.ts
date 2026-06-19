import type { BackfillSpec } from "../backfill"

/**
 * Migration 0004 — service.namespace projections.
 *
 * Adds `ServiceNamespace` as a pre-extracted projection dimension for service
 * overview, trace-list, and log aggregate queries. `logs_aggregates_hourly` is
 * an AggregatingMergeTree whose grouping dimensions must be part of ORDER BY,
 * so we rebuild/swap the table instead of trying to alter the immutable key.
 *
 * The three heavy backfills (`service_overview_spans` and `trace_list_mv` from
 * `traces`, and `logs_aggregates_hourly__v4` from `logs`) are expressed as
 * {@link BackfillSpec}s so the apply engine can window them into chunks — a
 * single `INSERT…SELECT` over billions of source rows otherwise exceeds the
 * Cloudflare Worker subrequest budget. Structural DDL stays as raw strings.
 */

const serviceOverviewSpansBackfill: BackfillSpec = {
	kind: "backfill",
	target: "service_overview_spans",
	columns: [
		"OrgId",
		"Timestamp",
		"ServiceName",
		"Duration",
		"StatusCode",
		"TraceState",
		"DeploymentEnv",
		"CommitSha",
		"SampleRate",
		"ServiceNamespace",
	],
	from: "traces",
	tsColumn: "Timestamp",
	select: `OrgId,
  toDateTime(Timestamp) AS Timestamp,
  ServiceName,
  Duration,
  StatusCode,
  TraceState,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  ResourceAttributes['deployment.commit_sha'] AS CommitSha,
  SampleRate,
  ResourceAttributes['service.namespace'] AS ServiceNamespace`,
	where: "SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''",
}

// NOTE: the HTTP span-name display rewrite and semconv coalescing in this
// backfill `select` are mirrored in TypeScript by `httpDisplaySpanName` /
// `buildAttrFilterCondition` in `@maple/query-engine` (traces-shared.ts), and
// match `trace_list_mv_mv` in materializations.ts. Keep all three in sync — the
// parity is enforced by traces-shared.test.ts.
const traceListBackfill: BackfillSpec = {
	kind: "backfill",
	target: "trace_list_mv",
	columns: [
		"OrgId",
		"TraceId",
		"Timestamp",
		"ServiceName",
		"SpanName",
		"SpanKind",
		"Duration",
		"StatusCode",
		"HttpMethod",
		"HttpRoute",
		"HttpStatusCode",
		"DeploymentEnv",
		"HasError",
		"TraceState",
		"ServiceNamespace",
	],
	from: "traces",
	tsColumn: "Timestamp",
	select: `OrgId,
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
  if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) AS HttpStatusCode,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  toUInt8(
    StatusCode = 'Error'
    OR (SpanAttributes['http.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.status_code']) >= 500)
    OR (SpanAttributes['http.response.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.response.status_code']) >= 500)
  ) AS HasError,
  TraceState,
  ResourceAttributes['service.namespace'] AS ServiceNamespace`,
	where: "ParentSpanId = ''",
}

const logsAggregatesBackfill: BackfillSpec = {
	kind: "backfill",
	target: "logs_aggregates_hourly__v4",
	columns: [
		"OrgId",
		"Hour",
		"ServiceName",
		"SeverityText",
		"DeploymentEnv",
		"Count",
		"SizeBytes",
		"ServiceNamespace",
	],
	from: "logs",
	tsColumn: "TimestampTime",
	select: `OrgId,
  toStartOfHour(TimestampTime) AS Hour,
  ServiceName,
  SeverityText,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  count() AS Count,
  sum(length(Body) + 200) AS SizeBytes,
  ResourceAttributes['service.namespace'] AS ServiceNamespace`,
	groupBy: "OrgId, Hour, ServiceName, SeverityText, DeploymentEnv, ServiceNamespace",
}

export const migration_0004_service_namespace_projections = {
	version: 4,
	description:
		"Add service.namespace projections, rebuild logs aggregate sorting key, and recreate namespace-aware MVs",
	statements: [
		"DROP VIEW IF EXISTS service_overview_spans_mv",
		"DROP VIEW IF EXISTS trace_list_mv_mv",
		"DROP VIEW IF EXISTS logs_aggregates_hourly_mv",

		"ALTER TABLE service_overview_spans ADD COLUMN IF NOT EXISTS ServiceNamespace LowCardinality(String) DEFAULT ''",
		"ALTER TABLE trace_list_mv ADD COLUMN IF NOT EXISTS ServiceNamespace LowCardinality(String) DEFAULT ''",
		"ALTER TABLE logs_aggregates_hourly ADD COLUMN IF NOT EXISTS ServiceNamespace LowCardinality(String) DEFAULT ''",

		"ALTER TABLE service_overview_spans ADD INDEX IF NOT EXISTS idx_service_namespace ServiceNamespace TYPE set(1000) GRANULARITY 4",
		"ALTER TABLE trace_list_mv ADD INDEX IF NOT EXISTS idx_service_namespace ServiceNamespace TYPE set(1000) GRANULARITY 4",

		"TRUNCATE TABLE IF EXISTS service_overview_spans",
		serviceOverviewSpansBackfill,

		"TRUNCATE TABLE IF EXISTS trace_list_mv",
		traceListBackfill,

		"DROP TABLE IF EXISTS logs_aggregates_hourly__v4",
		`CREATE TABLE IF NOT EXISTS logs_aggregates_hourly__v4 (
  OrgId LowCardinality(String),
  Hour DateTime,
  ServiceName LowCardinality(String),
  SeverityText LowCardinality(String),
  DeploymentEnv LowCardinality(String),
  Count SimpleAggregateFunction(sum, UInt64),
  SizeBytes SimpleAggregateFunction(sum, UInt64),
  ServiceNamespace LowCardinality(String),
  INDEX idx_service_namespace ServiceNamespace TYPE set(1000) GRANULARITY 4
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, ServiceName, SeverityText, DeploymentEnv, ServiceNamespace)
TTL toDate(Hour) + INTERVAL 90 DAY`,
		`INSERT INTO logs_aggregates_hourly__v4 (
  OrgId,
  Hour,
  ServiceName,
  SeverityText,
  DeploymentEnv,
  Count,
  SizeBytes,
  ServiceNamespace
)
SELECT
  OrgId,
  Hour,
  ServiceName,
  SeverityText,
  DeploymentEnv,
  sum(Count) AS Count,
  sum(SizeBytes) AS SizeBytes,
  ServiceNamespace
FROM logs_aggregates_hourly
WHERE Hour < (
  SELECT if(count() = 0, toDateTime('2100-01-01'), toStartOfHour(min(TimestampTime)))
  FROM logs
)
GROUP BY OrgId, Hour, ServiceName, SeverityText, DeploymentEnv, ServiceNamespace`,
		logsAggregatesBackfill,
		"DROP TABLE IF EXISTS logs_aggregates_hourly__v4_old",
		"RENAME TABLE logs_aggregates_hourly TO logs_aggregates_hourly__v4_old, logs_aggregates_hourly__v4 TO logs_aggregates_hourly",
		"DROP TABLE IF EXISTS logs_aggregates_hourly__v4_old",

		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_overview_spans_mv TO service_overview_spans AS
SELECT
  OrgId,
  toDateTime(Timestamp) AS Timestamp,
  ServiceName,
  Duration,
  StatusCode,
  TraceState,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  ResourceAttributes['deployment.commit_sha'] AS CommitSha,
  SampleRate,
  ResourceAttributes['service.namespace'] AS ServiceNamespace
FROM traces
WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS trace_list_mv_mv TO trace_list_mv AS
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
  if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) AS HttpStatusCode,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  toUInt8(
    StatusCode = 'Error'
    OR (SpanAttributes['http.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.status_code']) >= 500)
    OR (SpanAttributes['http.response.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.response.status_code']) >= 500)
  ) AS HasError,
  TraceState,
  ResourceAttributes['service.namespace'] AS ServiceNamespace
FROM traces
WHERE ParentSpanId = ''`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS logs_aggregates_hourly_mv TO logs_aggregates_hourly AS
SELECT
  OrgId,
  toStartOfHour(TimestampTime) AS Hour,
  ServiceName,
  SeverityText,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  count() AS Count,
  sum(length(Body) + 200) AS SizeBytes,
  ResourceAttributes['service.namespace'] AS ServiceNamespace
FROM logs
GROUP BY OrgId, Hour, ServiceName, SeverityText, DeploymentEnv, ServiceNamespace`,
	],
} as const
