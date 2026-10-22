import { type IntegrationsValidationError, OAuthStatePersistenceError } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OAuthAuthStates, type OAuthAuthStateInsert, type OAuthAuthStateRow } from "@maple/db/tables"
import { Context, Effect, Layer } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { type ConsumeOAuthStateParams, makeOAuthStateConsumer } from "./oauth/oauth-state"

// Generic, provider-agnostic repo over the shared `oauth_auth_states` table: the
// short-lived nonce store for any OAuth / App-install redirect flow. A row is only
// read back through `consume`, which requires the identity that minted it.

const toPersistenceError = (error: DatabaseError) =>
	new OAuthStatePersistenceError({ message: error.message })

export interface OAuthStateRepositoryApi {
	readonly purgeExpired: (now: number) => Effect.Effect<void, OAuthStatePersistenceError>
	readonly insert: (row: OAuthAuthStateInsert) => Effect.Effect<void, OAuthStatePersistenceError>
	/** Claim and delete the state `initiator` minted for `provider` (see `makeOAuthStateConsumer`). */
	readonly consume: (
		params: ConsumeOAuthStateParams,
	) => Effect.Effect<OAuthAuthStateRow, IntegrationsValidationError | OAuthStatePersistenceError>
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

			const consume = makeOAuthStateConsumer(database, toPersistenceError)

			return { purgeExpired, insert, consume } satisfies OAuthStateRepositoryApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
