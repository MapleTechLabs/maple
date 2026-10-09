/**
 * Compare a database's schema with the one the bundled migrations build.
 *
 * Read-only. The baseline (`effect_orm_baseline`) assumes the deployed schema
 * is exactly what the migrations build: a difference here is a statement the
 * next generated migration may trip over. Columns, constraints and indexes of
 * `public`, as Postgres deparses them, against a PGlite migrated from scratch.
 *
 *   bun run scripts/check-schema-drift.ts [branch]   # mints an ephemeral PS credential
 *   DATABASE_URL=postgres://… bun run scripts/check-schema-drift.ts
 *
 * Exits non-zero when anything differs.
 */
import * as PgClient from "@effect/sql-pg/PgClient"
import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import { PGlite } from "@electric-sql/pglite"
import * as Orm from "@maple-dev/effect-orm/database"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Redacted, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { runMigrations } from "../src/migrate"
import { withBranchConnection } from "./planetscale-connection"

const Column = Schema.Struct({
	table: Schema.String,
	column: Schema.String,
	type: Schema.String,
	nullable: Schema.String,
	default: Schema.NullOr(Schema.String),
	identity: Schema.NullOr(Schema.String),
})
const Constraint = Schema.Struct({ table: Schema.String, name: Schema.String, def: Schema.String })
const Index = Schema.Struct({ table: Schema.String, name: Schema.String, def: Schema.String })

const LEDGER = new Set<string>(Object.values(Migrate.LEDGER_TABLES))

/** Tables a migrator keeps its ledger in (effect-orm's, alchemy's `__alchemy_migrations`), not schema. */
const isLedger = (table: string) => LEDGER.has(table) || table.startsWith("__")

/** Every object of `public`, one line each, keyed so the two sides line up. */
const catalog = Effect.gen(function* () {
	const orm = Orm.fromSqlClient(yield* SqlClient.SqlClient, { dialect: PG.postgresDialect })
	const columns = yield* orm.query(
		Orm.sql`SELECT table_name AS "table", column_name AS "column", udt_name AS "type", is_nullable AS nullable,
			column_default AS "default", identity_generation AS identity
			FROM information_schema.columns WHERE table_schema = 'public'`,
		Column,
	)
	// Postgres 18 lists a column's NOT NULL as a constraint; the columns already carry it.
	const constraints = yield* orm.query(
		Orm.sql`SELECT c.conrelid::regclass::text AS "table", c.conname AS name, pg_get_constraintdef(c.oid) AS def
			FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
			WHERE n.nspname = 'public' AND c.contype <> 'n'`,
		Constraint,
	)
	const indexes = yield* orm.query(
		Orm.sql`SELECT tablename AS "table", indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public'`,
		Index,
	)
	return new Map<string, string>([
		...columns
			.filter((c) => !isLedger(c.table))
			.map((c): [string, string] => [
				`column ${c.table}.${c.column}`,
				`${c.type} ${c.nullable === "YES" ? "null" : "not null"} default=${c.default} identity=${c.identity}`,
			]),
		...constraints
			.filter((c) => !isLedger(c.table))
			.map((c): [string, string] => [`constraint ${c.table}.${c.name}`, c.def]),
		...indexes
			.filter((i) => !isLedger(i.table))
			.map((i): [string, string] => [`index ${i.table}.${i.name}`, i.def]),
	])
})

const migratedCatalog = Effect.acquireRelease(
	Effect.promise(async () => {
		const pglite = new PGlite()
		await runMigrations(pglite)
		return pglite
	}),
	(pglite) => Effect.promise(() => pglite.close()),
).pipe(
	Effect.flatMap((pglite) => catalog.pipe(Effect.provide(PgliteClient.layer({ liveClient: pglite })))),
	Effect.scoped,
)

const check = (url: string) =>
	Effect.gen(function* () {
		const want = yield* migratedCatalog
		const have = yield* catalog.pipe(
			Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1, prepare: false })),
		)
		const keys = [...new Set([...want.keys(), ...have.keys()])].sort()
		const differences = keys.flatMap((key) => {
			const expected = want.get(key)
			const actual = have.get(key)
			if (expected === actual) return []
			if (expected === undefined) return [`extra    ${key}: ${actual}`]
			if (actual === undefined) return [`missing  ${key}: ${expected}`]
			return [`differs  ${key}\n           migrations: ${expected}\n           database:   ${actual}`]
		})
		yield* Effect.forEach(differences, (line) => Effect.sync(() => console.log(line)))
		yield* Effect.sync(() =>
			console.log(
				`${want.size} objects from the migrations, ${have.size} in the database, ${differences.length} differ`,
			),
		)
		return differences.length
	}).pipe(Effect.orDie)

const main = async (): Promise<void> => {
	const branch = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "main"
	const databaseUrl = process.env.DATABASE_URL
	const run = (url: string) =>
		Effect.runPromise(check(url)).then((differences) => {
			if (differences > 0) process.exitCode = 1
		})
	if (databaseUrl !== undefined && databaseUrl !== "") await run(databaseUrl)
	else await withBranchConnection(branch, run)
}

if (import.meta.main) await main()
