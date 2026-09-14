import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import type { PGliteInterface } from "@electric-sql/pglite"
import * as PgliteDrizzle from "drizzle-orm/effect-pglite"
import { Effect, Layer, type Scope } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { mapleDrizzleServices } from "./client"

// Kept out of `./client` so the Workers do not bundle the embedded-Postgres driver.

/** Drizzle over an embedded PGlite instance — local dev and vitest. */
export type MaplePgliteDb = PgliteDrizzle.EffectPgDatabase

/**
 * Build the Effect drizzle database over an instance the caller owns. The
 * instance is not closed when the Scope ends; the test harness closes it.
 */
export const makeMaplePgliteDb = (
	pglite: PGliteInterface,
): Effect.Effect<MaplePgliteDb, SqlError, Scope.Scope> =>
	Effect.gen(function* () {
		// Built into the caller's Scope, as `makeMapleEffectDb` does, so the client
		// lives as long as the database that was built over it.
		const client = yield* Layer.build(PgliteClient.layer({ liveClient: pglite }))
		return yield* PgliteDrizzle.make().pipe(
			Effect.provide(mapleDrizzleServices),
			Effect.provideContext(client),
		)
	})
