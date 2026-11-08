import { Array as Arr, Effect, Schema, String as Str, type Types } from "effect"
import type { HttpClient } from "effect/http"
import {
	type CatalogEntry,
	type CatalogField,
	type ClickHouseDataSourceConfig,
	DataSourceQueryError,
	type DataSourceDriverError,
	type SourceCatalog,
} from "@maple/domain/data-sources"
import { DEFAULT_LIMITS } from "../../limits"
import type { DriverConnection } from "../../port"
import { mapClickHouseError } from "./errors"
import { catalogExamples } from "./examples"
import { openSession, readOnlySettings } from "./session"
import { enumValues, mapClickHouseType, pickTimeField } from "./types"

export const MAX_CATALOG_ENTRIES = 2_000
const MAX_CATALOG_COLUMNS = 200_000

/** A ClickHouse string literal body: backslash and quote escaped. */
export const escapeString = (value: string): string =>
	Str.replace(/'/g, "\\'")(Str.replace(/\\/g, "\\\\")(value))

const TABLE_COLUMNS = "database, name, engine, toString(total_rows) AS total_rows, comment"

const tablesSql = (database: string, limit: number, columns = TABLE_COLUMNS) =>
	`SELECT ${columns}
FROM system.tables
WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND NOT is_temporary
ORDER BY database = '${escapeString(database)}' DESC, database, name
LIMIT ${limit}`

const columnsSql = (database: string) =>
	`SELECT database, table, name, type, comment, is_in_sorting_key
FROM system.columns
WHERE (database, table) IN (${tablesSql(database, MAX_CATALOG_ENTRIES, "database, name")})
ORDER BY database, table, position
LIMIT ${MAX_CATALOG_COLUMNS}`

const TableRow = Schema.Struct({
	database: Schema.String,
	name: Schema.String,
	engine: Schema.String,
	total_rows: Schema.NullOr(Schema.String),
	comment: Schema.String,
})
const ColumnRow = Schema.Struct({
	database: Schema.String,
	table: Schema.String,
	name: Schema.String,
	type: Schema.String,
	comment: Schema.String,
	is_in_sorting_key: Schema.Number,
})
type ColumnRow = typeof ColumnRow.Type

const decodeRows = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
	const decode = Schema.decodeUnknownEffect(Schema.Array(schema))
	return (rows: unknown) =>
		decode(rows).pipe(
			Effect.mapError(
				() =>
					new DataSourceQueryError({
						message: "ClickHouse's system tables had an unexpected shape.",
					}),
			),
		)
}

export const toField = (column: ColumnRow): CatalogField => {
	const field: Types.Mutable<CatalogField> = {
		name: column.name,
		type: mapClickHouseType(column.type),
		nativeType: column.type,
	}
	if (Str.trim(column.comment) !== "") field.note = Str.trim(column.comment)
	const samples = enumValues(column.type)
	if (samples.length > 0) field.sampleValues = samples
	return field
}

export const toEntry = (table: typeof TableRow.Type, columns: ReadonlyArray<ColumnRow>): CatalogEntry => {
	const entry: Types.Mutable<CatalogEntry> = {
		name: `${table.database}.${table.name}`,
		kind: Str.endsWith("View")(table.engine) ? "view" : "table",
		fields: Arr.map(columns, toField),
	}
	const rows = table.total_rows === null ? Number.NaN : Number(table.total_rows)
	if (Number.isFinite(rows)) entry.rowEstimate = rows
	if (Str.trim(table.comment) !== "") entry.note = Str.trim(table.comment)
	const timeField = pickTimeField(
		Arr.map(columns, (column) => ({
			name: column.name,
			nativeType: column.type,
			inSortingKey: column.is_in_sorting_key === 1,
		})),
	)
	if (timeField !== undefined) entry.timeField = timeField
	return entry
}

/** Tables and columns of every non-system database the user can see, the configured one first. */
export const clickHouseCatalog = (
	connection: DriverConnection<ClickHouseDataSourceConfig>,
): Effect.Effect<SourceCatalog, DataSourceDriverError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const limits = DEFAULT_LIMITS.interactive
		const session = yield* openSession(connection)
		yield* Effect.annotateCurrentSpan({ "peer.service": session.host })
		const settings = readOnlySettings({ ...limits, maxRows: MAX_CATALOG_COLUMNS, maxBytes: 64_000_000 })
		const read = (sql: string, take: number) =>
			session
				.rows(sql, { take, maxBytes: 64_000_000, settings })
				.pipe(
					Effect.mapError((error) =>
						mapClickHouseError(error, { host: session.host, timeoutMs: limits.timeoutMs }),
					),
				)
		const [tableRows, columnRows] = yield* Effect.all(
			[
				Effect.flatMap(
					read(
						tablesSql(connection.config.database, MAX_CATALOG_ENTRIES + 1),
						MAX_CATALOG_ENTRIES + 1,
					),
					decodeRows(TableRow),
				),
				Effect.flatMap(
					read(columnsSql(connection.config.database), MAX_CATALOG_COLUMNS),
					decodeRows(ColumnRow),
				),
			],
			{ concurrency: 2 },
		)
		const byTable = Arr.groupBy(columnRows, (column) => `${column.database}.${column.table}`)
		const entries = Arr.map(Arr.take(tableRows, MAX_CATALOG_ENTRIES), (table) =>
			toEntry(table, byTable[`${table.database}.${table.name}`] ?? []),
		)
		yield* Effect.annotateCurrentSpan({ "maple.data_source.catalog_entries": entries.length })
		return {
			entries,
			examples: catalogExamples(entries),
			truncated: tableRows.length > MAX_CATALOG_ENTRIES,
		}
	}).pipe(
		Effect.withSpan("ClickHouseDriver.catalog", {
			kind: "client",
			attributes: { "maple.data_source.kind": "clickhouse", "db.system.name": "clickhouse" },
		}),
	)
