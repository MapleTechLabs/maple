/**
 * Apply the bundled migrations to a local Postgres through effect-orm.
 *
 *   DATABASE_URL=postgres://… bun run scripts/migrate.ts
 *
 * A database drizzle-kit migrated has no effect-orm ledger yet: the first run
 * records every migration drizzle-kit's ledger names as applied, then runs the
 * rest. Local only: prd is migrated by the deploy (`alchemy.run.ts`).
 */
import * as PgClient from "@effect/sql-pg/PgClient"
import * as Orm from "@maple-dev/effect-orm/database"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Layer, Redacted, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { bundledMigrations, migrateBundled } from "../src/migrate"

const LOCAL_URL = "postgres://maple:maple@localhost:5499/maple"

const Found = Schema.Struct({ drizzle: Schema.Boolean, effectOrm: Schema.Boolean })
const Newest = Schema.Struct({ name: Schema.NullOr(Schema.String) })

/** The newest migration drizzle-kit recorded, when the database has its ledger and no effect-orm one. */
const drizzleHead = Effect.gen(function* () {
	const orm = Orm.fromSqlClient(yield* SqlClient.SqlClient, { dialect: PG.postgresDialect })
	const [found] = yield* orm.query(
		Orm.sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS drizzle,
			to_regclass(${Migrate.LEDGER_TABLES.migrations}) IS NOT NULL AS "effectOrm"`,
		Found,
	)
	if (found === undefined || !found.drizzle || found.effectOrm) return undefined
	const [newest] = yield* orm.query(
		Orm.sql`SELECT name FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1`,
		Newest,
	)
	return newest?.name ?? undefined
})

const program = Effect.gen(function* () {
	const head = yield* drizzleHead
	if (head !== undefined) {
		const recorded = yield* Migrate.baseline({ migrations: yield* bundledMigrations, upTo: head })
		yield* Effect.log(
			`Adopted drizzle-kit's ledger: ${recorded.length} migrations up to ${head} recorded as applied`,
		)
	}
	const applied = yield* migrateBundled
	yield* Effect.log(
		applied.length === 0
			? "Up to date"
			: `Applied ${applied.map((migration) => migration.name).join(", ")}`,
	)
})

const url = process.env.DATABASE_URL ?? LOCAL_URL
const Driver = Migrate.layerSqlClient().pipe(
	Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })),
)

if (import.meta.main) await Effect.runPromise(program.pipe(Effect.provide(Driver), Effect.orDie))
