import * as Datasources from "./datasources"

/** The token the ingest gateway and its OTel collector write with. It can only append. */
export const INGEST_APPEND_TOKEN = "maple_ingest_append"

/**
 * Every datasource `apps/ingest` posts rows to (`telemetry.rs`, `audit_trail.rs`, `profiles.rs`,
 * `clickhouse_insert_mappings.rs`) plus the collector's. A datasource missing here refuses its rows.
 */
export const INGEST_WRITTEN_DATASOURCES: ReadonlySet<string> = new Set([
	Datasources.traces._name,
	Datasources.logs._name,
	Datasources.metricsSum._name,
	Datasources.metricsGauge._name,
	Datasources.metricsHistogram._name,
	Datasources.metricsExponentialHistogram._name,
	Datasources.profiles._name,
	Datasources.sessionReplays._name,
	Datasources.sessionReplayEvents._name,
	Datasources.sessionEvents._name,
	Datasources.productEvents._name,
	Datasources.auditTrailEvents._name,
])

/**
 * A datasource file as `tb deploy` gets it: the gateway's datasources grant the append token,
 * which the deploy creates on first sight. Kept out of the schema manifest and its revision.
 */
export const withIngestAppendToken = (name: string, content: string): string =>
	INGEST_WRITTEN_DATASOURCES.has(name) ? `${content}\n\nTOKEN ${INGEST_APPEND_TOKEN} APPEND\n` : content
