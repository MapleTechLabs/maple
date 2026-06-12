import { PGlite } from "@electric-sql/pglite"
import { createMaplePgliteClient } from "@maple/db/client"
import { ensureMapleDbDirectory, resolveMapleDbConfig } from "@maple/db/config"
import { runMigrations } from "@maple/db/migrate"
import { Effect, Layer } from "effect"
import { Database, type DatabaseClient, type DatabaseShape, toDatabaseError } from "./DatabaseLive"
import { Env } from "./Env"

/**
 * Embedded-Postgres Database layer for everything that is not a deployed
 * Worker: vitest, MCP evals, and local non-wrangler entrypoints. Resolves the
 * PGlite data dir from MAPLE_DB_URL (`memory://` for ephemeral instances —
 * each layer build gets a fresh database — or a directory for persistence)
 * and applies the bundled drizzle migrations on startup.
 */
const makeFromInstance = (pglite: PGlite) =>
	Effect.gen(function* () {
		yield* Effect.tryPromise({
			try: () => runMigrations(pglite),
			catch: toDatabaseError,
		}).pipe(
			Effect.tap(() => Effect.logInfo("[Database] Migrations complete")),
			Effect.orDie,
		)

		const client = createMaplePgliteClient(pglite) as unknown as DatabaseClient

		return Database.of({
			execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				Effect.tryPromise({
					try: () => fn(client),
					catch: toDatabaseError,
				}),
		} satisfies DatabaseShape)
	})

const makePgliteDatabase = Effect.gen(function* () {
	const env = yield* Env

	const dbConfig = ensureMapleDbDirectory(resolveMapleDbConfig({ MAPLE_DB_URL: env.MAPLE_DB_URL }))

	const pglite = yield* Effect.tryPromise({
		try: () => PGlite.create(dbConfig.dataDir),
		catch: toDatabaseError,
	}).pipe(Effect.orDie)

	return yield* makeFromInstance(pglite)
})

export const DatabasePgliteLive = Layer.effect(Database, makePgliteDatabase)

/**
 * Database layer over a caller-owned PGlite instance (no Env requirement).
 * Test harness path: the same instance backs both the layer and the raw-SQL
 * helpers in test-pglite.ts, since PGlite is single-connection.
 */
export const DatabasePgliteInstanceLive = (pglite: PGlite) => Layer.effect(Database, makeFromInstance(pglite))
