import { Array as Arr, Option, String as Str } from "effect"

/**
 * Source datasources that materialized views read from. Used by
 * `qualifyStatementForDatabase` to rewrite bare `FROM <name>` / `JOIN <name>`
 * references in MV bodies.
 */
export const CLICKHOUSE_MV_SOURCE_TABLES: ReadonlyArray<string> = [
	"traces",
	"logs",
	"metrics_sum",
	"metrics_gauge",
	"metrics_histogram",
	"metrics_exponential_histogram",
	"error_events",
	"service_map_edges_hourly_ingest",
	"service_overview_spans",
	"service_operations_minutely",
	"trace_list_mv",
	"session_events",
	"session_replays",
]

/**
 * Rewrite a generated CREATE TABLE / CREATE MATERIALIZED VIEW statement to
 * fully qualify every Maple-managed identifier with the supplied database
 * name. Belt-and-suspenders: ClickHouse Cloud's new analyzer (24.x+) sometimes
 * fails to resolve unqualified table identifiers in materialized view bodies
 * even when the X-ClickHouse-Database header is set, surfacing as
 * `Code: 60. UNKNOWN_TABLE: <db>.<table>` at MV creation. Qualifying every
 * identifier sidesteps the analyzer's "current database" resolution entirely.
 *
 * Used by both the runtime API path (OrgClickHouseSettingsService.applySchema)
 * and the standalone CLI (`@maple/clickhouse-cli`).
 */
export const qualifyStatementForDatabase = (stmt: string, database: string): string => {
	if (database.length === 0) return stmt
	const ident = (name: string) => `\`${database}\`.\`${name}\``

	// Both header patterns are anchored, so the match is the statement's prefix.
	const rewriteHeader = (text: string, header: RegExp, render: (groups: RegExpMatchArray) => string) =>
		Option.match(Str.match(header)(text), {
			onNone: () => text,
			onSome: (groups) => `${render(groups)}${Str.slice(groups[0].length)(text)}`,
		})

	let result = rewriteHeader(
		stmt,
		/^(CREATE TABLE\s+(?:IF NOT EXISTS\s+)?)([A-Za-z_][A-Za-z0-9_]*)/,
		(groups) => `${groups[1] ?? ""}${ident(groups[2] ?? "")}`,
	)

	result = rewriteHeader(
		result,
		/^(CREATE MATERIALIZED VIEW\s+(?:IF NOT EXISTS\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s+TO\s+)([A-Za-z_][A-Za-z0-9_]*)/,
		(groups) => `${groups[1] ?? ""}${ident(groups[2] ?? "")}${groups[3] ?? ""}${ident(groups[4] ?? "")}`,
	)

	// Splitting on the captured keyword puts each `FROM`/`JOIN` at an odd index.
	for (const table of CLICKHOUSE_MV_SOURCE_TABLES) {
		result = Arr.join(
			Arr.map(Str.split(new RegExp(`(\\bFROM|\\bJOIN)\\s+${table}\\b`))(result), (part, index) =>
				index % 2 === 1 ? `${part} ${ident(table)}` : part,
			),
			"",
		)
	}

	return result
}
