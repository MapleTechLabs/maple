import type { AuditActorInfo } from "@maple/backend/services/auth/audit-actor"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { V2InsufficientPermissions } from "@maple/domain/http/v2"
import { Effect } from "effect"

/**
 * A signed-in dashboard session. An API key, a device credential, an internal token and a request
 * that skipped the standard auth middlewares (`undefined`) are not one.
 */
export const isSignedInPerson = (actor: AuditActorInfo | undefined): boolean =>
	actor?.type === "user" && actor.source === "dashboard"

/**
 * A personal action takes a personal credential: `tenant.userId` is the caller only under a
 * signed-in session, and under an API key it is the member who created the key.
 */
export const requirePerson = Effect.flatMap(CurrentAuditActor, (actor) =>
	isSignedInPerson(actor)
		? Effect.void
		: Effect.fail(
				V2InsufficientPermissions.make(
					"This action is tied to the signed-in person. Sign in to Maple and try again.",
				),
			),
)
