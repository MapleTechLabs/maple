// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { Option, Schema, Array as Arr, String as Str } from "effect"
import { Chdb, RAW_TELEMETRY_TTL_COLUMNS } from "./chdb"
import { decodeJsonEachRow } from "./chdb-rows"
import { LOCAL_SCHEMA_MANIFEST } from "./schema-identity"
import {
	comparePhysicalSchema,
	type LocalSchemaColumn,
	type PhysicalSchema,
	type PhysicalSchemaObject,
	withRawTelemetryRetentionFloor,
} from "./schema-manifest"

/** The `system.*` shapes this inspector reads. Each is fixed by the SELECT
 * directly above its use, so a row that does not match means the query and the
 * decoder have drifted apart. */
const TableRow = Schema.Struct({
	name: Schema.String,
	engine: Schema.String,
	partition_key: Schema.String,
	sorting_key: Schema.String,
	create_table_query: Schema.String,
})

const ColumnRowSchema = Schema.Struct({
	table: Schema.String,
	name: Schema.String,
	type: Schema.String,
	position: Schema.Number,
	default_kind: Schema.String,
	default_expression: Schema.String,
	compression_codec: Schema.String,
})

const IndexRow = Schema.Struct({ table: Schema.String, name: Schema.String })

const FormattedRow = Schema.Struct({ formatted: Schema.String })

const decodeTableRows = decodeJsonEachRow(TableRow)
const decodeColumnRows = decodeJsonEachRow(ColumnRowSchema)
const decodeIndexRows = decodeJsonEachRow(IndexRow)
const decodeFormattedRows = decodeJsonEachRow(FormattedRow)

/** Inspect the physical definitions chDB reports, including the objects that
 * are easy to miss when relying on a bundled DDL fingerprint alone. */
export const inspectPhysicalSchema = (db: Pick<Chdb, "query">): PhysicalSchema => {
	const tables = decodeTableRows(
		db.query(
			"SELECT name, engine, partition_key, sorting_key, create_table_query FROM system.tables WHERE database = 'default'",
		),
	)
	const columns = decodeColumnRows(
		db.query(
			"SELECT table, name, type, position, default_kind, default_expression, compression_codec FROM system.columns WHERE database = 'default' ORDER BY table, position",
		),
	)
	let indexes: ReadonlyArray<{ readonly table: string; readonly name: string }> = []
	try {
		indexes = decodeIndexRows(
			db.query("SELECT table, name FROM system.data_skipping_indices WHERE database = 'default'"),
		)
	} catch {
		// Older supported libchdb builds may not expose this system table. The
		// CREATE TABLE definitions below still provide a strict index-name fallback.
	}
	const columnsByTable = new Map<string, LocalSchemaColumn[]>()
	for (const column of columns) {
		const list = columnsByTable.get(column.table) ?? []
		list.push({
			name: column.name,
			type: column.type,
			...(column.default_kind ? { defaultKind: column.default_kind } : undefined),
			...(column.default_expression ? { defaultExpression: column.default_expression } : undefined),
			...(!(!column.compression_codec || column.compression_codec === "NONE")
				? {
						codec: column.compression_codec,
					}
				: undefined),
		})
		columnsByTable.set(column.table, list)
	}
	const indexesByTable = new Map<string, string[]>()
	for (const index of indexes) {
		const list = indexesByTable.get(index.table) ?? []
		list.push(index.name)
		indexesByTable.set(index.table, list)
	}
	const ttlFromDefinition = (definition: string): string | undefined =>
		Option.getOrUndefined(
			Option.map(
				Option.flatMap(Str.match(/\bTTL\s+(.+?)(?=\bSETTINGS\b|$)/is)(definition), (match) =>
					Option.fromUndefinedOr(match[1]),
				),
				Str.trim,
			),
		)
	const indexesFromDefinition = (definition: string): string[] =>
		Arr.flatMap(
			Arr.fromIterable(Str.matchAll(/\bINDEX\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi)(definition)),
			(match) => (match[1] === undefined ? [] : [match[1]]),
		)
	return {
		objects: Arr.map(tables, (table): PhysicalSchemaObject => ({
			name: table.name,
			kind: Str.includes("materializedview")(Str.toLowerCase(table.engine))
				? "materialized_view"
				: Str.toLowerCase(table.engine) === "view"
					? "view"
					: "table",
			columns: columnsByTable.get(table.name) ?? [],
			engine: table.engine,
			partitionBy: table.partition_key,
			orderBy: table.sorting_key,
			ttl: ttlFromDefinition(table.create_table_query),
			indexes: Array.from(
				new Set([
					...(indexesByTable.get(table.name) ?? []),
					...indexesFromDefinition(table.create_table_query),
				]),
			),
			definition: table.create_table_query,
		})),
	}
}

/** Render a view body through ClickHouse's own parser. The bundled DDL is
 * source text while `create_table_query` is ClickHouse's rewrite of it —
 * database-qualified, backticked, and re-rendered — so the two are only
 * comparable once both have been through the same formatter. Returns
 * `undefined` when the body does not parse, which the comparison reports as a
 * mismatch rather than silently passing. */
const formatViewBody = (db: Pick<Chdb, "query">): ((sql: string) => string | undefined) => {
	const cache = new Map<string, string | undefined>()
	return (sql: string): string | undefined => {
		const cached = cache.get(sql)
		if (cached !== undefined || cache.has(sql)) return cached
		let formatted: string | undefined
		try {
			const rows = decodeFormattedRows(
				db.query(`SELECT formatQuery($maple_fmt$${sql}$maple_fmt$) AS formatted FORMAT JSONEachRow`),
			)
			// The local store is always the `default` database, and ClickHouse
			// qualifies every source table with it on the way back out. Drop the
			// qualifier so `FROM logs` and `FROM default.logs` compare equal.
			const first = rows[0]
			formatted =
				first === undefined
					? undefined
					: Str.replace(/(?:\bdefault|`default`)\./g, "")(first.formatted)
		} catch {
			formatted = undefined
		}
		cache.set(sql, formatted)
		return formatted
	}
}

export const assertPhysicalSchema = (
	db: Pick<Chdb, "query">,
	expected: typeof LOCAL_SCHEMA_MANIFEST,
): void => {
	const mismatches = comparePhysicalSchema(expected, inspectPhysicalSchema(db), formatViewBody(db))
	if (mismatches.length > 0) {
		throw new Error(
			`physical local schema does not match the bundled schema: ${Arr.join(
				Arr.map(mismatches.slice(0, 8), (mismatch) => `${mismatch.object}: ${mismatch.reason}`),
				"; ",
			)}`,
		)
	}
}

/** Verify the opened store against the bundled schema. `retentionDays` is the
 * effective raw-telemetry retention floor, which raises those tables' TTLs on
 * the physical store and so must raise the expected manifest with them. */
export const assertCurrentPhysicalSchema = (db: Pick<Chdb, "query">, retentionDays?: number): void =>
	assertPhysicalSchema(
		db,
		retentionDays === undefined
			? LOCAL_SCHEMA_MANIFEST
			: withRawTelemetryRetentionFloor(
					LOCAL_SCHEMA_MANIFEST,
					Arr.map(RAW_TELEMETRY_TTL_COLUMNS, ([table]) => table),
					retentionDays,
				),
	)
