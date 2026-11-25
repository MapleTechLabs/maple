import {
	type CalledEndpoint,
	CurrentTenant,
	decideEndpointAccess,
	type EndpointAccessDecision,
} from "@maple/domain/http"
import { requiredScopeForRoute, V2InsufficientPermissions } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Effect } from "effect"

/** The message a refused decision carries; `undefined` when the call is allowed. */
const refusalMessage = (decision: EndpointAccessDecision): string | undefined => {
	switch (decision._tag) {
		case "Allowed":
			return undefined
		case "Denied":
			return Policy.denialFor(decision.permission).message
		case "Unmarked":
			return Policy.limitedAccessMessage
	}
}

/**
 * Fails unless `permissions` reach the endpoint's `EndpointAccess` rule. It runs in the auth
 * layers, so a non-GET endpoint added later is refused until it, or its group, is marked.
 */
export const checkEndpointAccess = (
	permissions: Policy.Grants,
	called: CalledEndpoint,
): Effect.Effect<void, CurrentTenant.LimitedRoleError> => {
	const message = refusalMessage(decideEndpointAccess(permissions, called))
	return message === undefined ? Effect.void : Effect.fail(new CurrentTenant.LimitedRoleError({ message }))
}

/**
 * {@link checkEndpointAccess} for `/v2`. An unmarked POST the scope registry names as a read needs
 * `telemetry:read` rather than being refused. `routePath` is the matched route template.
 */
export const checkEndpointAccessV2 = (
	permissions: Policy.Grants,
	called: CalledEndpoint,
	routePath: string,
): Effect.Effect<void, ReturnType<typeof V2InsufficientPermissions.make>> => {
	const decision = decideEndpointAccess(permissions, called)
	const effective: EndpointAccessDecision =
		decision._tag === "Unmarked" &&
		requiredScopeForRoute(called.endpoint.method, routePath)?.access === "read"
			? Policy.can(permissions, "telemetry:read")
				? { _tag: "Allowed" }
				: { _tag: "Denied", permission: "telemetry:read" }
			: decision
	const message = refusalMessage(effective)
	return message === undefined ? Effect.void : Effect.fail(V2InsufficientPermissions.make(message))
}
