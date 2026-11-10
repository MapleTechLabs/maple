import { isDatasourceDefinition } from "@maple-dev/effect-orm/tinybird"
import { replaceWith } from "@maple/strings"
import { Array as Arr, Record as Rec } from "effect"
import * as Datasources from "../tinybird/datasources"

/** Every Maple-managed table; `qualifyStatementForDatabase` qualifies bare `FROM`/`JOIN` references to them. */
const MANAGED_TABLES: ReadonlyArray<string> = Arr.flatMap(Rec.values(Datasources), (value: unknown) =>
	isDatasourceDefinition(value) ? [value._name] : [],
)

/**
 * Rewrite a generated CREATE TABLE / CREATE MATERIALIZED VIEW statement to
 * fully qualify every Maple-managed identifier with the supplied database
 * name. Belt-and-suspenders: ClickHouse Cloud's new analyzer (24.x+) sometimes
 * fails to resolve unqualified table identifiers in materialized view bodies
 * even when the X-ClickHouse-Database header is set, surfacing as
 * `Code: 60. UNKNOWN_TABLE: <db>.<table>` at MV creation. Qualifying every
 * identifier sidesteps the analyzer's "current database" resolution entirely.
 *
 * Used by both `ClickHouseSchemaApplyWorkflow` in the API and the standalone CLI
 * (`@maple/clickhouse-cli`).
 */
export const qualifyStatementForDatabase = (stmt: string, database: string): string => {
	if (database.length === 0) return stmt
	const ident = (name: string) => `\`${database}\`.\`${name}\``

	let result = replaceWith(
		stmt,
		/^(CREATE TABLE\s+(?:IF NOT EXISTS\s+)?)([A-Za-z_][A-Za-z0-9_]*)/,
		(_match, prefix = "", name = "") => `${prefix}${ident(name)}`,
	)

	result = replaceWith(
		result,
		/^(CREATE MATERIALIZED VIEW\s+(?:IF NOT EXISTS\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s+TO\s+)([A-Za-z_][A-Za-z0-9_]*)/,
		(_match, p1 = "", view = "", mid = "", target = "") => `${p1}${ident(view)}${mid}${ident(target)}`,
	)

	for (const table of MANAGED_TABLES) {
		result = replaceWith(
			result,
			new RegExp(`(\\bFROM|\\bJOIN)\\s+${table}\\b`, "g"),
			(_match, kw = "") => `${kw} ${ident(table)}`,
		)
	}

	return result
}
