import { Array as Arr, Context, Record as Rec } from "effect"
import { type Permission, SCOPED_READ } from "../policy"
import { Authorization, RegionlessSessionAuthorization, SessionAuthorization } from "./current-tenant"
import {
	type CalledEndpoint,
	handlerPermissions,
	isUnmarked,
	requiredPermissions,
	ScopedTelemetry,
} from "./endpoint-access"
import { AuthorizationV2, isRegisteredRead } from "./v2/auth"

// What each permission opens, read off the API values the gate itself reads, so it cannot say
// something the gate does not do. It imports no API: `maple-access-catalog.ts` reads Maple's.

/** The middlewares that resolve a tenant, and so run the endpoint gate. */
export const TENANT_GATES: ReadonlyArray<unknown> = [
	Authorization,
	SessionAuthorization,
	RegionlessSessionAuthorization,
	AuthorizationV2,
]

type CatalogEndpoint = CalledEndpoint["endpoint"] & {
	readonly identifier: string
	readonly path: string
	readonly middlewares: ReadonlySet<unknown>
}
type CatalogGroup = CalledEndpoint["group"] & {
	readonly identifier: string
	readonly endpoints: Rec.ReadonlyRecord<string, CatalogEndpoint>
}
export interface CatalogApi {
	readonly identifier: string
	readonly groups: Rec.ReadonlyRecord<string, CatalogGroup>
}

/** What one gated endpoint asks of its caller. */
export interface EndpointAccessEntry {
	readonly api: string
	readonly group: string
	readonly endpoint: string
	readonly method: string
	readonly path: string
	/** Held together, these let the caller in. */
	readonly requires: ReadonlyArray<Permission>
	/** What the handler may ask on top, depending on the request or the resource. */
	readonly handler: ReadonlyArray<Permission>
	/** A role limited to namespaces may call it where it asks for Read telemetry. */
	readonly scoped: boolean
	/** A write nobody has decided a permission for: refused to everyone. */
	readonly unmarked: boolean
}

/** A gated endpoint with the group and API it belongs to. */
export interface GatedEndpoint {
	readonly api: CatalogApi
	readonly group: CatalogGroup
	readonly endpoint: CatalogEndpoint
}

const isGated = (endpoint: CatalogEndpoint): boolean =>
	Arr.some(TENANT_GATES, (gate) => endpoint.middlewares.has(gate))

/** Every endpoint of `apis` behind a tenant gate. */
export const gatedEndpointsOf = (apis: ReadonlyArray<CatalogApi>): ReadonlyArray<GatedEndpoint> =>
	Arr.flatMap(apis, (api) =>
		Arr.flatMap(Rec.values(api.groups), (group) =>
			Arr.map(Arr.filter(Rec.values(group.endpoints), isGated), (endpoint) => ({
				api,
				group,
				endpoint,
			})),
		),
	)

/** What `gated` asks of its caller. */
export const accessEntryOf = ({ api, group, endpoint }: GatedEndpoint): EndpointAccessEntry => {
	const called: CalledEndpoint = { group, endpoint }
	const registeredRead = isRegisteredRead(called, endpoint.path)
	return {
		api: api.identifier,
		group: group.identifier,
		endpoint: endpoint.identifier,
		method: endpoint.method,
		path: endpoint.path,
		requires: registeredRead ? ["telemetry:read"] : requiredPermissions(called),
		handler: handlerPermissions(called),
		scoped: Context.get(endpoint.annotations, ScopedTelemetry),
		unmarked: isUnmarked(called) && !registeredRead,
	}
}

/** Every gated endpoint of `apis` with what it asks. */
export const accessCatalogOf = (apis: ReadonlyArray<CatalogApi>): ReadonlyArray<EndpointAccessEntry> =>
	Arr.map(gatedEndpointsOf(apis), accessEntryOf)

/** How a permission bears on an endpoint: needed to get in, or asked by the handler for some requests. */
export type PermissionUse = "requires" | "handler"

/** An endpoint a permission opens, with how the permission bears on it. */
export interface OpenedEndpoint extends EndpointAccessEntry {
	readonly use: PermissionUse
}

// The scoped read stands in for Read telemetry on an endpoint marked for it, and nowhere else.
const isRequired = (entry: EndpointAccessEntry, permission: Permission): boolean =>
	Arr.contains(entry.requires, permission) ||
	(permission === SCOPED_READ && entry.scoped && Arr.contains(entry.requires, "telemetry:read"))

const useOf = (entry: EndpointAccessEntry, permission: Permission): PermissionUse | undefined =>
	isRequired(entry, permission)
		? "requires"
		: Arr.contains(entry.handler, permission)
			? "handler"
			: undefined

/** The endpoints `permission` opens: the gate asks for it, or the handler may. */
export const endpointsBehind = (
	catalog: ReadonlyArray<EndpointAccessEntry>,
	permission: Permission,
): ReadonlyArray<OpenedEndpoint> =>
	Arr.flatMap(catalog, (entry): ReadonlyArray<OpenedEndpoint> => {
		const use = useOf(entry, permission)
		return use === undefined ? [] : [{ ...entry, use }]
	})
