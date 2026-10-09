/**
 * Decode every stored row through the effect-orm table definitions.
 *
 * Read-only. The definitions validate on read (branded ids, literal unions,
 * jsonb schemas) where drizzle only cast, so a row an older writer stored in
 * another shape would fail once a service reads it. This finds those rows
 * first, against real data, and prints only primary keys and the decode error.
 *
 *   bun run scripts/check-row-decoding.ts [branch]   # mints an ephemeral PS credential
 *   DATABASE_URL=postgres://… bun run scripts/check-row-decoding.ts
 *
 * Exits non-zero when any row fails to decode.
 */
import * as PgClient from "@effect/sql-pg/PgClient"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Exit, Layer, Redacted, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { allTables } from "../src/tables"
import { withBranchConnection } from "./planetscale-connection"

const PAGE = 2_000
const SAMPLES = 5

type AnyTable = (typeof allTables)[number]

interface TableReport {
	readonly table: string
	/** False when the database has no such table: it is behind on migrations. */
	readonly exists: boolean
	readonly rows: number
	readonly failures: number
	readonly samples: ReadonlyArray<Failure>
}

/** The table's primary-key columns by key, for stable paging and for naming a failing row. */
const primaryKeys = (table: AnyTable): ReadonlyArray<string> => {
	const sqlNames = table.ddl.table.primaryKey?.columns ?? []
	const keys = Object.keys(table.columns)
	return sqlNames.map((sqlName) => keys.find((key) => (table.columns[key]?.sqlName ?? key) === sqlName) ?? sqlName)
}

interface Failure {
	readonly key: string
	readonly error: string
}

/** One page's rows that fail to decode, by primary key. */
const pageFailures = (
	keys: ReadonlyArray<string>,
	rows: ReadonlyArray<Record<string, unknown>>,
	decode: (rows: ReadonlyArray<Record<string, unknown>>) => Effect.Effect<unknown, unknown>,
) =>
	Effect.forEach(rows, (row) =>
		Effect.exit(decode([row])).pipe(
			Effect.map((exit): ReadonlyArray<Failure> =>
				Exit.isSuccess(exit) ? [] : [{ key: keys.map((k) => String(row[k])).join("/"), error: String(exit.cause) }],
			),
		),
	).pipe(Effect.map((failures) => failures.flat()))

const Exists = Schema.Struct({ exists: Schema.Boolean })

const checkTable = (orm: Orm.DatabaseApi, table: AnyTable) =>
	Effect.flatMap(
		orm.query(Orm.sql`SELECT to_regclass(${table.name}) IS NOT NULL AS exists`, Exists),
		([found]) =>
			found?.exists === true
				? decodeTable(orm, table)
				: Effect.succeed<TableReport>({ table: table.name, exists: false, rows: 0, failures: 0, samples: [] }),
	)

const decodeTable = (orm: Orm.DatabaseApi, table: AnyTable) => {
	const keys = primaryKeys(table)
	const walk = (
		offset: number,
		rows: number,
		failures: ReadonlyArray<Failure>,
	): Effect.Effect<{ readonly rows: number; readonly failures: ReadonlyArray<Failure> }, unknown> =>
		Effect.gen(function* () {
			const compiled = yield* PG.compile(
				PG.from(table)
					.select()
					.orderBy(($) => keys.map((key) => [$[key]!, "asc"] as const))
					.limit(PAGE)
					.offset(offset),
			)
			const raw = yield* orm.query({ sql: compiled.sql, parameters: compiled.parameters })
			const found = [...failures, ...(yield* pageFailures(keys, raw, compiled.decodeRows))]
			return raw.length < PAGE
				? { rows: rows + raw.length, failures: found }
				: yield* walk(offset + PAGE, rows + raw.length, found)
		})
	return walk(0, 0, []).pipe(
		Effect.map(
			({ rows, failures }): TableReport => ({
				table: table.name,
				exists: true,
				rows,
				failures: failures.length,
				samples: failures.slice(0, SAMPLES),
			}),
		),
	)
}

const printReport = (report: TableReport) =>
	Effect.gen(function* () {
		if (!report.exists) return yield* Effect.sync(() => console.log(`skip ${report.table}: not in this database`))
		const status = report.failures === 0 ? "ok  " : "FAIL"
		yield* Effect.sync(() => console.log(`${status} ${report.table}: ${report.rows} rows, ${report.failures} undecodable`))
		yield* Effect.forEach(report.samples, (sample) =>
			Effect.sync(() => console.log(`       ${sample.key}: ${sample.error.split("\n").slice(0, 6).join(" | ")}`)),
		)
	})

const check = (url: string) =>
	Effect.gen(function* () {
		const orm = Orm.fromSqlClient(yield* SqlClient.SqlClient, { dialect: PG.postgresDialect })
		const reports = yield* Effect.forEach(allTables, (table) => checkTable(orm, table))
		yield* Effect.forEach(reports, printReport)
		return reports.reduce((sum, report) => sum + report.failures, 0)
	}).pipe(
		Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1, prepare: false }).pipe(Layer.orDie)),
	)

const main = async (): Promise<void> => {
	const branch = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "main"
	const databaseUrl = process.env.DATABASE_URL
	const run = (url: string) =>
		Effect.runPromise(check(url)).then((failures) => {
			if (failures > 0) process.exitCode = 1
		})
	if (databaseUrl !== undefined && databaseUrl !== "") await run(databaseUrl)
	else await withBranchConnection(branch, run)
}

if (import.meta.main) await main()
