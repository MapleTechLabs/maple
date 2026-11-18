import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { V2InsufficientPermissions } from "@maple/domain/http/v2"
import { Effect } from "effect"

/**
 * A personal action takes a personal credential: `tenant.userId` is the caller only under a signed-in
 * session, and under an API key it is the member who created the key. An unidentified credential
 * (`undefined`, a request that skipped the standard auth middlewares) is refused as well.
 */
export const requirePerson = Effect.flatMap(CurrentAuditActor, (info) =>
	info?.type === "user"
		? Effect.void
		: Effect.fail(
				V2InsufficientPermissions.make(
					"This is a personal action, so an API key cannot take it. Sign in to Maple to connect an integration.",
				),
			),
)
