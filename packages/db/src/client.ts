import type { PGlite } from "@electric-sql/pglite"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

export interface MaplePgConnection {
	readonly db: MaplePgClient
	/** Closes the underlying postgres.js connection pool. */
	readonly end: () => Promise<void>
}

/**
 * Drizzle over postgres.js, for real Postgres (PlanetScale via Hyperdrive in
 * Workers, docker-compose Postgres in `wrangler dev`, direct URLs in scripts).
 *
 * Workers note: TCP sockets are tied to the request that opened them, so
 * deployed Workers create a connection per `execute` (`maxConnections: 1`)
 * and `end()` it when done — Hyperdrive owns the warm origin pool, making the
 * per-request handshake cheap. `fetch_types: false` skips the pg_types
 * round-trip (we only use built-in types).
 */
export const createMaplePgClient = (
	connectionString: string,
	options?: { readonly maxConnections?: number },
): MaplePgConnection => {
	const sql = postgres(connectionString, {
		max: options?.maxConnections ?? 5,
		fetch_types: false,
	})
	return {
		db: drizzlePostgres(sql, { schema }),
		end: () => sql.end(),
	}
}

export type MaplePgClient = ReturnType<typeof drizzlePostgres<typeof schema>>

/** Drizzle over an embedded PGlite instance — local dev and vitest. */
export const createMaplePgliteClient = (pglite: PGlite) => drizzlePglite(pglite, { schema })

export type MaplePgliteClient = ReturnType<typeof createMaplePgliteClient>

/**
 * Canonical client type the app codes against. PostgresJsDatabase and
 * PgliteDatabase share the PgDatabase core; the PGlite layer casts into this
 * (same precedent as the old D1 layer).
 */
export type MapleDatabaseClient = MaplePgClient

export type MapleDatabaseTransaction = Parameters<Parameters<MaplePgClient["transaction"]>[0]>[0]
