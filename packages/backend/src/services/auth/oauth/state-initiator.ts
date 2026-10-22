import { IntegrationsValidationError } from "@maple/domain/http"
import type { OrgId, UserId } from "@maple/domain/primitives"

/**
 * The signed-in Maple user finishing a connect, install or account link. A state row is only
 * redeemed by the user and org that created it: the authorize URL is transferable, so the state
 * alone must never decide whose tenant receives the provider's grant.
 */
export interface OAuthStateInitiator {
	readonly orgId: OrgId
	readonly userId: UserId
}

export const isStateInitiator = (
	row: { readonly orgId: string; readonly initiatedByUserId: string },
	initiator: OAuthStateInitiator,
): boolean => row.orgId === initiator.orgId && row.initiatedByUserId === initiator.userId

export const stateInitiatorMismatch = () =>
	new IntegrationsValidationError({
		message:
			"This authorization was started by a different Maple user or organization. Start it again from your own account.",
	})
