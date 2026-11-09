// Prints the SQL that builds one world server: `bun seed-sql.ts main|staging`.
// Run by `apps/ai/scripts/data-source-world-ch.sh`; rerunning drops and reseeds every table.
import { Array as Arr, String as Str } from "effect"
import { type ClickHouseWorldSource, clickHouseSources, type WorldServer } from "./sources"
import type { WorldTable } from "./tables"

const quote = (text: string) => `'${Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(text))}'`

const createTable = (table: WorldTable): ReadonlyArray<string> => {
	const name = `${table.database}.${table.name}`
	const columns = Arr.join(
		Arr.map(table.columns, (column) =>
			column.comment === undefined
				? `${column.name} ${column.type}`
				: `${column.name} ${column.type} COMMENT ${quote(column.comment)}`,
		),
		", ",
	)
	const comment = table.comment === undefined ? "" : ` COMMENT ${quote(table.comment)}`
	return [
		`DROP TABLE IF EXISTS ${name}`,
		`CREATE TABLE ${name} (${columns}) ENGINE = MergeTree ORDER BY (${Arr.join(table.orderBy, ", ")})${comment}`,
		...(table.insert === undefined ? [] : [`INSERT INTO ${name} ${table.insert}`]),
	]
}

export const seedStatements = (server: WorldServer): ReadonlyArray<string> =>
	Arr.flatMap(
		Arr.filter(clickHouseSources, (source) => source.server === server),
		(source: ClickHouseWorldSource) => [
			`CREATE DATABASE IF NOT EXISTS ${source.database}`,
			...Arr.flatMap(source.tables, createTable),
			`CREATE USER IF NOT EXISTS ${source.user} IDENTIFIED BY ${quote(source.password)}`,
			`GRANT SELECT ON ${source.database}.* TO ${source.user}`,
		],
	)

const server = process.argv[2]
if (server === "main" || server === "staging") {
	process.stdout.write(`${Arr.join(seedStatements(server), ";\n")};\n`)
}
