import {
	BuiltInRoleResponse,
	CustomRoleResponse,
	RoleListResponse,
	RoleMemberResponse,
	RoleMembersResponse,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { UserId } from "@maple/primitives"
import { Array as Arr, Record as Rec, Schema, String as Str } from "effect"

// Roles for the scene tests and the labs: the four built-in roles with member counts, and custom
// roles built from a name and a permission list.

const decodeRoleId = Schema.decodeSync(Policy.CustomRoleId)

export const roleId = (suffix: string): Policy.CustomRoleId =>
	decodeRoleId(`role_${Str.padEnd(12, "0")(suffix)}`)

export const customRole = (input: {
	readonly id: Policy.CustomRoleId
	readonly name: string
	readonly description?: string
	readonly permissions: ReadonlyArray<Policy.Permission>
	readonly memberCount?: number
}): CustomRoleResponse =>
	new CustomRoleResponse({
		id: input.id,
		name: input.name,
		description: input.description ?? "",
		permissions: input.permissions,
		memberCount: input.memberCount ?? 0,
		createdAt: 0,
		updatedAt: 0,
	})

const BUILT_IN_COUNTS = { "org:analyst": 3, "org:member": 8, "org:engineer": 5, "org:admin": 2 } as const

const PEOPLE = [
	"Grace Hopper",
	"Alan Turing",
	"Katherine Johnson",
	"Ada Lovelace",
	"Edsger Dijkstra",
	"Barbara Liskov",
	"Donald Knuth",
	"Margaret Hamilton",
]

/** `count` people from the cast, starting at `offset`, as a role's holder preview (five at most). */
const holdersPreview = (offset: number, count: number): ReadonlyArray<RoleMemberResponse> =>
	roleMembers(
		Array.from({ length: Math.min(count, 5) }, (_, index) => {
			const name = PEOPLE[(offset + index) % PEOPLE.length] ?? "Someone"
			return { id: `user_${Str.toLowerCase(Str.replaceAll(" ", "_")(name))}`, name }
		}),
	).members

export const roleList = (custom: ReadonlyArray<CustomRoleResponse>): RoleListResponse =>
	new RoleListResponse({
		builtIn: Arr.map(
			Policy.builtInRoles,
			(role) =>
				new BuiltInRoleResponse({
					clerkKey: role.clerkKey,
					label: role.label,
					summary: role.summary,
					permissions: role.permissions,
					memberCount: BUILT_IN_COUNTS[role.clerkKey],
				}),
		),
		custom,
		customRoleLimit: Policy.MAX_CUSTOM_ROLES,
		holders: {
			...Rec.fromEntries(
				Arr.map(Policy.builtInRoles, (role, index): readonly [string, ReadonlyArray<RoleMemberResponse>] => [
					role.role,
					holdersPreview(index * 2, BUILT_IN_COUNTS[role.clerkKey]),
				]),
			),
			...Rec.fromEntries(
				Arr.map(custom, (role): readonly [string, ReadonlyArray<RoleMemberResponse>] => [
					role.id,
					holdersPreview(0, role.memberCount),
				]),
			),
		},
	})

/** On-call responder: Member's permissions plus alerting, on-call and SLOs, held by three people. */
export const ON_CALL = customRole({
	id: roleId("oncall"),
	name: "On-call responder",
	description: "Member, plus alert rules, schedules and SLOs.",
	permissions: [...Policy.builtInRoles[1].permissions, "alerts:manage", "oncall:manage", "slos:manage"],
	memberCount: 3,
})

/** Status page editor: nobody holds it yet. */
export const STATUS_EDITOR = customRole({
	id: roleId("status"),
	name: "Status page editor",
	description: "Reads telemetry and runs the status pages.",
	permissions: ["telemetry:read", "status_pages:edit", "status_page_incidents:post"],
})

export const roleMembers = (
	people: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): RoleMembersResponse =>
	new RoleMembersResponse({
		members: Arr.map(
			people,
			(person) =>
				new RoleMemberResponse({
					userId: UserId.make(person.id),
					name: person.name,
					identifier: `${Str.replace("user_", "")(person.id)}@acme.test`,
					imageUrl: null,
				}),
		),
	})
