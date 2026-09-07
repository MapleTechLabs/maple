import { Effect, Layer, Option } from "effect"
import { MapleDbConnection } from "./bindings"
import { Database, type DatabaseClient, DatabaseError, type DatabaseApi } from "./DatabaseLive"
import { executeOnFreshPgClient, PgConnectionScope } from "./pg-connection-scope"

// Worker TCP sockets are request-bound, so this layer holds only the connection
// string and defers the dial to whoever owns the invocation: `PgConnectionScope`
// on the request and cron paths (one socket, reused by every execute), else a
// dial per execute.
const makePgDatabase = Effect.gen(function* () {
	const connection = yield* MapleDbConnection

	if (Option.isNone(connection)) {
		// Fail per execute so an absent DB does not abort the isolate layer graph.
		return Database.of({
			execute: () =>
				Effect.fail(
					new DatabaseError({
						message: "No application database on this stage (MAPLE_DB binding absent)",
						cause: undefined,
					}),
				),
		} satisfies DatabaseApi)
	}

	const { connectionString, attributes } = connection.value
	return Database.of({
		execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			Effect.flatMap(PgConnectionScope, (scope) =>
				scope === undefined
					? executeOnFreshPgClient(connectionString, fn, attributes)
					: scope.run(fn),
			),
	} satisfies DatabaseApi)
})

export const layerPg = Layer.effect(Database, makePgDatabase)
