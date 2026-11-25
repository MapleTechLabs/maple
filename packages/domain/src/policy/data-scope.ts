import { Array as Arr, Order, Schema } from "effect"
import { type Permission, withImplied } from "./permissions"

/**
 * Which telemetry a request may read. A custom role limited to `service.namespace` values holds
 * `telemetry:read_scoped` in place of `telemetry:read`, and its namespaces travel with it
 * (`docs/custom-roles.md`).
 */
export type DataScope =
	| { readonly _tag: "All" }
	| { readonly _tag: "Namespaces"; readonly namespaces: ReadonlyArray<string> }

export const ALL_DATA: DataScope = { _tag: "All" }

/** The permission a role limited to namespaces holds; set from its namespaces, never ticked. */
export const SCOPED_READ = "telemetry:read_scoped" satisfies Permission

/** How many namespaces one role may name: the list is copied onto every membership that holds it. */
export const MAX_ROLE_NAMESPACES = 20
export const ROLE_NAMESPACE_MAX = 64

// What a value written into a warehouse row filter may hold: letters, digits, spaces and
// `. _ : / @ + -`. The filter is SQL, so anything else is refused here as well as escaped there.
const SCOPE_VALUE = /^[\p{L}\p{N} ._:/@+-]+$/u

/** Whether `value` may be written into a warehouse row filter. */
export const isScopeValue = (value: string): boolean => SCOPE_VALUE.test(value)

/** One `service.namespace` value a role is limited to. */
export const RoleNamespace = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isMinLength(1),
	Schema.isMaxLength(ROLE_NAMESPACE_MAX),
	Schema.isPattern(SCOPE_VALUE),
)

export const RoleNamespaces = Schema.Array(RoleNamespace).check(Schema.isMaxLength(MAX_ROLE_NAMESPACES))

/** A namespace list as it is stored: sorted, without repeats. */
export const normalizeNamespaces = (namespaces: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(namespaces), Order.String)

// Billing reads the org's usage from the warehouse, which a limited request cannot read whole.
const READS_WHOLE_WAREHOUSE: ReadonlyArray<Permission> = ["billing:manage"]

/** Whether a role limited to namespaces may hold `permission`: only what reads no telemetry at all. */
export const holdableWhenScoped = (permission: Permission): boolean =>
	permission !== SCOPED_READ &&
	!Arr.contains(READS_WHOLE_WAREHOUSE, permission) &&
	!Arr.contains(withImplied([permission]), "telemetry:read")

/** The grants and namespaces of one caller. */
interface DataScopeHolder {
	readonly permissions: ReadonlyArray<string>
	readonly namespaces?: ReadonlyArray<string> | undefined
}

/**
 * The telemetry `holder` may read: everything with Read telemetry, its namespaces with the scoped
 * read (none when they did not travel with it). A holder of neither is not limited here.
 */
export const dataScopeOf = (holder: DataScopeHolder): DataScope => {
	if (Arr.contains(holder.permissions, "telemetry:read")) return ALL_DATA
	if (Arr.contains(holder.permissions, SCOPED_READ)) {
		return { _tag: "Namespaces", namespaces: normalizeNamespaces(holder.namespaces ?? []) }
	}
	return ALL_DATA
}

/** Whether the grants are a namespace-limited role's: the scoped permission without Read telemetry. */
export const isScoped = (permissions: ReadonlyArray<string>): boolean =>
	!Arr.contains(permissions, "telemetry:read") && Arr.contains(permissions, SCOPED_READ)

/** The stricter of two scopes: a namespace has to be in both to stay readable. */
export const narrowDataScope = (a: DataScope, b: DataScope): DataScope => {
	if (a._tag === "All") return b
	if (b._tag === "All") return a
	return { _tag: "Namespaces", namespaces: Arr.intersection(a.namespaces, b.namespaces) }
}

/** A short stable name for a scope, for cache keys: two scopes share it only when they read the same rows. */
export const dataScopeKey = (scope: DataScope): string =>
	scope._tag === "All"
		? "all"
		: // Length-prefixed, so no namespace text can make two lists read alike.
			`ns:${Arr.join(
				Arr.map(
					normalizeNamespaces(scope.namespaces),
					(namespace) => `${namespace.length}.${namespace}`,
				),
				",",
			)}`
