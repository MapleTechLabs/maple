/**
 * Migration 0038: `trace_list_entry_spans`, the stand-in rows for traces whose
 * root span was never received.
 *
 * `trace_list_mv` holds parentless spans only, so a trace that enters through a
 * proxy which injects `traceparent` without exporting its own span, or whose
 * root was dropped, has no row there and was missing from the trace list, its
 * facets and the trace search. This is the same projection over the spans that
 * can stand in for it: Server/Consumer spans that have a parent.
 *
 * Nothing is backfilled; the view fills forward from creation, and a trace with
 * no row here is listed exactly as before. `requiredForIngest: false`: nothing
 * writes the table directly.
 *
 * The CREATE statements are the verbatim DDL the schema emitter produced at v38.
 * Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0038_trace_list_entry_spans = {
	version: 38,
	description:
		"Create trace_list_entry_spans + trace_list_entry_spans_mv: entry spans that list traces with no root span",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS trace_list_entry_spans (\n    OrgId LowCardinality(String),\n    TraceId String,\n    Timestamp DateTime,\n    ServiceName LowCardinality(String),\n    SpanName String,\n    SpanKind LowCardinality(String),\n    Duration UInt64,\n    StatusCode LowCardinality(String),\n    HttpMethod LowCardinality(String),\n    HttpRoute String,\n    HttpStatusCode LowCardinality(String),\n    DeploymentEnv LowCardinality(String),\n    HasError UInt8,\n    TraceState String,\n    ServiceNamespace LowCardinality(String),\n    INDEX idx_service_namespace ServiceNamespace TYPE set(1000) GRANULARITY 4\n)\nENGINE = MergeTree\nPARTITION BY toDate(Timestamp)\nORDER BY (OrgId, Timestamp, TraceId)\nTTL Timestamp + INTERVAL 30 DAY",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS trace_list_entry_spans_mv TO trace_list_entry_spans AS\nSELECT\n          OrgId,\n          TraceId,\n          toDateTime(Timestamp) AS Timestamp,\n          ServiceName,\n          if(\n            (SpanName LIKE 'http.server %' OR SpanName IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'))\n            AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != ''),\n            concat(\n              if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName),\n              ' ',\n              if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])\n            ),\n            SpanName\n          ) AS SpanName,\n          SpanKind,\n          Duration,\n          StatusCode,\n          if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) AS HttpMethod,\n          if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], if(SpanAttributes['url.path'] != '', SpanAttributes['url.path'], SpanAttributes['http.target'])) AS HttpRoute,\n          if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) AS HttpStatusCode,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          toUInt8(\n            StatusCode = 'Error'\n            OR (SpanAttributes['http.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.status_code']) >= 500)\n            OR (SpanAttributes['http.response.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.response.status_code']) >= 500)\n          ) AS HasError,\n          TraceState,\n          ResourceAttributes['service.namespace'] AS ServiceNamespace\n        FROM traces\n        WHERE SpanKind IN ('Server', 'Consumer') AND ParentSpanId != ''",
	],
} as const
