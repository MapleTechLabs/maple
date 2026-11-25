import * as Datasources from "./datasources"

/** The token the ingest gateway and its OTel collector write with. It can only append. */
export const INGEST_APPEND_TOKEN = "maple_ingest_append"

/**
 * The datasources the gateway inserts telemetry into. `scripts/generate-clickhouse-insert-mappings.ts`
 * builds the gateway's insert table (`clickhouse_insert_mappings.rs`) from this list.
 */
export const INGEST_INSERT_DATASOURCES = [
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
] as const

/**
 * Columns with a JSON path the gateway does not write yet, so the table's default fills them. Its
 * insert mappings leave them out: a self-managed cluster below migration 75 has no `RetentionDays`.
 */
export const INGEST_UNWRITTEN_COLUMNS: ReadonlySet<string> = new Set(["RetentionDays"])

/**
 * Every datasource the append token covers: the insert list plus the audit trail, which the
 * gateway writes outside it. Emitted into Rust as `APPEND_TOKEN_DATASOURCES`, where a test holds
 * the gateway's own datasource constants to it.
 */
export const INGEST_WRITTEN_DATASOURCES: ReadonlySet<string> = new Set([
	...INGEST_INSERT_DATASOURCES,
	Datasources.auditTrailEvents._name,
])

/**
 * A datasource file as `tb deploy` gets it: the gateway's datasources grant the append token,
 * which the deploy creates on first sight. Kept out of the schema manifest and its revision.
 */
export const withIngestAppendToken = (name: string, content: string): string =>
	INGEST_WRITTEN_DATASOURCES.has(name) ? `${content}\n\nTOKEN ${INGEST_APPEND_TOKEN} APPEND\n` : content
