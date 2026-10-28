// Per-datasource INSERT templates for the embedded chDB, built from the
// generated `local-inserts.json` so the snake_case NDJSON the OTLP encoders
// emit maps to the PascalCase table columns with zero divergence. Direct port
// of `Templates::build` in the former `apps/ingest/src/chdb.rs`.

import insertMappings from "./schema/local-inserts.json"

/** Pinned single-tenant org id; every row is written under it. */
const LOCAL_ORG_ID = "local"

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

/**
 * Build an `INSERT … SELECT … FROM format(JSONEachRow, '<schema>', '<data>')`
 * statement for one datasource's NDJSON batch.
 */
export function buildInsertSql(datasource: string, ndjson: string): string {
	const template = templates.get(datasource)
	if (!template) throw new Error(`no insert mapping for datasource '${datasource}'`)
	return template.prefix + escapeSqlLiteral(ndjson) + template.suffix
}

/**
 * chDB parses the entire statement — inlined data literal included — against
 * its default `max_query_size` (~256KB), so a large batch in one statement
 * fails with "Code: 62 … Max query size exceeded". Budget for the escaped
 * payload per statement, leaving headroom for the template prefix/suffix.
 */
export const MAX_ESCAPED_PAYLOAD_BYTES = 200_000

export interface InsertStatement {
	readonly sql: string
	readonly rowCount: number
}

interface EscapedLine {
	readonly text: string
	readonly bytes: number
}

const templateFor = (datasource: string): InsertTemplate => {
	const template = templates.get(datasource)
	if (!template) throw new Error(`no insert mapping for datasource '${datasource}'`)
	return template
}

const escapeLines = (ndjson: string): EscapedLine[] => {
	const out: EscapedLine[] = []
	for (const line of ndjson.split("\n")) {
		if (line.length === 0) continue
		// Escaping is per-character, so escaping line-by-line and joining with
		// "\n" is identical to escaping the whole batch at once.
		const text = escapeSqlLiteral(line)
		out.push({ text, bytes: Buffer.byteLength(text, "utf8") + 1 })
	}
	return out
}

const splitLines = (template: InsertTemplate, lines: ReadonlyArray<EscapedLine>): InsertStatement[] => {
	const out: InsertStatement[] = []
	let chunk: string[] = []
	let chunkBytes = 0
	const flush = () => {
		if (chunk.length === 0) return
		out.push({ sql: template.prefix + chunk.join("\n") + template.suffix, rowCount: chunk.length })
		chunk = []
		chunkBytes = 0
	}
	for (const line of lines) {
		if (chunkBytes > 0 && chunkBytes + line.bytes > MAX_ESCAPED_PAYLOAD_BYTES) flush()
		chunk.push(line.text)
		chunkBytes += line.bytes
	}
	flush()
	return out
}

/**
 * Like {@link buildInsertSql}, but splits the NDJSON batch on line boundaries
 * into as many statements as needed so each stays under chDB's query-size
 * limit. A single line larger than the budget is emitted as its own statement
 * (never split mid-line) — that case is what `Chdb.open`'s
 * `SET max_query_size` (`MAX_QUERY_SIZE_BYTES`) exists for.
 */
export function buildInsertStatements(datasource: string, ndjson: string): InsertStatement[] {
	return splitLines(templateFor(datasource), escapeLines(ndjson))
}

/** The rows of one batch inside a {@link BatchedInsertStatement}. */
export interface InsertStatementPart<Owner> {
	readonly owner: Owner
	readonly rowCount: number
}

export interface BatchedInsertStatement<Owner> extends InsertStatement {
	readonly parts: ReadonlyArray<InsertStatementPart<Owner>>
}

/**
 * {@link buildInsertStatements} for several batches of one datasource. Each
 * statement holds whole batches, so a failed insert names exactly the batches
 * it carried. A batch over the budget gets statements of its own, split the
 * way {@link buildInsertStatements} splits it.
 */
export function buildBatchedInsertStatements<Owner>(
	datasource: string,
	batches: ReadonlyArray<{ readonly owner: Owner; readonly ndjson: string }>,
): BatchedInsertStatement<Owner>[] {
	const template = templateFor(datasource)
	const out: BatchedInsertStatement<Owner>[] = []
	let data: string[] = []
	let parts: InsertStatementPart<Owner>[] = []
	let rowCount = 0
	let bytes = 0
	const flush = () => {
		if (parts.length === 0) return
		out.push({ sql: template.prefix + data.join("\n") + template.suffix, rowCount, parts })
		data = []
		parts = []
		rowCount = 0
		bytes = 0
	}
	for (const { owner, ndjson } of batches) {
		const lines = escapeLines(ndjson)
		if (lines.length === 0) continue
		const batchBytes = lines.reduce((total, line) => total + line.bytes, 0)
		if (batchBytes > MAX_ESCAPED_PAYLOAD_BYTES) {
			flush()
			for (const statement of splitLines(template, lines))
				out.push({ ...statement, parts: [{ owner, rowCount: statement.rowCount }] })
			continue
		}
		if (bytes + batchBytes > MAX_ESCAPED_PAYLOAD_BYTES) flush()
		data.push(lines.map((line) => line.text).join("\n"))
		parts.push({ owner, rowCount: lines.length })
		rowCount += lines.length
		bytes += batchBytes
	}
	flush()
	return out
}
