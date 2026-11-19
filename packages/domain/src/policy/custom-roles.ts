import { Array as Arr, Option, Order, Record as Rec, Schema } from "effect"
import { type Permission, permissions } from "./permissions"

/**
 * Custom roles live in Clerk, not in Maple's database:
 *
 * - the organization's public metadata holds the definitions under {@link ORG_ROLES_METADATA_KEY};
 * - a member on a custom role holds the Clerk role `org:custom`, and their membership's public metadata
 *   holds the role's id and a copy of its permissions under {@link MEMBERSHIP_ROLE_METADATA_KEY}.
 *
 * Permissions are stored as their stable codes (`permissions.ts`), which keeps the definitions small
 * enough for Clerk's metadata limit. Only Maple's backend writes either: public metadata is read-only
 * to the browser.
 */
export const ORG_ROLES_METADATA_KEY = "maple_roles"
export const MEMBERSHIP_ROLE_METADATA_KEY = "maple_role"

/** How many custom roles one organization may define: Clerk caps metadata size. */
export const MAX_CUSTOM_ROLES = 20

export const CustomRoleId = Schema.String.check(Schema.isPattern(/^role_[a-z0-9]{12}$/)).pipe(
	Schema.brand("@maple/CustomRoleId"),
)
export type CustomRoleId = typeof CustomRoleId.Type

export const CustomRoleName = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(40))
export const CustomRoleDescription = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(160))

const permissionByCode: ReadonlyMap<number, Permission> = new Map(
	Arr.map(Rec.toEntries(permissions), ([key, spec]) => [spec.code, key] as const),
)

/** Whether a custom role may hold `permission`. Members, roles and the organization stay with Admin. */
export const grantableToCustomRoles = (permission: Permission): boolean =>
	!("customRoles" in permissions[permission])

/** The codes a permission list is stored as, sorted and without repeats. */
export const encodePermissions = (list: ReadonlyArray<Permission>): ReadonlyArray<number> =>
	Arr.sort(Arr.dedupe(Arr.map(list, (permission): number => permissions[permission].code)), Order.Number)

/**
 * The permissions stored codes name. A code this build does not know is dropped (a newer deploy
 * wrote it), and so is anything a custom role may not hold: stored data never widens access.
 */
export const decodeCustomPermissions = (codes: ReadonlyArray<number>): ReadonlyArray<Permission> =>
	Arr.filter(
		Arr.flatMap(codes, (code) => {
			const permission = permissionByCode.get(code)
			return permission === undefined ? [] : [permission]
		}),
		grantableToCustomRoles,
	)

/** One custom role as the organization's metadata stores it. */
export const StoredCustomRole = Schema.Struct({
	id: CustomRoleId,
	name: Schema.String,
	description: Schema.String,
	permissions: Schema.Array(Schema.Int),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
})
export type StoredCustomRole = typeof StoredCustomRole.Type

export const StoredCustomRoles = Schema.Struct({
	/** Bumped by every write, so a write can tell another landed since it read. Absent reads as 0. */
	version: Schema.optionalKey(Schema.Int),
	roles: Schema.Array(StoredCustomRole),
})
export type StoredCustomRoles = typeof StoredCustomRoles.Type
export type VersionedCustomRoles = Required<StoredCustomRoles>

/** What a membership on a custom role carries. */
export const MembershipRoleMetadata = Schema.Struct({
	id: CustomRoleId,
	permissions: Schema.Array(Schema.Int),
})
export type MembershipRoleMetadata = typeof MembershipRoleMetadata.Type

// Each reads only its own key: the rest of the metadata (region, feature flags) is ignored.
const decodeStoredRoles = Schema.decodeUnknownOption(Schema.Struct({ [ORG_ROLES_METADATA_KEY]: StoredCustomRoles }))
const decodeMembershipRole = Schema.decodeUnknownOption(
	Schema.Struct({ [MEMBERSHIP_ROLE_METADATA_KEY]: MembershipRoleMetadata }),
)

/** The custom roles an organization's public metadata defines; none, at version 0, when unreadable. */
export const versionedCustomRolesFromOrgMetadata = (metadata: unknown): VersionedCustomRoles =>
	Option.match(decodeStoredRoles(metadata), {
		onNone: () => ({ version: 0, roles: [] }),
		onSome: ({ [ORG_ROLES_METADATA_KEY]: stored }) => ({ version: stored.version ?? 0, roles: stored.roles }),
	})

export const customRolesFromOrgMetadata = (metadata: unknown): ReadonlyArray<StoredCustomRole> =>
	versionedCustomRolesFromOrgMetadata(metadata).roles

/** The custom role a membership's public metadata names, if it names one that decodes. */
export const membershipRoleFromMetadata = (metadata: unknown): Option.Option<MembershipRoleMetadata> =>
	Option.map(decodeMembershipRole(metadata), (decoded) => decoded[MEMBERSHIP_ROLE_METADATA_KEY])

/** The permissions a membership's public metadata grants an `org:custom` member. */
export const customPermissionsFromMembershipMetadata = (metadata: unknown): ReadonlyArray<Permission> =>
	Option.match(membershipRoleFromMetadata(metadata), {
		onNone: () => [],
		onSome: (role) => decodeCustomPermissions(role.permissions),
	})
