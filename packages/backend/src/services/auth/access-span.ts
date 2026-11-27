import { type CalledEndpoint, handlerPermissions, requiredPermissions } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Effect, Option, Record as Rec, Ref } from "effect"
import type { Span } from "effect/Tracer"

/** Where a request was decided: the endpoint gate, a check inside the handler, or an MCP tool's permission. */
export type AccessSite = "edge" | "handler" | "tool"

/** `unmarked`: a write nobody has decided the permission for, refused to everyone. */
export type AccessOutcome = "allowed" | "denied" | "unmarked"

/** A refusal: what the caller is told, and the permission they lacked when it was about one. */
export interface AccessDenial {
	readonly message: string
	readonly permission?: Policy.Permission
}

const accessAttributes = (outcome: AccessOutcome, site: AccessSite, permission?: Policy.Permission) => ({
	"maple.access.outcome": outcome,
	"maple.access.site": site,
	...(permission === undefined ? undefined : { "maple.access.permission": permission }),
})

/**
 * Marks the current span with how the request's permissions were decided. At the gate that is the
 * HTTP server span, so "who is refused what, on which endpoint" is a query over `http.route`.
 */
export const annotateAccessSpan = (
	outcome: AccessOutcome,
	site: AccessSite,
	permission?: Policy.Permission,
): Effect.Effect<void> => Effect.annotateCurrentSpan(accessAttributes(outcome, site, permission))

const markSpan = (span: Span, attributes: Rec.ReadonlyRecord<string, string>): Effect.Effect<void> =>
	Effect.sync(() => Arr.forEach(Rec.toEntries(attributes), ([key, value]) => span.attribute(key, value)))

/**
 * Runs a handler with its permission checks watched. One that refuses marks the request's span
 * (not the service span the check ran in) and is handed to `onDenied`; every one the endpoint
 * does not declare is listed in `maple.access.undeclared`, allowed or not.
 */
export const watchHandlerAccess =
	(called: CalledEndpoint, onDenied: (denial: AccessDenial) => Effect.Effect<void>) =>
	<A, E, R>(handler: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
		const declared = [...requiredPermissions(called), ...handlerPermissions(called)]
		return Effect.gen(function* () {
			const requestSpan = yield* Effect.option(Effect.currentSpan)
			const undeclared = yield* Ref.make<ReadonlyArray<Policy.Permission>>([])
			const mark = (attributes: Rec.ReadonlyRecord<string, string>): Effect.Effect<void> =>
				Option.match(requestSpan, {
					onNone: () => Effect.void,
					onSome: (span) => markSpan(span, attributes),
				})
			return yield* Effect.provideService(handler, Policy.AccessSink, ({ permission, allowed }) =>
				Effect.gen(function* () {
					if (!Arr.contains(declared, permission)) {
						const seen = yield* Ref.updateAndGet(undeclared, (list) =>
							Arr.dedupe([...list, permission]),
						)
						yield* mark({ "maple.access.undeclared": Arr.join(seen, ",") })
					}
					if (allowed) return
					yield* mark(accessAttributes("denied", "handler", permission))
					yield* onDenied(Policy.denialFor(permission))
				}),
			)
		})
	}
