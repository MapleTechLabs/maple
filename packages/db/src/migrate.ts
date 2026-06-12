import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import * as schema from "./schema"

/**
 * Applies the bundled drizzle migrations to an embedded PGlite instance.
 * Local-dev and test path only — deployed stages run `drizzle-kit migrate`
 * against the real Postgres in CI before `alchemy deploy`.
 */
export const runMigrations = async (pglite: PGlite): Promise<void> => {
	const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle")
	const db = drizzle(pglite, { schema })
	await migrate(db, { migrationsFolder })
}
