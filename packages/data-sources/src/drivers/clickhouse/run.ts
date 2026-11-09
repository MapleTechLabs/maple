import { Array as Arr, Effect, Option, Record as Rec, Schema, String as Str } from "effect"
import type { Row } from "@maple-dev/effect-clickhouse-http"
import {
	type ClickHouseDataSourceConfig,
	type DataSourceColumn,
	type DataSourceTable,
	DataSourceValidationError,
	type ExternalQuery,
	type SourceCatalog,
} from "@maple/domain/data-sources"
import { maskLiteralsAndComments } from "@maple/domain/raw-sql"
import type { DriverConnection, PreparedQuery, QueryRequest } from "../../port"
import { mapClickHouseError } from "./errors"
import { runtimeHint, validationHints } from "./hints"
import { expandMacros } from "./macros"
import { openSession, readOnlySettings } from "./session"
import { clickHouseSqlIssue, stripTerminal } from "./sql"
import { mapClickHouseType, wideNumber } from "./types"

interface TypedColumn extends DataSourceColumn {
	readonly nativeType: string | null
}

const Described = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }))
const decodeDescribed = Schema.decodeUnknownOption(Described)

const inferType = (value: unknown): DataSourceColumn["type"] =>
	typeof value === "number"
		? "number"
		: typeof value === "boolean"
			? "boolean"
			: typeof value === "string"
				? "string"
				: typeof value === "object" && value !== null
					? "json"
					: "unknown"

/** Columns in SELECT order: from `DESCRIBE` when it answered, else from the first row's keys. */
export const resultColumns = (
	described: Option.Option<ReadonlyArray<Row>>,
	rows: ReadonlyArray<Row>,
): ReadonlyArray<TypedColumn> =>
	Option.match(Option.flatMap(described, decodeDescribed), {
		onSome: (columns) =>
			Arr.map(columns, (column) => ({
				name: column.name,
				type: mapClickHouseType(column.type),
				nativeType: column.type,
			})),
		onNone: () =>
			Option.match(Arr.head(rows), {
				onNone: () => [],
				onSome: (first) =>
					Arr.map(Rec.toEntries(first), ([name, value]) => ({
						name,
						type: inferType(value),
						nativeType: null,
					})),
			}),
	})

/** PII redaction for SQL: result columns named like a catalog field marked `pii` are dropped. */
export const piiFieldNames = (catalog: SourceCatalog): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(catalog.entries, (entry) =>
			Arr.map(
				Arr.filter(entry.fields, (field) => field.pii === true),
				(field) => field.name,
			),
		),
	)

export const toDataSourceTable = (
	columns: ReadonlyArray<TypedColumn>,
	rows: ReadonlyArray<Row>,
	maxRows: number,
	hidden: ReadonlySet<string>,
): DataSourceTable => {
	const kept = Arr.filter(columns, (column) => !hidden.has(column.name))
	return {
		columns: Arr.map(kept, (column) => ({ name: column.name, type: column.type })),
		rows: Arr.map(Arr.take(rows, maxRows), (row) =>
			Rec.fromEntries(
				Arr.map(kept, (column) => [column.name, cell(column, row[column.name])] as const),
			),
		),
		truncated: rows.length > maxRows,
	}
}

/** Strings back to their column's type: wide numbers always, everything under the strings format. */
const cell = (column: TypedColumn, value: unknown) => {
	if (column.nativeType === null || typeof value !== "string") return value
	if (column.type === "boolean" && (value === "true" || value === "false")) return value === "true"
	return wideNumber(column.nativeType, value)
}

const refuse = (message: string) => new DataSourceValidationError({ field: "sql", message })

