import { PGlite } from "@electric-sql/pglite"
import type { Layer } from "effect"
import type { Database } from "./DatabaseLive"
import { DatabasePgliteInstanceLive } from "./DatabasePgliteLive"

/**
 * Per-test embedded Postgres. Each call creates a fresh in-memory PGlite
 * instance; `layer` runs the bundled drizzle migrations on first build. The
 * same instance backs the raw-SQL helpers below — PGlite is single-connection,
 * so unlike the old libsql harness there is no second connection to the DB.
 */
export interface TestDb {
	readonly pglite: PGlite
	readonly layer: Layer.Layer<Database>
	readonly close: () => Promise<void>
}

export const createTestDb = (track?: TestDb[]): TestDb => {
	const pglite = new PGlite()
	const db: TestDb = {
		pglite,
		layer: DatabasePgliteInstanceLive(pglite),
		close: () => pglite.close(),
	}
	track?.push(db)
	return db
}

export const cleanupTestDbs = async (dbs: TestDb[]): Promise<void> => {
	for (const db of dbs.splice(0, dbs.length)) {
		await db.close().catch(() => {})
	}
}

/** Raw SQL against the test instance. Placeholders are Postgres-style ($1, $2, …). */
export const executeSql = async (db: TestDb, sql: string, params: unknown[] = []): Promise<void> => {
	await db.pglite.query(sql, params)
}

export const queryFirstRow = async <T>(db: TestDb, sql: string, params: unknown[] = []): Promise<T | undefined> => {
	const result = await db.pglite.query<T>(sql, params)
	return result.rows[0]
}
