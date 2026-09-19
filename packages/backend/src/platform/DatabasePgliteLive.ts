import type { PGliteInterface } from "@electric-sql/pglite"
import type { MapleDb } from "@maple/db/client"
import { makeMaplePgliteDb } from "@maple/db/pglite"
import { Effect, type Scope } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Database, type DatabaseApi, executeWithSpan } from "./DatabaseLive"

/** `db.namespace` for the embedded Postgres used by vitest / local entrypoints. */
export const PGLITE_DB_NAMESPACE = "pglite"

/**
 * Wrap an already-migrated PGlite instance as the Database service (no
 * migration). The test harness pre-migrates via a cached snapshot and uses
 * this directly.
 *
 * One drizzle database per instance: statement capture is a fiber reference
 * provided per `execute`, so concurrent calls over the shared database never
 * cross-attribute. This layer is vitest/local-only.
 */
export const makeDatabaseFromInstance = (
	pglite: PGliteInterface,
): Effect.Effect<DatabaseApi, SqlError, Scope.Scope> =>
	Effect.map(makeMaplePgliteDb(pglite), (pgliteDb) => {
		const db: MapleDb = pgliteDb
		return Database.of({
			execute: (fn) =>
				executeWithSpan(
					() => fn(db),
					// Without a namespace these spans collapse into the per-system
					// generic node. There is no server to address — PGlite is in-process —
					// so name the engine rather than a host, which also keeps local and
					// deployed traffic on visibly distinct nodes.
					{ "db.namespace": PGLITE_DB_NAMESPACE },
				),
		} satisfies DatabaseApi)
	})