/** `SELECT *`, `t.*` or `COLUMNS(...)`: every column, personal data included. `count(*)` is fine. */
const ALL_COLUMNS_RE = /(?:\bSELECT\s+(?:DISTINCT\s+)?|,\s*)(?:[\w`"]+\.)?\*|\bCOLUMNS\s*\(/i

/**
 * Refuses SQL that could return a field marked personal data. Names are matched in the raw text,
 * quotes and comments included, so an alias, an aggregate or a filter cannot hide them.
 */
export const piiIssue = (sql: string, pii: ReadonlySet<string>): string | null => {
	if (pii.size === 0) return null
	const named = Arr.findFirst(Arr.fromIterable(pii), (name) =>
		new RegExp(`(?<![\\w$])${Str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")(name)}(?![\\w$])`, "i").test(sql),
	)
	if (Option.isSome(named)) {
		return `\`${named.value}\` is marked as personal data, which agents may not read on this source (in results, filters or groupings). Leave it out, or ask an admin to allow personal data for agents.`
	}
	return ALL_COLUMNS_RE.test(maskLiteralsAndComments(sql))
		? "This source has fields marked as personal data, so name the columns you need instead of selecting every column."
		: null
}

export const prepareClickHouse = (
	connection: DriverConnection<ClickHouseDataSourceConfig>,
	query: ExternalQuery,
	request: QueryRequest,
	catalog: SourceCatalog,
): Effect.Effect<PreparedQuery, DataSourceValidationError> =>
	Effect.gen(function* () {
		if (query._tag !== "sql")
			return yield* refuse("This source is ClickHouse: send SQL, not a resource query.")
		const issue = clickHouseSqlIssue(query.sql)
		if (issue !== null) return yield* refuse(issue + validationHints(query.sql))
		if (
			request.workload === "alert" &&
			!Str.includes("$__timeFilter(")(maskLiteralsAndComments(query.sql))
		) {
			return yield* refuse("Alert queries must bound their reads with $__timeFilter(col).")
		}
		const pii = request.redactPii ? piiFieldNames(catalog) : new Set<string>()
		const personal = piiIssue(query.sql, pii)
		if (personal !== null) return yield* refuse(personal)
		const { granularitySeconds, startMs, endMs } = request.window
		if (
			!Number.isFinite(granularitySeconds) ||
			granularitySeconds <= 0 ||
			!Number.isFinite(startMs) ||
			!(endMs > startMs)
		) {
			return yield* refuse(
				"The time window must have a start before its end and a positive bucket size.",
			)
		}
		const sql = expandMacros(stripTerminal(query.sql), request.window)
		const { limits } = request
		const run = Effect.gen(function* () {
			const session = yield* openSession(connection, limits.timeoutMs)
			const settings = readOnlySettings(limits)
			const hint = (error: { readonly code?: string; readonly message: string }) =>
				runtimeHint(query.sql, error.code, error.message, catalog)
			const [rows, described] = yield* Effect.all(
				[
					session.rows(sql, { take: limits.maxRows + 1, maxBytes: limits.maxBytes, settings }),
					// Only types the columns; a failure keeps the rows, and says so on the span.
					session
						.rows(`DESCRIBE TABLE (\n${sql}\n)`, { take: 10_000, maxBytes: 4_000_000, settings })
						.pipe(
							Effect.asSome,
							Effect.catch((error) =>
								Effect.as(
									Effect.annotateCurrentSpan({
										"maple.data_source.describe_error": error._tag,
									}),
									Option.none(),
								),
							),
						),
				],
				{ concurrency: 2 },
			).pipe(
				Effect.mapError((error) =>
					mapClickHouseError(error, { host: session.host, timeoutMs: limits.timeoutMs, hint }),
				),
			)
			const table = toDataSourceTable(resultColumns(described, rows), rows, limits.maxRows, pii)
			yield* Effect.annotateCurrentSpan({
				"peer.service": session.host,
				"maple.data_source.rows": table.rows.length,
				"maple.data_source.truncated": table.truncated,
			})
			return table
		}).pipe(
			Effect.withSpan("ClickHouseDriver.run", {
				kind: "client",
				attributes: {
					"maple.data_source.kind": "clickhouse",
					"db.system.name": "clickhouse",
					"maple.data_source.workload": request.workload,
				},
			}),
		)
		return { summary: { _tag: "sql", sql }, run: () => run }
	})
