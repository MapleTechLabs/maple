import { type CalledEndpoint, handlerPermissions, requiredPermissions } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Effect, Option } from "effect"

/** Where a request was decided: by the endpoint gate, or by a check inside the handler. */
export type AccessSite = "edge" | "handler"

/** `unmarked`: a write nobody has decided the permission for, refused to everyone. */
export type AccessOutcome = "allowed" | "denied" | "unmarked"

/** A refusal: what the caller is told, and the permission they lacked when it was about one. */
export interface AccessDenial {
	readonly reason: string
	readonly permission?: Policy.Permission
}

const accessAttributes = (outcome: AccessOutcome, site: AccessSite, permission?: Policy.Permission) => ({
	"maple.access.outcome": outcome,
	"maple.access.site": site,
	...(permission === undefined ? undefined : { "maple.access.permission": permission }),
})

/**
 * Marks the current (HTTP server) span with how the request's permissions were decided, so "who is
 * refused what, on which endpoint" is a query over `http.route`.
 */
export const annotateAccessSpan = (
	outcome: AccessOutcome,
	site: AccessSite,
	permission?: Policy.Permission,
): Effect.Effect<void> => Effect.annotateCurrentSpan(accessAttributes(outcome, site, permission))

/**
 * Runs a handler with its permission checks watched. One that refuses marks the request's span
 * (not the service span the check ran in) and is handed to `onDenied`. One the endpoint does not
 * declare (`requires` or `handler(…)`) is named in `maple.access.undeclared`, allowed or not: the
 * access catalog is missing it.
 */
export const watchHandlerAccess =
	(called: CalledEndpoint, onDenied: (denial: AccessDenial) => Effect.Effect<void>) =>
	<A, E, R>(handler: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
		const declared = [...requiredPermissions(called), ...handlerPermissions(called)]
		return Effect.flatMap(Effect.option(Effect.currentSpan), (requestSpan) =>
			Effect.provideService(handler, Policy.AccessSink, ({ permission, allowed }) => {
				if (Option.isSome(requestSpan)) {
					if (!Arr.contains(declared, permission)) {
						requestSpan.value.attribute("maple.access.undeclared", permission)
					}
					if (!allowed) {
						requestSpan.value.attribute("maple.access.outcome", "denied")
						requestSpan.value.attribute("maple.access.site", "handler")
						requestSpan.value.attribute("maple.access.permission", permission)
					}
				}
				return allowed
					? Effect.void
					: onDenied({ permission, reason: Policy.denialFor(permission).message })
			}),
		)
	}
