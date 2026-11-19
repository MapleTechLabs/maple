import { Context } from "effect"
import type { Permission } from "../policy"

/**
 * What an endpoint asks of the caller's permissions, checked in the auth layers before the handler
 * runs. Mark the endpoint, or its whole group with `.annotate(EndpointAccess, …)`; the endpoint wins.
 *
 * - `{ requires }`: the caller must hold that permission.
 * - `"personal"`: open to every member: the caller's own state (sessions, revoking their own
 *   devices, preferences), or a POST that only reads something that is not telemetry.
 * - `"handler"`: the handler checks named permissions itself, because which one depends on the
 *   payload or the resource (a status page's visibility, a key's kind).
 *
 * Unmarked, a GET or HEAD is open to every member and anything else is refused, so an endpoint added
 * later cannot change data until someone decides what it needs. `endpoint-access.test.ts` holds every
 * non-GET endpoint marked.
 */
export type EndpointAccessRule = { readonly requires: Permission } | "personal" | "handler"

export class EndpointAccess extends Context.Reference<EndpointAccessRule | undefined>(
	"@maple/http/EndpointAccess",
	{ defaultValue: () => undefined },
) {}

export const requires = (permission: Permission): EndpointAccessRule => ({ requires: permission })

interface Annotated {
	readonly annotations: Context.Context<never>
}

export interface CalledEndpoint {
	readonly endpoint: Annotated & { readonly method: string }
	readonly group: Annotated
}

/** The rule that applies to an endpoint: its own mark, else its group's. */
export const endpointAccessOf = (called: CalledEndpoint): EndpointAccessRule | undefined =>
	Context.get(called.endpoint.annotations, EndpointAccess) ??
	Context.get(called.group.annotations, EndpointAccess)

export type EndpointAccessDecision =
	| { readonly _tag: "Allowed" }
	| { readonly _tag: "Denied"; readonly permission: Permission }
	| { readonly _tag: "Unmarked" }

/** Whether `permissions` may call the endpoint, and if not, what is missing. */
export const decideEndpointAccess = (
	permissions: ReadonlyArray<Permission>,
	called: CalledEndpoint,
): EndpointAccessDecision => {
	const rule = endpointAccessOf(called)
	if (rule === undefined) {
		const { method } = called.endpoint
		return method === "GET" || method === "HEAD" ? { _tag: "Allowed" } : { _tag: "Unmarked" }
	}
	if (rule === "personal" || rule === "handler") return { _tag: "Allowed" }
	return permissions.includes(rule.requires)
		? { _tag: "Allowed" }
		: { _tag: "Denied", permission: rule.requires }
}
