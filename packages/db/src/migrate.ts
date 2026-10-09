import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import type { PGlite } from "@electric-sql/pglite"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import { Effect, Layer } from "effect"

// The folder keeps drizzle-kit's layout, `<timestamp>_<name>/migration.sql`: the deploy
// (alchemy) applies exactly those files. Migrations from the effect-orm baseline on are
// written by `effect-orm generate` (`effect-orm.config.ts`, `emit: "sql"`).

export const migrationsFolder = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle")

/** One `<timestamp>_<name>/migration.sql` folder per migration, in name order. */
export const listBundledMigrations = (): ReadonlyArray<{
	readonly name: string
	readonly sqlPath: string
}> => {
	const dir = migrationsFolder()
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((name) => ({ name, sqlPath: join(dir, name, "migration.sql") }))
}

/** The bundled migrations, ordered by the effect-orm runner (parent snapshots, then names). */
export const bundledMigrations = Effect.suspend(() =>
	Migrate.fromRecord(
		Object.fromEntries(
			listBundledMigrations().map(({ name, sqlPath }): [string, Migrate.MigrationInput] => {
				const snapshotPath = join(dirname(sqlPath), "snapshot.json")
				return [
					name,
					{
						migration: readFileSync(sqlPath, "utf8"),
						kind: "sql",
						...(existsSync(snapshotPath)
							? { snapshot: readFileSync(snapshotPath, "utf8") }
							: undefined),
					},
				]
			}),
		),
	),
)

/** Apply every bundled migration the database's effect-orm ledger lacks. */
export const migrateBundled = Effect.flatMap(bundledMigrations, (migrations) =>
	Migrate.run({ migrations, strict: true }),
)

/**
 * Applies the bundled migrations to an embedded PGlite instance.
 * Local-dev and test path only: prd is migrated by the deploy (`alchemy.run.ts`).
 */
export const runMigrations = (pglite: PGlite): Promise<ReadonlyArray<Migrate.AppliedMigration>> =>
	Effect.runPromise(
		migrateBundled.pipe(
			// A Promise boundary for the test harness: the run owns its client.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(
				Migrate.layerSqlClient().pipe(Layer.provide(PgliteClient.layer({ liveClient: pglite }))),
			),
		),
	)

let cachedMigrationsSql: string | undefined

/**
 * The bundled migration SQL, concatenated once in folder-name order. The test
 * harness keys its pre-migrated PGlite snapshot on a hash of this text, so any
 * new migration invalidates the snapshot automatically.
 */
export const readBundledMigrationsSql = (): string => {
	if (cachedMigrationsSql !== undefined) return cachedMigrationsSql
	const sql = listBundledMigrations()
		.map(({ sqlPath }) => readFileSync(sqlPath, "utf8"))
		.join("\n")
	cachedMigrationsSql = sql
	return sql
}
