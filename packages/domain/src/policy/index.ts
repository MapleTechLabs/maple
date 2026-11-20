import { Array as Arr, Effect, Record as Rec, Schema } from "effect"
import { type Permission, permissions } from "./permissions"
import { builtInRoles, NO_ROLE_PERMISSIONS, permissionsOfRole } from "./roles"

export {
	implicationsOf,
	type Permission,
	type PermissionGroup,
	permissionGroups,
	permissions,
	withImplied,
} from "./permissions"
export {
	type ApiKeyScopeFamily,
	apiKeyScopeFamilies,
	canGrantFamily,
	canGrantScopes,
	type ScopeAccess,
} from "./api-key-scopes"
export {
	AssignableClerkRole,
	BuiltInClerkRole,
	BuiltInRoleName,
	type BuiltInRole,
	builtInRoleOf,
	builtInRoles,
	type ClerkRoleKey,
	CUSTOM_ROLE_CLERK_KEY,
} from "./roles"
export {
	CUSTOM_ROLE_DESCRIPTION_MAX,
	CUSTOM_ROLE_NAME_MAX,
	CustomRoleDescription,
	CustomRoleId,
	CustomRoleName,
	customPermissionsFromMembershipMetadata,
	customRolesFromOrgMetadata,
	decodeCustomPermissions,
	encodePermissions,
	grantableToCustomRoles,
	MAX_CUSTOM_ROLES,
	MEMBERSHIP_ROLE_METADATA_KEY,
	MembershipRoleMetadata,
	membershipRoleFromMetadata,
	ORG_ROLES_METADATA_KEY,
	StoredCustomRole,
	StoredCustomRoles,
	type VersionedCustomRoles,
	versionedCustomRolesFromOrgMetadata,
} from "./custom-roles"

export const allPermissions: ReadonlyArray<Permission> = Rec.keys(permissions)

/** A permission name, for page models and payloads that carry grants. */
export const PermissionName = Schema.Literals(allPermissions)

/**
 * The permissions a request, tool call or page acts with. Every check reads these, never a role:
 * a role is only where they came from.
 */
export type Grants = ReadonlyArray<Permission>

/**
 * The permissions a set of Clerk role strings holds, together. `custom` is what an `org:custom`
 * membership carries (from its public metadata). No roles at all reads as a member: only Maple's own
 * agents arrive without one.
 */
export const grantsOf = (roles: ReadonlyArray<string>, custom?: ReadonlyArray<Permission>): Grants =>
	roles.length > 0
		? Arr.filter(allPermissions, (permission) =>
				Arr.some(roles, (role) => Arr.contains(permissionsOfRole(role, custom), permission)),
			)
		: Arr.filter(allPermissions, (permission) => Arr.contains(NO_ROLE_PERMISSIONS, permission))

/** Whether the grants hold `permission`. */
export const can = (grants: Grants, permission: Permission): boolean => Arr.contains(grants, permission)

/** Whether `pinned` holds something `current` does not: a credential pinned to it outlives `current`. */
export const exceeds = (pinned: Grants, current: Grants): boolean =>
	Arr.some(pinned, (permission) => !Arr.contains(current, permission))

/** Why a check failed, with the message every forbidden error carries. */
export interface Denial {
	readonly permission: Permission
	/** "You need Manage alerts to manage alerts. Admin and Engineer have it." */
	readonly message: string
}

const sentenceList = (items: ReadonlyArray<string>): string =>
	items.length <= 1
		? Arr.join(items, "")
		: `${Arr.join(items.slice(0, -1), ", ")} and ${items[items.length - 1]}`

export const denialFor = (permission: Permission): Denial => {
	const { label, action } = permissions[permission]
	const holders = Arr.map(
		Arr.reverse(
			Arr.filter(builtInRoles, (entry) => Arr.contains<Permission>(entry.permissions, permission)),
		),
		(entry) => entry.label,
	)
	const who =
		holders.length === builtInRoles.length
			? "Every built-in role has it."
			: `${sentenceList(holders)} ${holders.length === 1 ? "has" : "have"} it.`
	return { permission, message: `You need ${label} to ${action}. ${who}` }
}

/**
 * Fail with the caller's forbidden error unless the grants hold `permission`. Each route group keeps
 * its own tagged error (their tags and codes are public), built from the {@link Denial}.
 */
export const check = <E>(
	grants: Grants,
	permission: Permission,
	onDenied: (denial: Denial) => E,
): Effect.Effect<void, E> =>
	can(grants, permission) ? Effect.void : Effect.fail(onDenied(denialFor(permission)))

/** What a person is told when their role reaches no part of an endpoint at all. */
export const limitedAccessMessage = "Your role doesn't allow this. Ask an org admin for a role that does."
