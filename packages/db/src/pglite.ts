import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import type { PGliteInterface } from "@electric-sql/pglite"
import { Context, Effect, Layer, type Scope } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { makeMapleDb, type MapleDb } from "./client"

// Kept out of `./client` so the Workers do not bundle the embedded-Postgres driver.

/**
 * The database over an embedded PGlite instance the caller owns: local dev and
 * vitest. The instance is not closed when the Scope ends; the harness closes it.
 */
export const makeMaplePgliteDb = (pglite: PGliteInterface): Effect.Effect<MapleDb, SqlError, Scope.Scope> =>
	Effect.gen(function* () {
		// Built into the caller's Scope, so the client lives as long as the database over it.
		const services = yield* Layer.build(PgliteClient.layer({ liveClient: pglite }))
		return makeMapleDb(Context.get(services, SqlClient.SqlClient))
	})
