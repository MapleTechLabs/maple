import {
	CreateRoleRequest,
	DeleteRoleRequest,
	type RoleKey,
	type RoleListResponse,
	type RoleMemberResponse,
	type RoleRef,
	SetMemberRoleRequest,
	UpdateRoleRequest,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import type { UserId } from "@maple/primitives"
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { AppRoute, hrefOf } from "../../../route"

// The roles the Roles tab, the role editor and the Members page share: one entry per role, built-in
// roles first, and the reads and writes behind them.

/** One role as the pages list it. */
export type RoleEntry = Readonly<{
	/** The editor's URL segment and the pickers' value: a built-in role's name (`engineer`) or a custom role's id. */
	key: string
	ref: RoleRef
	name: string
	description: string
	permissions: ReadonlyArray<Policy.Permission>
	memberCount: number
	/** The first few holders, for the list's avatars; `memberCount` counts them all. */
	holders: ReadonlyArray<RoleMemberResponse>
	isBuiltIn: boolean
}>

/** Every permission there is: a role's count reads "N of" this. */
export const PERMISSION_TOTAL = Policy.allPermissions.length

export const isSensitive = (permission: Policy.Permission): boolean =>
	"sensitive" in Policy.permissions[permission]

/** `/settings/roles`. */
export const rolesHref = (): string => hrefOf(AppRoute.Settings({ search: { tab: "roles" } }))

/** `/settings/roles/:roleId`: a role's editor (read-only for a built-in role). */
export const roleHref = (key: string): string => hrefOf(AppRoute.RoleEditor({ roleId: key }))

/** `/settings/members`. */
export const membersHref = (): string => hrefOf(AppRoute.Settings({ search: { tab: "members" } }))

const builtInEntry = (
	role: Policy.BuiltInRole,
	memberCount: number,
	holders: ReadonlyArray<RoleMemberResponse>,
): RoleEntry => ({
	key: role.role,
	ref: { _tag: "BuiltIn", clerkKey: role.clerkKey },
	name: role.label,
	description: role.summary,
	permissions: role.permissions,
	memberCount,
	holders,
	isBuiltIn: true,
})

/** The four built-in roles before the list answers (no member counts yet). */
export const builtInEntries: ReadonlyArray<RoleEntry> = Arr.map(Policy.builtInRoles, (role) =>
	builtInEntry(role, 0, []),
)

/** The list's roles: the four built-in ones, then the organization's own (the API sends them by name). */
export const roleEntries = (list: RoleListResponse): ReadonlyArray<RoleEntry> => [
	...Arr.map(Policy.builtInRoles, (role) =>
		builtInEntry(
			role,
			Option.match(
				Arr.findFirst(list.builtIn, (entry) => entry.clerkKey === role.clerkKey),
				{ onNone: () => 0, onSome: (entry) => entry.memberCount },
			),
			list.holders[role.role] ?? [],
		),
	),
	...Arr.map(list.custom, (role): RoleEntry => ({
		key: role.id,
		ref: { _tag: "Custom", id: role.id },
		name: role.name,
		description: role.description,
		permissions: role.permissions,
		memberCount: role.memberCount,
		holders: list.holders[role.id] ?? [],
		isBuiltIn: false,
	})),
]

export const findRole = (entries: ReadonlyArray<RoleEntry>, key: string): Option.Option<RoleEntry> =>
	Arr.findFirst(entries, (entry) => entry.key === key)

/** A built-in role's key from its Clerk key (`org:engineer` is `engineer`). */
export const builtInKeyOf = (clerkKey: string): Option.Option<string> =>
	Option.map(Policy.builtInRoleOf(clerkKey), (role) => role.role)

/** What a custom role may hold: members, roles and the organization stay with Admin. */
export const grantablePermissions = (permissions: ReadonlyArray<Policy.Permission>) =>
	Arr.filter(permissions, Policy.grantableToCustomRoles)

/** "All 49" or "16 of 49". */
export const permissionCountLabel = (count: number): string =>
	count === PERMISSION_TOTAL ? `All ${PERMISSION_TOTAL}` : `${count} of ${PERMISSION_TOTAL}`

/** "1 member", "3 members". */
export const memberCountLabel = (count: number): string => `${count} ${count === 1 ? "member" : "members"}`

// Reads and writes, through the internal API.

export const listRoles = Effect.flatMap(MapleInternalApiClient, (client) => client.roles.list())

/** Who holds a role, built-in or custom. */
export const listRoleMembers = (roleId: RoleKey) =>
	Effect.flatMap(MapleInternalApiClient, (client) => client.roles.members({ params: { roleId } }))

/** A role's name, description and permissions as typed: checked only when sent. */
export const RoleDraft = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	permissions: Schema.Array(Policy.PermissionName),
})
export type RoleDraft = typeof RoleDraft.Type

const isRoleName = Schema.is(Policy.CustomRoleName)
const isRoleDescription = Schema.is(Policy.CustomRoleDescription)

/** Whether a typed name makes a role name once trimmed: present and within the limit. */
export const isValidRoleName = (name: string): boolean => isRoleName(Str.trim(name))

/** Whether a typed description fits once trimmed. */
export const isValidRoleDescription = (description: string): boolean =>
	isRoleDescription(Str.trim(description))

// The drafts are decoded into the request, so a value the page let through fails the call (said
// where the call was made) instead of throwing.
const decodeCreate = Schema.decodeUnknownEffect(CreateRoleRequest)
const decodeUpdate = Schema.decodeUnknownEffect(UpdateRoleRequest)

export const createRole = (draft: RoleDraft) =>
	decodeCreate(
		draft.description === "" ? { name: draft.name, permissions: draft.permissions } : draft,
	).pipe(
		Effect.flatMap((payload) =>
			Effect.flatMap(MapleInternalApiClient, (client) => client.roles.create({ payload })),
		),
	)

/** `expectedUpdatedAt` is the role as the editor loaded it, so a save never overwrites a newer one. */
export const updateRole = (roleId: Policy.CustomRoleId, draft: RoleDraft, expectedUpdatedAt: number) =>
	decodeUpdate({ ...draft, expectedUpdatedAt }).pipe(
		Effect.flatMap((payload) =>
			Effect.flatMap(MapleInternalApiClient, (client) =>
				client.roles.update({ params: { roleId }, payload }),
			),
		),
	)

export const deleteRole = (roleId: Policy.CustomRoleId, reassignTo: RoleRef | null) =>
	Effect.flatMap(MapleInternalApiClient, (client) =>
		client.roles.delete({
			params: { roleId },
			payload: new DeleteRoleRequest(reassignTo === null ? {} : { reassignTo }),
		}),
	)

export const setMemberRole = (userId: UserId, role: RoleRef) =>
	Effect.flatMap(MapleInternalApiClient, (client) =>
		client.roles.setMemberRole({ params: { userId }, payload: new SetMemberRoleRequest({ role }) }),
	)
