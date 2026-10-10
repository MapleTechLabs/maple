import { OAuthStatePersistenceError } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OAuthAuthStates, type OAuthAuthStateInsert, type OAuthAuthStateRow } from "@maple/db/tables"
import { Context, Effect, Layer, Option } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

// Generic, provider-agnostic repo over the shared `oauth_auth_states` table —
// the short-lived CSRF nonce store for any OAuth / App-install redirect flow.
// Callers supply `provider` in the insert row and verify it on read, so this
// repo is reusable across integrations (GitHub install, Hazel OAuth, …).

const toPersistenceError = (error: DatabaseError) =>
	new OAuthStatePersistenceError({ message: error.message })

export interface OAuthStateRepositoryApi {
	readonly purgeExpired: (now: number) => Effect.Effect<void, OAuthStatePersistenceError>
	readonly insert: (row: OAuthAuthStateInsert) => Effect.Effect<void, OAuthStatePersistenceError>
	readonly findByState: (
		state: string,
	) => Effect.Effect<Option.Option<OAuthAuthStateRow>, OAuthStatePersistenceError>
	readonly deleteByState: (state: string) => Effect.Effect<void, OAuthStatePersistenceError>
}

export class OAuthStateRepository extends Context.Service<OAuthStateRepository, OAuthStateRepositoryApi>()(
	"@maple/api/services/OAuthStateRepository",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "OAuthStateRepository", toPersistenceError)

			const purgeExpired = Effect.fn("OAuthStateRepository.purgeExpired")(function* (now: number) {
				yield* dbExecute((db) =>
					db.run(PG.deleteFrom(OAuthAuthStates).where(($) => [$.expiresAt.lt(now)])),
				)
			})

			const insert = Effect.fn("OAuthStateRepository.insert")(function* (row: OAuthAuthStateInsert) {
				yield* dbExecute((db) => db.run(PG.insertInto(OAuthAuthStates).values(row)))
			})

			const findByState = Effect.fn("OAuthStateRepository.findByState")(function* (state: string) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(OAuthAuthStates)
							.select()
							.where(($) => [$.state.eq(state)])
							.limit(1),
					),
				)
				return Option.fromNullishOr(rows[0])
			})

			const deleteByState = Effect.fn("OAuthStateRepository.deleteByState")(function* (state: string) {
				yield* dbExecute((db) =>
					db.run(PG.deleteFrom(OAuthAuthStates).where(($) => [$.state.eq(state)])),
				)
			})

			return { purgeExpired, insert, findByState, deleteByState } satisfies OAuthStateRepositoryApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
