import { Array as Arr, Context, Option } from "effect"
import { type Permission, SCOPED_READ } from "../policy"

/**
 * What an endpoint asks of the caller's permissions, checked in the auth layers before the handler
 * runs. Mark the endpoint, or its whole group with `.annotate(EndpointAccess, …)`; a mark is one
 * rule or a list of them (`[requires("dashboards:edit"), handlerChecks("query:sql")]`). Both apply: an
 * endpoint marked `requires("dashboards:edit")` in a group marked `requires("telemetry:read")` needs
 * both, and `"personal"` or `handlerChecks(…)` on an endpoint keeps its group's `requires`. A
 * group's `handlerChecks(…)` covers only its writes that carry no mark of their own.
 *
 * - `{ requires }`: the caller must hold every permission it lists.
 * - `"personal"`: open to every member: the caller's own state (sessions, revoking their own
 *   devices, preferences), or a read of something that is not telemetry or configuration.
 * - `handlerChecks(…)`: the handler checks permissions itself, because which one depends on the payload
 *   or the resource (a status page's visibility, a key's kind). It names every permission the
 *   handler may ask; on a group, that is what its writes may ask (`handlerPermissions`).
 *
 * A GET or HEAD that no `requires` or `"personal"` covers (unmarked, or only `handlerChecks`) needs
 * `telemetry:read`: what an org has configured is read by those who can read its telemetry, and a
 * role built without it (billing only, say) sees only what is marked open to it. Anything else
 * unmarked is refused, so an endpoint added later cannot change data until someone decides what it
 * needs. `endpoint-access.test.ts` holds every non-GET endpoint marked.
 */
export type EndpointAccessRule =
	| { readonly requires: Arr.NonEmptyReadonlyArray<Permission> }
	| "personal"
	| { readonly handler: Arr.NonEmptyReadonlyArray<Permission> }

export class EndpointAccess extends Context.Reference<
	EndpointAccessRule | Arr.NonEmptyReadonlyArray<EndpointAccessRule> | undefined
>("@maple/http/EndpointAccess", { defaultValue: () => undefined }) {}

export const requires = (...permissions: Arr.NonEmptyReadonlyArray<Permission>): EndpointAccessRule => ({
	requires: permissions,
})

export const handlerChecks = (...permissions: Arr.NonEmptyReadonlyArray<Permission>): EndpointAccessRule => ({
	handler: permissions,
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

const rulesOf = (marked: Annotated): ReadonlyArray<EndpointAccessRule> => {
	const mark = Context.get(marked.annotations, EndpointAccess)
	return mark === undefined ? [] : Arr.ensure(mark)
}

/** The rules that apply to an endpoint: its own mark's, then its group's. */
export const endpointAccessRules = (called: CalledEndpoint): ReadonlyArray<EndpointAccessRule> => [
	...rulesOf(called.endpoint),
	...rulesOf(called.group),
]

/** What a read no rule covers needs. */
const READ_DEFAULT: Permission = "telemetry:read"

const isRead = (method: string): boolean => method === "GET" || method === "HEAD"

const requiresOf = (rule: EndpointAccessRule): ReadonlyArray<Permission> =>
	typeof rule === "object" && "requires" in rule ? rule.requires : []

const handlerOf = (rule: EndpointAccessRule): ReadonlyArray<Permission> =>
	typeof rule === "object" && "handler" in rule ? rule.handler : []

/** Every permission the gate asks of a caller of the endpoint: its rules', or the read default. */
export const requiredPermissions = (called: CalledEndpoint): ReadonlyArray<Permission> => {
	const rules = endpointAccessRules(called)
	const required = Arr.dedupe(Arr.flatMap(rules, requiresOf))
	return isRead(called.endpoint.method) && required.length === 0 && !Arr.contains(rules, "personal")
		? [READ_DEFAULT]
		: required
}

/**
 * The permissions the endpoint's handler may ask on top: its own mark's, else its group's for a
 * write with no mark of its own. A group's mark says nothing about its reads, which the gate
 * covers, nor about an endpoint that carries a rule itself.
 */
export const handlerPermissions = (called: CalledEndpoint): ReadonlyArray<Permission> => {
	const own = rulesOf(called.endpoint)
	return own.length > 0 || isRead(called.endpoint.method)
		? Arr.flatMap(own, handlerOf)
		: Arr.flatMap(rulesOf(called.group), handlerOf)
}

/** Whether no rule covers the endpoint and it is not a read: the gate refuses it to everyone. */
export const isUnmarked = (called: CalledEndpoint): boolean =>
	endpointAccessRules(called).length === 0 && !isRead(called.endpoint.method)

export type EndpointAccessDecision =
	| { readonly _tag: "Allowed" }
	| { readonly _tag: "Denied"; readonly permission: Permission }
	| { readonly _tag: "Unmarked" }

/** Whether `permissions` may call the endpoint, and if not, the first permission missing. */
export const decideEndpointAccess = (
	permissions: ReadonlyArray<Permission>,
	called: CalledEndpoint,
): EndpointAccessDecision => {
	if (isUnmarked(called)) return { _tag: "Unmarked" }
	const scopedAnswers =
		Context.get(called.endpoint.annotations, ScopedTelemetry) && Arr.contains(permissions, SCOPED_READ)
	const holds = (permission: Permission): boolean =>
		Arr.contains(permissions, permission) || (permission === READ_DEFAULT && scopedAnswers)
	return Option.match(
		Arr.findFirst(requiredPermissions(called), (permission) =>
			holds(permission) ? Option.none() : Option.some(permission),
		),
		{
			onNone: (): EndpointAccessDecision => ({ _tag: "Allowed" }),
			onSome: (permission): EndpointAccessDecision => ({ _tag: "Denied", permission }),
		},
	)
}
