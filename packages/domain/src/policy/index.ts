import { Array as Arr, Effect, Record as Rec, Schema } from "effect"
import { type Permission, permissions } from "./permissions"
import { highestRole, holdersPhrase, isAtLeast, type Role } from "./roles"

export { type Permission, permissions } from "./permissions"
export {
	type AssignableRole,
	assignableRoles,
	type ClerkRoleKey,
	highestRole,
	isAtLeast,
	outranks,
	Role,
	roleOf,
} from "./roles"

export const allPermissions: ReadonlyArray<Permission> = Rec.keys(permissions)

/** A permission name, for page models and payloads that carry grants. */
export const PermissionName = Schema.Literals(allPermissions)

/** Why a check failed, with the message every forbidden error carries. */
export interface Denial {
	readonly permission: Permission
	/** The lowest role that holds the permission. */
	readonly required: Role
	/** "Only org admins and engineers can manage integrations." */
	readonly message: string
}

/** The lowest role that holds `permission`. */
export const requiredRole = (permission: Permission): Role => permissions[permission].min

/** Whether a session with these role strings holds `permission`. */
export const can = (roles: ReadonlyArray<string>, permission: Permission): boolean =>
	isAtLeast(highestRole(roles), requiredRole(permission))

export const denialFor = (permission: Permission): Denial => {
	const { min, action } = permissions[permission]
	return { permission, required: min, message: `Only ${holdersPhrase(min)} can ${action}.` }
}

/**
 * Fail with the caller's forbidden error unless the roles hold `permission`. Each route group keeps
 * its own tagged error (their tags and codes are public), built from the {@link Denial}.
 */
export const check = <E>(
	roles: ReadonlyArray<string>,
	permission: Permission,
	onDenied: (denial: Denial) => E,
): Effect.Effect<void, E> =>
	can(roles, permission) ? Effect.void : Effect.fail(onDenied(denialFor(permission)))

/** Every permission the roles hold, for a page model to keep instead of role flags. */
export const grantsOf = (roles: ReadonlyArray<string>): ReadonlyArray<Permission> =>
	Arr.filter(allPermissions, (permission) => can(roles, permission))

/** Whether a grant list (from {@link grantsOf}) holds `permission`. */
export const has = (grants: ReadonlyArray<Permission>, permission: Permission): boolean =>
	Arr.contains(grants, permission)
