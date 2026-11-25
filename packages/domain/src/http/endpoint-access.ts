import { Array as Arr, Context, Option } from "effect"
import { type Permission, SCOPED_READ } from "../policy"

/**
 * What an endpoint asks of the caller's permissions, checked in the auth layers before the handler
 * runs. Mark the endpoint, or its whole group with `.annotate(EndpointAccess, …)`. Both apply: an
 * endpoint marked `requires("dashboards:edit")` in a group marked `requires("telemetry:read")` needs
 * both, and `"personal"` or `"handler"` on an endpoint keeps its group's `requires`.
 *
 * - `{ requires }`: the caller must hold every permission it lists.
 * - `"personal"`: open to every member: the caller's own state (sessions, revoking their own
 *   devices, preferences), or a read of something that is not telemetry or configuration.
 * - `"handler"`: the handler checks named permissions itself, because which one depends on the
 *   payload or the resource (a status page's visibility, a key's kind).
 *
 * A GET or HEAD that no `requires` or `"personal"` covers (unmarked, or only `"handler"`) needs
 * `telemetry:read`: what an org has configured is read by those who can read its telemetry, and a
 * role built without it (billing only, say) sees only what is marked open to it. Anything else
 * unmarked is refused, so an endpoint added later cannot change data until someone decides what it
 * needs. `endpoint-access.test.ts` holds every non-GET endpoint marked.
 */
export type EndpointAccessRule =
	| { readonly requires: Arr.NonEmptyReadonlyArray<Permission> }
	| "personal"
	| "handler"

export class EndpointAccess extends Context.Reference<EndpointAccessRule | undefined>(
	"@maple/http/EndpointAccess",
	{ defaultValue: () => undefined },
) {}

export const requires = (...permissions: Arr.NonEmptyReadonlyArray<Permission>): EndpointAccessRule => ({
	requires: permissions,
})

/**
 * Marks an endpoint a role limited to namespaces may call: where it asks for `telemetry:read`,
 * `telemetry:read_scoped` answers too. Set on the endpoint, never a group, and only when all the
 * telemetry it returns comes from the warehouse, which filters it (`docs/custom-roles.md`).
 */
export class ScopedTelemetry extends Context.Reference<boolean>("@maple/http/ScopedTelemetry", {
	defaultValue: () => false,
}) {}

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

/** What a read no rule covers needs. */
const READ_DEFAULT: Permission = "telemetry:read"

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
	const { method } = called.endpoint
	const isRead = method === "GET" || method === "HEAD"
	if (rules.length === 0 && !isRead) return { _tag: "Unmarked" }
	const required = Arr.flatMap(rules, (rule) => (typeof rule === "object" ? rule.requires : []))
	const readDefault: ReadonlyArray<Permission> =
		isRead && required.length === 0 && !Arr.contains(rules, "personal") ? [READ_DEFAULT] : []
	const scopedAnswers =
		Context.get(called.endpoint.annotations, ScopedTelemetry) && Arr.contains(permissions, SCOPED_READ)
	const holds = (permission: Permission): boolean =>
		Arr.contains(permissions, permission) || (permission === READ_DEFAULT && scopedAnswers)
	return Option.match(
		Arr.findFirst([...required, ...readDefault], (permission) =>
			holds(permission) ? Option.none() : Option.some(permission),
		),
		{
			onNone: (): EndpointAccessDecision => ({ _tag: "Allowed" }),
			onSome: (permission): EndpointAccessDecision => ({ _tag: "Denied", permission }),
		},
	)
}
