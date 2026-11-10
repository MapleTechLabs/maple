import { randomBytes } from "node:crypto"
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

/** How long a minted state redeems: one trip through the provider's consent screen. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000

export const newOAuthState = Effect.sync(() => randomBytes(24).toString("base64url"))

export interface SaveOAuthStateParams {
	readonly state: string
	readonly provider: string
	readonly initiator: OAuthFlowInitiator
	readonly redirectUri: string
	readonly returnTo: string | null
	/** PKCE verifier, for providers that use Authorization Code + PKCE. */
	readonly codeVerifier?: string
	/** A GitHub selection's installation ids, proven by user OAuth. */
	readonly githubInstallationIds?: ReadonlyArray<string>
}

/**
 * The store over `oauth_auth_states`: `save` writes a state for `OAUTH_STATE_TTL_MS` after purging
 * expired rows, and `consume` is the one way to redeem one: claimed and deleted in one statement,
 * only when it was minted by `initiator` for `provider`. Expired rows are spent and refused.
 */
export const makeOAuthStateStore = <E>(database: DatabaseApi, mapError: (error: DatabaseError) => E) => {
	const dbExecute = makeDbExecute(database, "OAuthState", mapError)
	const save = Effect.fn("OAuthState.save")(function* (params: SaveOAuthStateParams) {
		yield* Effect.annotateCurrentSpan({
			orgId: params.initiator.orgId,
			"maple.oauth.provider": params.provider,
		})
		const now = yield* Clock.currentTimeMillis
		yield* dbExecute((db) => db.run(PG.deleteFrom(OAuthAuthStates).where(($) => [$.expiresAt.lt(now)])))
		yield* dbExecute((db) =>
			db.run(
				PG.insertInto(OAuthAuthStates).values({
					state: params.state,
					orgId: params.initiator.orgId,
					provider: params.provider,
					initiatedByUserId: params.initiator.userId,
					redirectUri: params.redirectUri,
					returnTo: params.returnTo,
					codeVerifier: params.codeVerifier ?? null,
					githubInstallationIds:
						params.githubInstallationIds === undefined ? null : [...params.githubInstallationIds],
					createdAt: now,
					expiresAt: now + OAUTH_STATE_TTL_MS,
				}),
			),
		)
	})
	const consume = Effect.fn("OAuthState.consume")(function* (params: ConsumeOAuthStateParams) {
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
	return { save, consume }
}
