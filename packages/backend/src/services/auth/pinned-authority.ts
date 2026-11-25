import type { RoleName } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Schema } from "effect"

/**
 * What a credential pins of the person who minted it, so it never carries more than they had: their
 * roles, and for a custom role the permission codes it held then (a custom role's permissions live
 * on the membership, not in the role name). An unpinned standard key resolves as `root`.
 */
export interface PinnedAuthority {
	readonly roles: Array<RoleName>
	readonly permissions?: Array<number>
}

/** The optional permission codes a role-bearing metadata schema carries next to `roles`. */
export const PinnedPermissionCodes = Schema.optionalKey(Schema.Array(Schema.Int))

const holdsCustomRole = (roles: ReadonlyArray<string>): boolean =>
	Arr.some(roles, (role) => role === Policy.CUSTOM_ROLE_CLERK_KEY)

/** The authority to pin for a minting tenant. */
export const pinAuthority = (tenant: {
	readonly roles: ReadonlyArray<RoleName>
	readonly permissions: Policy.Grants
}): PinnedAuthority =>
	holdsCustomRole(tenant.roles)
		? { roles: [...tenant.roles], permissions: [...Policy.encodePermissions(tenant.permissions)] }
		: { roles: [...tenant.roles] }

/** The permissions a credential pinned to `roles` (and `codes`, for a custom role) acts with. */
export const pinnedGrants = (
	roles: ReadonlyArray<string>,
	codes: ReadonlyArray<number> | undefined,
): Policy.Grants => Policy.grantsOf(roles, Policy.decodeCustomPermissions(codes ?? []))
