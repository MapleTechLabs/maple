import * as Policy from "@maple/domain/policy"
import { Effect, Option } from "effect"

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
 * Runs a handler with its permission checks watched: one that refuses marks the request's span
 * (not the service span the check ran in) and is handed to `onDenied`.
 */
export const watchHandlerAccess =
	(onDenied: (denial: AccessDenial) => Effect.Effect<void>) =>
	<A, E, R>(handler: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.flatMap(Effect.option(Effect.currentSpan), (requestSpan) =>
			Effect.provideService(handler, Policy.AccessSink, ({ permission, allowed }) => {
				if (allowed) return Effect.void
				if (Option.isSome(requestSpan)) {
					requestSpan.value.attribute("maple.access.outcome", "denied")
					requestSpan.value.attribute("maple.access.site", "handler")
					requestSpan.value.attribute("maple.access.permission", permission)
				}
				return onDenied({ permission, reason: Policy.denialFor(permission).message })
			}),
		)
