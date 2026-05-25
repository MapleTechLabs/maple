import { createMapleD1Client } from "@maple/db/client"
import { migrateAlertQuerySignalTypes, reshapeDashboardWidgets } from "@maple/db/migrate"
import { Effect, Layer } from "effect"
import { Database, type DatabaseClient, type DatabaseShape, toDatabaseError } from "./DatabaseLive"
import { MapleDb } from "./MapleD1"

const makeD1Database = Effect.gen(function* () {
	// `MapleDb` resolves the validated raw `MAPLE_DB` D1 binding. A missing or
	// malformed binding fails `MapleDb.layer` with `BindingNotFound/Validation`,
	// converted to a defect via `Layer.orDie` below — preserving the original
	// fail-fast (surfaced as a boot error in `wrangler tail`).
	const binding = yield* MapleDb

	const client = createMapleD1Client(binding) as unknown as DatabaseClient

	// The D1 worker never calls runMigrations; the data migration is guarded by
	// the _maple_data_migrations table, so every later boot is a single SELECT.
	yield* Effect.tryPromise({
		try: () => reshapeDashboardWidgets(client),
		catch: toDatabaseError,
	}).pipe(
		Effect.tap(() => Effect.logInfo("[Database] Dashboard data migration complete")),
		Effect.orDie,
	)

	yield* Effect.tryPromise({
		try: () => migrateAlertQuerySignalTypes(client),
		catch: toDatabaseError,
	}).pipe(
		Effect.tap(() => Effect.logInfo("[Database] Alert query signal-type migration complete")),
		Effect.orDie,
	)

	return Database.of({
		client,
		execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			Effect.tryPromise({
				try: () => fn(client),
				catch: toDatabaseError,
			}),
	} satisfies DatabaseShape)
})

// Self-provides the D1 binding layer (orDie'd) so the only remaining
// requirement is `WorkerEnvironment`, which `Worker.make` supplies from `env`.
export const DatabaseD1Live = Layer.effect(Database, makeD1Database).pipe(
	Layer.provide(Layer.orDie(MapleDb.layer)),
)
