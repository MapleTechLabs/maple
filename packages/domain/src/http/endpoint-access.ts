import { Array as Arr, Context, Option } from "effect"
import type { Permission } from "../policy"

/**
 * What an endpoint asks of the caller's permissions, checked in the auth layers before the handler
 * runs. Mark the endpoint, or its whole group with `.annotate(EndpointAccess, …)`. Both apply: an
 * endpoint marked `requires("dashboards:edit")` in a group marked `requires("telemetry:read")` needs
 * both, and `"personal"` or `"handler"` on an endpoint keeps its group's `requires`.
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

/** The rules that apply to an endpoint: its own mark, then its group's. */
export const endpointAccessRules = (called: CalledEndpoint): ReadonlyArray<EndpointAccessRule> =>
	Arr.filter(
		[
			Context.get(called.endpoint.annotations, EndpointAccess),
			Context.get(called.group.annotations, EndpointAccess),
		],
		(rule) => rule !== undefined,
	)

export type EndpointAccessDecision =
	| { readonly _tag: "Allowed" }
	| { readonly _tag: "Denied"; readonly permission: Permission }
	| { readonly _tag: "Unmarked" }

/** Whether `permissions` may call the endpoint, and if not, the first permission missing. */
export const decideEndpointAccess = (
	permissions: ReadonlyArray<Permission>,
	called: CalledEndpoint,
): EndpointAccessDecision => {
	const rules = endpointAccessRules(called)
	if (rules.length === 0) {
		const { method } = called.endpoint
		return method === "GET" || method === "HEAD" ? { _tag: "Allowed" } : { _tag: "Unmarked" }
	}
	return Option.match(
		Arr.findFirst(rules, (rule) =>
			typeof rule === "object" && !Arr.contains(permissions, rule.requires)
				? Option.some(rule.requires)
				: Option.none(),
		),
		{
			onNone: (): EndpointAccessDecision => ({ _tag: "Allowed" }),
			onSome: (permission): EndpointAccessDecision => ({ _tag: "Denied", permission }),
		},
	)
}
