import { IntegrationsValidationError, type OrgId, type UserId } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OAuthAuthStates, type OAuthAuthStateRow } from "@maple/db/tables"
import { Clock, Effect } from "effect"
import type { DatabaseApi, DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

/**
 * The signed-in Maple user and org finishing a connect flow, taken from the request's session.
 * A state row only redeems for the identity that minted it, so an authorize URL forwarded to
 * somebody else completes nothing: their browser comes back signed in as them, or not at all.
 */
export interface OAuthFlowInitiator {
	readonly orgId: OrgId
	readonly userId: UserId
}

export interface ConsumeOAuthStateParams {
	readonly state: string
	/** `oauth_auth_states.provider`; a state minted for another flow is not found. */
	readonly provider: string
	readonly initiator: OAuthFlowInitiator
}

/**
 * The one way to redeem an `oauth_auth_states` row: claimed and deleted in one statement, and only
 * when it was minted by `initiator` for `provider`. Expired rows are spent and refused.
 */
export const makeOAuthStateConsumer = <E>(database: DatabaseApi, mapError: (error: DatabaseError) => E) => {
	const dbExecute = makeDbExecute(database, "OAuthState", mapError)
	return Effect.fn("OAuthState.consume")(function* (params: ConsumeOAuthStateParams) {
		const { state, provider, initiator } = params
		yield* Effect.annotateCurrentSpan({ orgId: initiator.orgId, "maple.oauth.provider": provider })
		const claimed = yield* dbExecute((db) =>
			db.run(
				PG.deleteFrom(OAuthAuthStates)
					.where(($) => [
						$.state.eq(state),
						$.provider.eq(provider),
						$.orgId.eq(initiator.orgId),
						$.initiatedByUserId.eq(initiator.userId),
					])
					.returning(),
			),
		)
		const row = claimed[0]
		if (row === undefined) {
			yield* Effect.annotateCurrentSpan("maple.oauth.state_outcome", "not_found")
			return yield* new IntegrationsValidationError({
				message:
					"OAuth state not recognized. Restart the connect flow from Maple, signed in as the user who started it.",
			})
		}
		if (row.expiresAt < (yield* Clock.currentTimeMillis)) {
			yield* Effect.annotateCurrentSpan("maple.oauth.state_outcome", "expired")
			return yield* new IntegrationsValidationError({
				message: "The connection request expired. Restart the connect flow from Maple.",
			})
		}
		return row satisfies OAuthAuthStateRow
	})
}
