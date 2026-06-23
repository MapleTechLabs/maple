import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import * as schema from "./schema"

const migrationsFolder = () => resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle")

/**
 * Applies the bundled drizzle migrations to an embedded PGlite instance.
 * Local-dev and test path only — deployed stages run `drizzle-kit migrate`
 * against the real Postgres in CI before `alchemy deploy`.
 */
export const runMigrations = async (pglite: PGlite): Promise<void> => {
	const db = drizzle(pglite, { schema })
	await migrate(db, { migrationsFolder: migrationsFolder() })
}

let cachedMigrationsSql: string | undefined

/**
 * The bundled migration SQL (all `drizzle/*.sql` in filename order), read and
 * concatenated once. The test harness applies this via a single
 * `pglite.exec()` per instance instead of the drizzle migrator — no per-test
 * filesystem reads or `__drizzle_migrations` bookkeeping, which matters when
 * hundreds of fresh PGlite instances boot under CI contention. Fine for
 * ephemeral PGlite (always built from scratch); deployed Postgres still uses
 * the real `drizzle-kit migrate`.
 */
export const readBundledMigrationsSql = (): string => {
	if (cachedMigrationsSql !== undefined) return cachedMigrationsSql
	const dir = migrationsFolder()
	const sql = readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort()
		.map((file) => readFileSync(join(dir, file), "utf8"))
		.join("\n")
	cachedMigrationsSql = sql
	return sql
}
