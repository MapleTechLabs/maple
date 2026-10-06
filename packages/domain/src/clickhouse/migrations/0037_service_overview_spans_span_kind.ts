/**
 * Migration 0037: service_overview_spans records why a row is an entry point.
 *
 * The projection admits Server and Consumer spans plus every trace root, and
 * kept none of that, so a query could not tell request traffic from consumers
 * or from background roots. `SpanKind` and `IsRoot` (`ParentSpanId = ''`) now
 * carry it. Nothing is backfilled: older rows read '' / 0 until the table's
 * 30-day TTL ages them out.
 *
 * The view is dropped and recreated because a materialized view's SELECT is
 * frozen at creation. `requiredForIngest: false`: the gateway writes `traces`,
 * never this table. The CREATE statement is the verbatim DDL the schema emitter
 * produced at v37; never re-derive it from a later snapshot.
 */
export const migration_0037_service_overview_spans_span_kind = {
	version: 37,
	description: "Add SpanKind and IsRoot to service_overview_spans and recreate its view to fill them",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE service_overview_spans ADD COLUMN IF NOT EXISTS SpanKind LowCardinality(String) DEFAULT ''",
		"ALTER TABLE service_overview_spans ADD COLUMN IF NOT EXISTS IsRoot UInt8 DEFAULT 0",
		"DROP VIEW IF EXISTS service_overview_spans_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_overview_spans_mv TO service_overview_spans AS\nSELECT\n          OrgId,\n          toDateTime(Timestamp) AS Timestamp,\n          ServiceName,\n          Duration,\n          StatusCode,\n          TraceState,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          ResourceAttributes['vcs.ref.head.revision'] AS CommitSha,\n          SampleRate,\n          ResourceAttributes['service.namespace'] AS ServiceNamespace,\n          SpanKind,\n          toUInt8(ParentSpanId = '') AS IsRoot\n        FROM traces\n        WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''",
	],
} as const
