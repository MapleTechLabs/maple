import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"

const migrationsFolder = () => resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle")

/**
 * Applies the bundled drizzle migrations to an embedded PGlite instance.
 * Local-dev and test path only — prd is migrated by the deploy (`alchemy.run.ts`).
 */
export const runMigrations = async (pglite: PGlite): Promise<void> => {
	const db = drizzle({ client: pglite })
	await migrate(db, { migrationsFolder: migrationsFolder() })
}

let cachedMigrationsSql: string | undefined

/** drizzle-kit v1 layout: one `<timestamp>_<name>/migration.sql` folder per migration, in name order. */
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

/**
 * The bundled migration SQL, concatenated once in the migrator's own order
 * (folder name, which the kit derives from the migration timestamp). The test
 * harness keys its pre-migrated PGlite snapshot on a hash of this text, so any
 * new migration invalidates the snapshot automatically. Deployed Postgres still
 * uses the real `drizzle-kit migrate`.
 */
export const readBundledMigrationsSql = (): string => {
	if (cachedMigrationsSql !== undefined) return cachedMigrationsSql
	const sql = listBundledMigrations()
		.map(({ sqlPath }) => readFileSync(sqlPath, "utf8"))
		.join("\n")
	cachedMigrationsSql = sql
	return sql
}
