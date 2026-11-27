import {
	type CalledEndpoint,
	CurrentTenant,
	decideEndpointAccess,
	type EndpointAccessDecision,
} from "@maple/domain/http"
import { requiredScopeForRoute, V2InsufficientPermissions } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Effect } from "effect"
import { type AccessDenial, annotateAccessSpan } from "./access-span"

/** The refusal a decision is, with the message its error carries; `undefined` when the call is allowed. */
const refusalOf = (
	decision: EndpointAccessDecision,
	permissions: Policy.Grants,
): AccessDenial | undefined => {
	switch (decision._tag) {
		case "Allowed":
			return undefined
		case "Denied":
			return {
				permission: decision.permission,
				message:
					decision.permission === "telemetry:read" && Policy.isScoped(permissions)
						? Policy.scopedAccessMessage
						: Policy.denialFor(decision.permission).message,
			}
		case "Unmarked":
			return { message: Policy.limitedAccessMessage }
	}
}

/** Marks the request's span with the decision, and fails with the caller's error when it refuses. */
const settle = <E>(
	decision: EndpointAccessDecision,
	permissions: Policy.Grants,
	onDenied: (denial: AccessDenial) => Effect.Effect<void>,
	toError: (message: string) => E,
): Effect.Effect<void, E> => {
	const refusal = refusalOf(decision, permissions)
	if (refusal === undefined) return annotateAccessSpan("allowed", "edge")
	return annotateAccessSpan(
		decision._tag === "Unmarked" ? "unmarked" : "denied",
		"edge",
		refusal.permission,
	).pipe(Effect.andThen(onDenied(refusal)), Effect.andThen(Effect.fail(toError(refusal.message))))
}

/**
 * Fails unless `permissions` reach the endpoint's `EndpointAccess` rule. It runs in the auth
 * layers, so a non-GET endpoint added later is refused until it, or its group, is marked. A
 * refusal is handed to `onDenied` before it fails.
 */
export const checkEndpointAccess = (
	permissions: Policy.Grants,
	called: CalledEndpoint,
	onDenied: (denial: AccessDenial) => Effect.Effect<void>,
): Effect.Effect<void, CurrentTenant.LimitedRoleError> =>
	settle(
		decideEndpointAccess(permissions, called),
		permissions,
		onDenied,
		(message) => new CurrentTenant.LimitedRoleError({ message }),
	)

/**
 * {@link checkEndpointAccess} for `/v2`. An unmarked POST the scope registry names as a read needs
 * `telemetry:read` rather than being refused. `routePath` is the matched route template.
 */
export const checkEndpointAccessV2 = (
	permissions: Policy.Grants,
	called: CalledEndpoint,
	routePath: string,
	onDenied: (denial: AccessDenial) => Effect.Effect<void>,
): Effect.Effect<void, ReturnType<typeof V2InsufficientPermissions.make>> => {
	const decision = decideEndpointAccess(permissions, called)
	const effective: EndpointAccessDecision =
		decision._tag === "Unmarked" &&
		requiredScopeForRoute(called.endpoint.method, routePath)?.access === "read"
			? Policy.can(permissions, "telemetry:read")
				? { _tag: "Allowed" }
				: { _tag: "Denied", permission: "telemetry:read" }
			: decision
	return settle(effective, permissions, onDenied, (message) => V2InsufficientPermissions.make(message))
}
