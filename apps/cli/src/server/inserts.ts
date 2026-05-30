// Per-datasource INSERT templates for the embedded chDB, built from the
// generated `local-inserts.json` so the snake_case NDJSON the OTLP encoders
// emit maps to the PascalCase table columns with zero divergence. Direct port
// of `Templates::build` in the former `apps/ingest/src/chdb.rs`.

import insertMappings from "./schema/local-inserts.json"

/** Pinned single-tenant org id; every row is written under it. */
export const LOCAL_ORG_ID = "local"

interface DatasourceMapping {
	readonly table: string
	readonly columns: ReadonlyArray<string>
	readonly selects: ReadonlyArray<string>
	readonly inputSchema: string
}
interface InsertMappingsFile {
	readonly orgPlaceholder: string
	readonly datasources: Record<string, DatasourceMapping>
}

const mappings = insertMappings as InsertMappingsFile

/** Escape a value for a single-quoted ClickHouse SQL string literal. */
const escapeSqlLiteral = (value: string): string => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")

interface InsertTemplate {
	readonly prefix: string
	readonly suffix: string
}

const templates: Map<string, InsertTemplate> = (() => {
	const orgLiteral = `'${escapeSqlLiteral(LOCAL_ORG_ID)}'`
	const out = new Map<string, InsertTemplate>()
	for (const [name, mapping] of Object.entries(mappings.datasources)) {
		// Pin OrgId to the local tenant; every other select references a column
		// produced by the format() table function.
		const selects = mapping.selects.map((s) => (s === mappings.orgPlaceholder ? orgLiteral : s))
		const prefix =
			`INSERT INTO ${mapping.table} (${mapping.columns.join(", ")}) ` +
			`SELECT ${selects.join(", ")} FROM format(JSONEachRow, '${mapping.inputSchema}', '`
		out.set(name, { prefix, suffix: "')" })
	}
	return out
})()

export const KNOWN_DATASOURCES: ReadonlySet<string> = new Set(templates.keys())

/**
 * Build an `INSERT … SELECT … FROM format(JSONEachRow, '<schema>', '<data>')`
 * statement for one datasource's NDJSON batch.
 */
export function buildInsertSql(datasource: string, ndjson: string): string {
	const template = templates.get(datasource)
	if (!template) throw new Error(`no insert mapping for datasource '${datasource}'`)
	return template.prefix + escapeSqlLiteral(ndjson) + template.suffix
}
