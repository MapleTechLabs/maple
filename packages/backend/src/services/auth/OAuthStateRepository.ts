import { type IntegrationsValidationError, OAuthStatePersistenceError } from "@maple/domain/http"
import type { OAuthAuthStateRow } from "@maple/db/tables"
import { Context, Effect, Layer } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import {
	type ConsumeOAuthStateParams,
	makeOAuthStateStore,
	type SaveOAuthStateParams,
} from "./oauth/oauth-state"

// The OAuth state store (`oauth/oauth-state.ts`) as a service, for the connect flows that are not
// OAuth connection helpers: chat workspaces and GitHub App installs.

const toPersistenceError = (error: DatabaseError) =>
	new OAuthStatePersistenceError({ message: error.message })

export interface OAuthStateRepositoryApi {
	readonly save: (params: SaveOAuthStateParams) => Effect.Effect<void, OAuthStatePersistenceError>
	/** Claim and delete the state `initiator` minted for `provider`. */
	readonly consume: (
		params: ConsumeOAuthStateParams,
	) => Effect.Effect<OAuthAuthStateRow, IntegrationsValidationError | OAuthStatePersistenceError>
}

export class OAuthStateRepository extends Context.Service<OAuthStateRepository, OAuthStateRepositoryApi>()(
	"@maple/backend/services/OAuthStateRepository",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			return makeOAuthStateStore(database, toPersistenceError)
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
