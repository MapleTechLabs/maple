import { assert, describe, it } from "@effect/vitest"
import {
	CreateRoleRequest,
	OrgId,
	RoleConflictError,
	RoleMemberNotFoundError,
	RoleNotFoundError,
	RolesUnavailableError,
	UpdateRoleRequest,
	UserId,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, ConfigProvider, Effect, Layer, Order, Schema, String as Str } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { MembershipRevocationService } from "@maple/backend/services/auth/MembershipRevocationService"
import { ClerkRolesGateway, type RoleMembership } from "./ClerkRolesGateway"
import { RolesService } from "./RolesService"

const ORG = Schema.decodeSync(OrgId)("org_roles")
const user = Schema.decodeSync(UserId)
const ADMIN = user("user_admin")
const roleId = Policy.CustomRoleId.make

const ON_CALL = roleId("role_oncall000000")
const VIEWER = roleId("role_viewer000000")

const adminTenant = { orgId: ORG, userId: ADMIN, permissions: Policy.grantsOf(["org:admin"]) }
const asAdmin = Effect.provideService(Policy.CurrentActor, adminTenant)

const stored = (
	id: Policy.CustomRoleId,
	name: string,
	permissions: ReadonlyArray<Policy.Permission>,
): Policy.StoredCustomRole => ({
	id,
	name,
	description: "",
	permissions: Policy.encodePermissions(permissions),
	createdAt: 1,
	updatedAt: 1,
})

interface FakeMember {
	readonly userId: string
	readonly role: string
	readonly custom?: Policy.MembershipRoleMetadata
}

const onCallPermissions: ReadonlyArray<Policy.Permission> = [
	"telemetry:read",
	"incidents:respond",
	"oncall:manage",
]

/**
 * One Clerk organization in memory, with every write recorded. `onRolesRead` runs, in order, one
 * per read of the definitions, to land another admin's change between two of them; `onRolesWrite`
 * runs one per write of them, just after it, for a second writer that passed the same check.
 * `onMetadataWrite` runs one per membership metadata write, just before it.
 */
const fakeClerk = (roles: ReadonlyArray<Policy.StoredCustomRole>, members: ReadonlyArray<FakeMember>) => {
	const state = {
		version: 0,
		roles: [...roles],
		members: new Map(Arr.map(members, (member) => [member.userId, member] as const)),
		writes: [] as Array<string>,
		onRolesRead: [] as Array<() => void>,
		onRolesWrite: [] as Array<() => void>,
		onMetadataWrite: [] as Array<() => void>,
	}
	const toMembership = (member: FakeMember): RoleMembership => ({
		userId: user(member.userId),
		role: member.role,
		metadata: member.custom === undefined ? {} : { [Policy.MEMBERSHIP_ROLE_METADATA_KEY]: member.custom },
		name: null,
		identifier: `${member.userId}@acme.test`,
		imageUrl: null,
	})
	const change = (userId: string, edit: (member: FakeMember) => FakeMember) => {
		const member = state.members.get(userId)
		if (member !== undefined) state.members.set(userId, edit(member))
	}
	/** Another admin's write to the definitions. */
	const writeElsewhere = (next: ReadonlyArray<Policy.StoredCustomRole>) => {
		state.version += 1
		state.roles = [...next]
	}
	const layer = Layer.succeed(ClerkRolesGateway, {
		customRoles: () =>
			Effect.sync(() => {
				state.onRolesRead.shift()?.()
				return { version: state.version, roles: state.roles }
			}),
		writeCustomRoles: (_orgId, next) =>
			Effect.sync(() => {
				state.writes.push(`roles@${next.version}`)
				state.version = next.version
				state.roles = [...next.roles]
				state.onRolesWrite.shift()?.()
			}),
		memberships: () => Effect.sync(() => Arr.map(Arr.fromIterable(state.members.values()), toMembership)),
		setMembershipRole: (_orgId, userId, role) =>
			Effect.sync(() => {
				state.writes.push(`role:${userId}`)
				change(userId, (member) => ({ ...member, role }))
			}),
		setMembershipCustomRole: (_orgId, userId, custom) =>
			Effect.sync(() => {
				state.onMetadataWrite.shift()?.()
				state.writes.push(`metadata:${userId}`)
				change(userId, ({ custom: _dropped, ...member }) =>
					custom === null ? member : { ...member, custom },
				)
			}),
	})
	const roleOf = (userId: string) => state.members.get(userId)?.role
	const customOf = (userId: string) => state.members.get(userId)?.custom
	return { state, layer, roleOf, customOf, writeElsewhere }
}

const recordingRevocation = () => {
	const demoted: Array<{ readonly userId: string; readonly grants: Policy.Grants }> = []
	const layer = Layer.succeed(MembershipRevocationService, {
		revokeMembership: () => Effect.die("unused"),
		revokeUser: () => Effect.die("unused"),
		demoteMembership: (_orgId, userId, grants) =>
			Effect.sync(() => {
				demoted.push({ userId, grants })
				return {
					apiKeysRevoked: 0,
					mcpFamiliesRevoked: 0,
					deviceCredentialsRevoked: 0,
					dashboardSharesRevoked: 0,
					digestSubscriptionsDisabled: 0,
					mobileDevicesDeleted: 0,
				}
			}),
		invalidateMembership: () => Effect.void,
	})
	return { demoted, layer }
}

const setup = (roles: ReadonlyArray<Policy.StoredCustomRole>, members: ReadonlyArray<FakeMember>) => {
	const clerk = fakeClerk(roles, members)
	const revocation = recordingRevocation()
	const layer = Layer.effect(RolesService, RolesService.make).pipe(
		Layer.provide(Layer.mergeAll(clerk.layer, revocation.layer)),
	)
	return { clerk, revocation, layer }
}

const onCallHolder = (userId: string, permissions = onCallPermissions): FakeMember => ({
	userId,
	role: Policy.CUSTOM_ROLE_CLERK_KEY,
	custom: { id: ON_CALL, permissions: Policy.encodePermissions(permissions) },
})

const conflictReason = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
	Effect.flip(effect).pipe(
		Effect.map((error) =>
			Schema.is(RoleConflictError)(error) ? error.reason : `not a conflict: ${String(error)}`,
		),
	)

describe("RolesService.list", () => {
	it.effect("counts members per role, custom ones by the role their membership names", () => {
		const { layer } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions), stored(VIEWER, "Auditor", ["telemetry:read"])],
			[
				{ userId: "user_admin", role: "org:admin" },
				{ userId: "user_ana", role: "org:member" },
				{ userId: "user_ben", role: "org:member" },
				onCallHolder("user_cat"),
				onCallHolder("user_dan"),
				// Names a role that no longer exists: counted nowhere.
				{
					userId: "user_eve",
					role: Policy.CUSTOM_ROLE_CLERK_KEY,
					custom: { id: roleId("role_gone00000000"), permissions: [] },
				},
			],
		)
		return Effect.gen(function* () {
			const list = yield* (yield* RolesService).list.pipe(asAdmin)
			assert.deepStrictEqual(
				Arr.map(list.builtIn, (role) => [role.clerkKey, role.memberCount]),
				[
					["org:analyst", 0],
					["org:member", 2],
					["org:engineer", 0],
					["org:admin", 1],
				],
			)
			// By name: Auditor before On-call.
			assert.deepStrictEqual(
				Arr.map(list.custom, (role) => [role.name, role.memberCount]),
				[
					["Auditor", 0],
					["On-call", 2],
				],
			)
			assert.deepStrictEqual(list.custom[1]?.permissions, [
				"telemetry:read",
				"incidents:respond",
				"oncall:manage",
			])
			assert.strictEqual(list.customRoleLimit, Policy.MAX_CUSTOM_ROLES)
			const holderIds = (key: string) => Arr.map(list.holders[key] ?? [], (holder) => holder.userId)
			assert.deepStrictEqual(holderIds("member"), ["user_ana", "user_ben"])
			assert.deepStrictEqual(holderIds(ON_CALL), ["user_cat", "user_dan"])
			assert.deepStrictEqual(holderIds(VIEWER), [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("previews at most five holders per role while counting all of them", () => {
		const people = Arr.map(Arr.range(1, 7), (index) => ({ userId: `user_${index}`, role: "org:member" }))
		const { layer } = setup([], people)
		return Effect.gen(function* () {
			const list = yield* (yield* RolesService).list.pipe(asAdmin)
			assert.strictEqual(list.builtIn[1]?.memberCount, 7)
			assert.deepStrictEqual(
				Arr.map(list.holders.member ?? [], (holder) => holder.userId),
				["user_1", "user_2", "user_3", "user_4", "user_5"],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("lists a built-in role's holders by its name, leaving custom holders out", () => {
		const { layer } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[
				{ userId: "user_admin", role: "org:admin" },
				{ userId: "user_ana", role: "org:member" },
				{ userId: "user_ben", role: "org:member" },
				onCallHolder("user_cat"),
			],
		)
		return Effect.gen(function* () {
			const roles = yield* RolesService
			const holders = yield* roles.members("member").pipe(asAdmin)
			assert.deepStrictEqual(
				Arr.map(holders.members, (member) => member.userId),
				["user_ana", "user_ben"],
			)
			const engineers = yield* roles.members("engineer").pipe(asAdmin)
			assert.deepStrictEqual(engineers.members, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("lists a custom role's holders and refuses a role that does not exist", () => {
		const { layer } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[{ userId: "user_admin", role: "org:admin" }, onCallHolder("user_cat")],
		)
		return Effect.gen(function* () {
			const roles = yield* RolesService
			const holders = yield* roles.members(ON_CALL).pipe(asAdmin)
			assert.deepStrictEqual(
				Arr.map(holders.members, (member) => [member.userId, member.identifier]),
				[["user_cat", "user_cat@acme.test"]],
			)
			const missing = yield* Effect.flip(roles.members(VIEWER).pipe(asAdmin))
			assert.strictEqual(missing._tag, "@maple/http/roles/RoleNotFoundError")
		}).pipe(Effect.provide(layer))
	})
})

describe("RolesService.create", () => {
	const request = (name: string, permissions: ReadonlyArray<Policy.Permission> = ["telemetry:read"]) =>
		new CreateRoleRequest({ name, permissions })

	it.effect("stores a new role with a fresh id and the permissions as codes", () => {
		const { layer, clerk } = setup([], [{ userId: "user_admin", role: "org:admin" }])
		return Effect.gen(function* () {
			const created = yield* (yield* RolesService)
				.create(request("On-call", onCallPermissions))
				.pipe(asAdmin)
			assert.match(created.id, /^role_[a-z0-9]{12}$/)
			assert.strictEqual(created.memberCount, 0)
			assert.deepStrictEqual(
				Arr.map(clerk.state.roles, (role) => [role.id, role.name, role.permissions]),
				[[created.id, "On-call", Policy.encodePermissions(onCallPermissions)]],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses a taken name, case aside, and a built-in role's name", () => {
		const { layer, clerk } = setup([stored(ON_CALL, "On-call", onCallPermissions)], [])
		return Effect.gen(function* () {
			const roles = yield* RolesService
			assert.strictEqual(
				yield* conflictReason(roles.create(request("on-CALL")).pipe(asAdmin)),
				"name_taken",
			)
			assert.strictEqual(
				yield* conflictReason(roles.create(request("Engineer")).pipe(asAdmin)),
				"name_taken",
			)
			assert.deepStrictEqual(clerk.state.writes, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses a role past the organization's limit", () => {
		const full = Arr.makeBy(Policy.MAX_CUSTOM_ROLES, (index) =>
			stored(roleId(`role_full${Str.padStart(8, "0")(String(index))}`), `Role ${index}`, [
				"telemetry:read",
			]),
		)
		const { layer, clerk } = setup(full, [])
		return Effect.gen(function* () {
			const roles = yield* RolesService
			assert.strictEqual(
				yield* conflictReason(roles.create(request("One more")).pipe(asAdmin)),
				"limit_reached",
			)
			assert.deepStrictEqual(clerk.state.writes, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses a permission custom roles may not hold", () => {
		const { layer, clerk } = setup([], [])
		return Effect.gen(function* () {
			assert.strictEqual(
				yield* conflictReason(
					(yield* RolesService).create(request("Managers", ["members:manage"])).pipe(asAdmin),
				),
				"not_grantable",
			)
			assert.deepStrictEqual(clerk.state.writes, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("stores what the permissions imply, so a role cannot act on telemetry it cannot read", () => {
		const { layer, clerk } = setup([], [])
		return Effect.gen(function* () {
			const created = yield* (yield* RolesService)
				.create(request("Responders", ["incidents:respond", "ingest_keys:roll"]))
				.pipe(asAdmin)
			const closed: ReadonlyArray<Policy.Permission> = [
				"telemetry:read",
				"incidents:respond",
				"ingest_keys:view",
				"ingest_keys:roll",
			]
			assert.deepStrictEqual(created.permissions, closed)
			assert.deepStrictEqual(clerk.state.roles[0]?.permissions, Policy.encodePermissions(closed))
		}).pipe(Effect.provide(layer))
	})

	it.effect("redoes the edit from a fresh read when another write lands first, keeping both", () => {
		const { layer, clerk } = setup([], [])
		// Between this create's read and its write, another admin adds a role.
		clerk.state.onRolesRead.push(
			() => undefined,
			() => clerk.writeElsewhere([stored(VIEWER, "Viewer", ["telemetry:read"])]),
		)
		return Effect.gen(function* () {
			const created = yield* (yield* RolesService).create(request("On-call")).pipe(asAdmin)
			assert.deepStrictEqual(
				Arr.map(clerk.state.roles, (role) => role.id),
				[VIEWER, created.id],
			)
			assert.deepStrictEqual(clerk.state.writes, ["roles@2"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("redoes the edit when a writer that passed the same check overwrites it", () => {
		const { layer, clerk } = setup([], [])
		// Another admin read version 0 too, and writes version 1 straight after this create.
		clerk.state.onRolesWrite.push(() => {
			clerk.state.roles = [stored(VIEWER, "Viewer", ["telemetry:read"])]
		})
		return Effect.gen(function* () {
			const created = yield* (yield* RolesService).create(request("On-call")).pipe(asAdmin)
			assert.deepStrictEqual(
				Arr.map(clerk.state.roles, (role) => role.id),
				[VIEWER, created.id],
			)
			assert.deepStrictEqual(clerk.state.writes, ["roles@1", "roles@2"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("keeps the edit when a later write carried it", () => {
		const { layer, clerk } = setup([], [])
		clerk.state.onRolesWrite.push(() => {
			clerk.state.version = 2
			clerk.state.roles = [...clerk.state.roles, stored(VIEWER, "Viewer", ["telemetry:read"])]
		})
		return Effect.gen(function* () {
			const created = yield* (yield* RolesService).create(request("On-call")).pipe(asAdmin)
			assert.deepStrictEqual(
				Arr.map(clerk.state.roles, (role) => role.id),
				[created.id, VIEWER],
			)
			assert.deepStrictEqual(clerk.state.writes, ["roles@1"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("gives up with concurrent_edit when other writes keep landing first", () => {
		const { layer, clerk } = setup([], [])
		for (let attempt = 0; attempt < 3; attempt++) {
			clerk.state.onRolesRead.push(
				() => undefined,
				() => clerk.writeElsewhere(clerk.state.roles),
			)
		}
		return Effect.gen(function* () {
			assert.strictEqual(
				yield* conflictReason((yield* RolesService).create(request("On-call")).pipe(asAdmin)),
				"concurrent_edit",
			)
			assert.deepStrictEqual(clerk.state.writes, [])
		}).pipe(Effect.provide(layer))
	})
})

describe("RolesService.update", () => {
	it.effect("rewrites every holder's permissions and demotes them to the new grants", () => {
		const { layer, clerk, revocation } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[{ userId: "user_admin", role: "org:admin" }, onCallHolder("user_cat"), onCallHolder("user_dan")],
		)
		const narrowed: ReadonlyArray<Policy.Permission> = ["telemetry:read", "incidents:respond"]
		return Effect.gen(function* () {
			const { before, role } = yield* (yield* RolesService)
				.update(
					ON_CALL,
					new UpdateRoleRequest({
						expectedUpdatedAt: 1,
						name: "On-call",
						description: "",
						permissions: narrowed,
					}),
				)
				.pipe(asAdmin)
			assert.deepStrictEqual(before.permissions, [
				"telemetry:read",
				"incidents:respond",
				"oncall:manage",
			])
			assert.deepStrictEqual(role.permissions, narrowed)
			assert.strictEqual(role.memberCount, 2)
			assert.deepStrictEqual(
				clerk.customOf("user_cat")?.permissions,
				Policy.encodePermissions(narrowed),
			)
			assert.deepStrictEqual(
				clerk.customOf("user_dan")?.permissions,
				Policy.encodePermissions(narrowed),
			)
			assert.deepStrictEqual(clerk.state.roles[0]?.permissions, Policy.encodePermissions(narrowed))
			assert.deepStrictEqual(
				Arr.sort(
					Arr.map(revocation.demoted, (entry) => `${entry.userId} ${Arr.join(entry.grants, ",")}`),
					Order.String,
				),
				[`user_cat ${Arr.join(narrowed, ",")}`, `user_dan ${Arr.join(narrowed, ",")}`],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("stores and hands holders what an update's permissions imply", () => {
		const { layer, clerk } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[onCallHolder("user_cat")],
		)
		return Effect.gen(function* () {
			yield* (yield* RolesService)
				.update(
					ON_CALL,
					new UpdateRoleRequest({
						expectedUpdatedAt: 1,
						name: "On-call",
						description: "",
						permissions: ["alerts:manage"],
					}),
				)
				.pipe(asAdmin)
			const closed = Policy.encodePermissions(["telemetry:read", "alerts:manage"])
			assert.deepStrictEqual(clerk.state.roles[0]?.permissions, closed)
			assert.deepStrictEqual(clerk.customOf("user_cat")?.permissions, closed)
		}).pipe(Effect.provide(layer))
	})

	it.effect("renames without touching holders that already carry the role's permissions", () => {
		const { layer, clerk, revocation } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[onCallHolder("user_cat")],
		)
		return Effect.gen(function* () {
			const { role } = yield* (yield* RolesService)
				.update(
					ON_CALL,
					new UpdateRoleRequest({
						expectedUpdatedAt: 1,
						name: "Responders",
						description: "",
						permissions: onCallPermissions,
					}),
				)
				.pipe(asAdmin)
			assert.strictEqual(role.name, "Responders")
			assert.deepStrictEqual(clerk.state.writes, ["roles@1"])
			assert.deepStrictEqual(revocation.demoted, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("narrows a holder put on the role, with its old permissions, while the update saved", () => {
		const { layer, clerk, revocation } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[{ userId: "user_ana", role: "org:member" }],
		)
		// Another admin moves Ana onto On-call from the definition as it was, just before this save.
		clerk.state.onRolesRead.push(
			() => undefined,
			() => clerk.state.members.set("user_ana", onCallHolder("user_ana")),
		)
		const narrowed: ReadonlyArray<Policy.Permission> = ["telemetry:read"]
		return Effect.gen(function* () {
			const { role } = yield* (yield* RolesService)
				.update(
					ON_CALL,
					new UpdateRoleRequest({
						expectedUpdatedAt: 1,
						name: "On-call",
						description: "",
						permissions: narrowed,
					}),
				)
				.pipe(asAdmin)
			assert.strictEqual(role.memberCount, 1)
			assert.deepStrictEqual(clerk.customOf("user_ana"), {
				id: ON_CALL,
				permissions: Policy.encodePermissions(narrowed),
			})
			assert.deepStrictEqual(revocation.demoted, [{ userId: "user_ana", grants: narrowed }])
		}).pipe(Effect.provide(layer))
	})
})

describe("RolesService.update, from a stale editor", () => {
	it.effect("refuses a save made from a role another admin saved since, writing nothing", () => {
		const { layer, clerk, revocation } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[onCallHolder("user_cat")],
		)
		return Effect.gen(function* () {
			const reason = yield* conflictReason(
				(yield* RolesService)
					.update(
						ON_CALL,
						new UpdateRoleRequest({
							expectedUpdatedAt: 0,
							name: "On-call",
							description: "",
							permissions: ["telemetry:read"],
						}),
					)
					.pipe(asAdmin),
			)
			assert.strictEqual(reason, "concurrent_edit")
			assert.deepStrictEqual(clerk.state.writes, [])
			assert.deepStrictEqual(revocation.demoted, [])
		}).pipe(Effect.provide(layer))
	})
})

describe("RolesService.update, racing a stale writer", () => {
	it.effect("gives up after repeated losses, leaving holders as the stored definition says", () => {
		const narrow = stored(ON_CALL, "On-call", ["telemetry:read"])
		const { layer, clerk, revocation } = setup([narrow], [{ userId: "user_cat", role: "org:member" }])
		// Each widening write is overwritten by a writer still holding the narrow definition; after the
		// first, another admin put Cat on the role with the widened permissions it briefly had.
		for (let attempt = 0; attempt < 3; attempt++) {
			clerk.state.onRolesWrite.push(() => {
				if (attempt === 0) clerk.state.members.set("user_cat", onCallHolder("user_cat"))
				clerk.state.roles = [narrow]
			})
		}
		return Effect.gen(function* () {
			const reason = yield* conflictReason(
				(yield* RolesService)
					.update(
						ON_CALL,
						new UpdateRoleRequest({
							expectedUpdatedAt: 1,
							name: "On-call",
							description: "",
							permissions: onCallPermissions,
						}),
					)
					.pipe(asAdmin),
			)
			assert.strictEqual(reason, "concurrent_edit")
			assert.deepStrictEqual(clerk.state.roles, [narrow])
			assert.deepStrictEqual(clerk.customOf("user_cat")?.permissions, narrow.permissions)
			assert.deepStrictEqual(revocation.demoted, [{ userId: "user_cat", grants: ["telemetry:read"] }])
		}).pipe(Effect.provide(layer))
	})
})

describe("RolesService.update, racing a narrowing save", () => {
	it.effect("ends with holders on the narrower definition saved while it rewrote them", () => {
		const narrow = stored(ON_CALL, "On-call", ["telemetry:read"])
		const { layer, clerk, revocation } = setup([narrow], [onCallHolder("user_cat", ["telemetry:read"])])
		// This save widens the role and reads the wide definition to rewrite Cat. Before its write lands,
		// another admin narrows the role again and rewrites Cat to it.
		clerk.state.onMetadataWrite.push(() => {
			clerk.writeElsewhere([narrow])
			clerk.state.members.set("user_cat", onCallHolder("user_cat", ["telemetry:read"]))
		})
		return Effect.gen(function* () {
			yield* (yield* RolesService)
				.update(
					ON_CALL,
					new UpdateRoleRequest({
						expectedUpdatedAt: 1,
						name: "On-call",
						description: "",
						permissions: onCallPermissions,
					}),
				)
				.pipe(asAdmin)
			assert.deepStrictEqual(clerk.state.roles, [narrow])
			assert.deepStrictEqual(clerk.customOf("user_cat")?.permissions, narrow.permissions)
			assert.deepStrictEqual(revocation.demoted.at(-1), {
				userId: "user_cat",
				grants: ["telemetry:read"],
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("gives up with concurrent_edit when the role keeps changing under its holders", () => {
		const narrow = stored(ON_CALL, "On-call", ["telemetry:read"])
		const wide = stored(ON_CALL, "On-call", onCallPermissions)
		const { layer, clerk } = setup([narrow], [onCallHolder("user_cat", ["telemetry:read"])])
		// Every rewrite of Cat is overtaken by a save flipping the role the other way.
		for (let pass = 0; pass < 3; pass++) {
			clerk.state.onMetadataWrite.push(() => clerk.writeElsewhere([pass % 2 === 0 ? narrow : wide]))
		}
		return Effect.gen(function* () {
			const reason = yield* conflictReason(
				(yield* RolesService)
					.update(
						ON_CALL,
						new UpdateRoleRequest({
							expectedUpdatedAt: 1,
							name: "On-call",
							description: "",
							permissions: onCallPermissions,
						}),
					)
					.pipe(asAdmin),
			)
			assert.strictEqual(reason, "concurrent_edit")
		}).pipe(Effect.provide(layer))
	})
})

describe("RolesService.delete", () => {
	it.effect("refuses to delete a role still held when no role is named for its members", () => {
		const { layer, clerk } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[onCallHolder("user_cat")],
		)
		return Effect.gen(function* () {
			const roles = yield* RolesService
			assert.strictEqual(
				yield* conflictReason(roles.delete(ON_CALL, undefined).pipe(asAdmin)),
				"in_use",
			)
			assert.strictEqual(
				yield* conflictReason(roles.delete(ON_CALL, { _tag: "Custom", id: ON_CALL }).pipe(asAdmin)),
				"in_use",
			)
			assert.strictEqual(clerk.state.roles.length, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("moves the holders to the named role, then removes the definition", () => {
		const { layer, clerk, revocation } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions), stored(VIEWER, "Viewer", ["telemetry:read"])],
			[onCallHolder("user_cat"), { userId: "user_ana", role: "org:member" }],
		)
		return Effect.gen(function* () {
			const deleted = yield* (yield* RolesService)
				.delete(ON_CALL, {
					_tag: "Custom",
					id: VIEWER,
				})
				.pipe(asAdmin)
			assert.strictEqual(deleted.moved, 1)
			assert.deepStrictEqual(
				Arr.map(clerk.state.roles, (role) => role.id),
				[VIEWER],
			)
			assert.strictEqual(clerk.roleOf("user_cat"), Policy.CUSTOM_ROLE_CLERK_KEY)
			assert.deepStrictEqual(clerk.customOf("user_cat"), {
				id: VIEWER,
				permissions: Policy.encodePermissions(["telemetry:read"]),
			})
			assert.deepStrictEqual(revocation.demoted, [{ userId: "user_cat", grants: ["telemetry:read"] }])
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses to move holders to a role deleted since the page loaded, and moves no one", () => {
		const { layer, clerk } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[onCallHolder("user_cat")],
		)
		return Effect.gen(function* () {
			const missing = yield* Effect.flip(
				(yield* RolesService).delete(ON_CALL, { _tag: "Custom", id: VIEWER }).pipe(asAdmin),
			)
			assert.instanceOf(missing, RoleNotFoundError)
			assert.strictEqual(missing.roleId, VIEWER)
			assert.deepStrictEqual(clerk.state.writes, [])
			assert.strictEqual(clerk.customOf("user_cat")?.id, ON_CALL)
		}).pipe(Effect.provide(layer))
	})

	it.effect("moves a member put on the role while it was removed along with the others", () => {
		const { layer, clerk } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[onCallHolder("user_cat"), { userId: "user_ana", role: "org:member" }],
		)
		// Another admin puts Ana on On-call between this delete's version check and its write.
		clerk.state.onRolesRead.push(
			() => undefined,
			() => undefined,
			() => clerk.state.members.set("user_ana", onCallHolder("user_ana")),
		)
		return Effect.gen(function* () {
			const deleted = yield* (yield* RolesService)
				.delete(ON_CALL, {
					_tag: "BuiltIn",
					clerkKey: "org:member",
				})
				.pipe(asAdmin)
			assert.strictEqual(deleted.moved, 2)
			assert.deepStrictEqual(
				[clerk.roleOf("user_cat"), clerk.roleOf("user_ana")],
				["org:member", "org:member"],
			)
			assert.strictEqual(clerk.customOf("user_ana"), undefined)
		}).pipe(Effect.provide(layer))
	})
})

describe("RolesService.delete, orphans", () => {
	it.effect("leaves a member put on the role while it was removed holding nothing, not Analyst", () => {
		const { layer, clerk, revocation } = setup(
			[stored(ON_CALL, "On-call", onCallPermissions)],
			[{ userId: "user_ana", role: "org:member" }],
		)
		// Nobody holds the role when the delete reads; another admin puts Ana on it before the write.
		clerk.state.onRolesRead.push(
			() => undefined,
			() => undefined,
			() => clerk.state.members.set("user_ana", onCallHolder("user_ana")),
		)
		return Effect.gen(function* () {
			const deleted = yield* (yield* RolesService).delete(ON_CALL, undefined).pipe(asAdmin)
			assert.strictEqual(deleted.moved, 1)
			assert.deepStrictEqual(
				[clerk.roleOf("user_ana"), clerk.customOf("user_ana")],
				[Policy.CUSTOM_ROLE_CLERK_KEY, undefined],
			)
			assert.deepStrictEqual(revocation.demoted, [{ userId: "user_ana", grants: [] }])
		}).pipe(Effect.provide(layer))
	})
})

describe("RolesService.setMemberRole", () => {
	const members: ReadonlyArray<FakeMember> = [
		{ userId: "user_admin", role: "org:admin" },
		{ userId: "user_ana", role: "org:member" },
		onCallHolder("user_cat"),
	]

	it.effect("moves a member onto a custom role: org:custom plus the role on the membership", () => {
		const { layer, clerk, revocation } = setup([stored(ON_CALL, "On-call", onCallPermissions)], members)
		return Effect.gen(function* () {
			const change = yield* (yield* RolesService)
				.setMemberRole(user("user_ana"), {
					_tag: "Custom",
					id: ON_CALL,
				})
				.pipe(asAdmin)
			assert.strictEqual(change.previousRole, "org:member")
			assert.deepStrictEqual(change.member.permissions, [
				"telemetry:read",
				"incidents:respond",
				"oncall:manage",
			])
			assert.strictEqual(clerk.roleOf("user_ana"), Policy.CUSTOM_ROLE_CLERK_KEY)
			assert.deepStrictEqual(clerk.customOf("user_ana"), {
				id: ON_CALL,
				permissions: Policy.encodePermissions(onCallPermissions),
			})
			// The permissions land before the role, so Clerk never holds org:custom without them.
			assert.deepStrictEqual(clerk.state.writes, ["metadata:user_ana", "role:user_ana"])
			assert.deepStrictEqual(revocation.demoted, [
				{ userId: "user_ana", grants: change.member.permissions },
			])
		}).pipe(Effect.provide(layer))
	})

	it.effect("rewrites the member to the role's permissions when it was narrowed during the move", () => {
		const { layer, clerk, revocation } = setup([stored(ON_CALL, "On-call", onCallPermissions)], members)
		// Another admin narrows On-call after this move read it.
		clerk.state.onRolesRead.push(
			() => undefined,
			() => clerk.writeElsewhere([stored(ON_CALL, "On-call", ["telemetry:read"])]),
		)
		return Effect.gen(function* () {
			const change = yield* (yield* RolesService)
				.setMemberRole(user("user_ana"), {
					_tag: "Custom",
					id: ON_CALL,
				})
				.pipe(asAdmin)
			assert.deepStrictEqual(change.member.permissions, ["telemetry:read"])
			assert.deepStrictEqual(
				clerk.customOf("user_ana")?.permissions,
				Policy.encodePermissions(["telemetry:read"]),
			)
			// The role's other holder follows too.
			assert.deepStrictEqual(
				clerk.customOf("user_cat")?.permissions,
				Policy.encodePermissions(["telemetry:read"]),
			)
			assert.deepStrictEqual(
				Arr.filter(revocation.demoted, (entry) => entry.userId === "user_ana").at(-1),
				{ userId: "user_ana", grants: ["telemetry:read"] },
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("moves a custom member onto a built-in role and clears the membership's custom role", () => {
		const { layer, clerk, revocation } = setup([stored(ON_CALL, "On-call", onCallPermissions)], members)
		return Effect.gen(function* () {
			const change = yield* (yield* RolesService)
				.setMemberRole(user("user_cat"), {
					_tag: "BuiltIn",
					clerkKey: "org:analyst",
				})
				.pipe(asAdmin)
			assert.strictEqual(change.previousRole, ON_CALL)
			assert.strictEqual(clerk.roleOf("user_cat"), "org:analyst")
			assert.strictEqual(clerk.customOf("user_cat"), undefined)
			assert.deepStrictEqual(revocation.demoted, [
				{ userId: "user_cat", grants: Policy.grantsOf(["org:analyst"]) },
			])
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses the caller's own role, the last Admin and someone outside the organization", () => {
		const { layer, clerk } = setup([], members)
		// Someone holding members:manage without being one of the org's admins in Clerk.
		const operator = { ...adminTenant, userId: user("user_operator") }
		return Effect.gen(function* () {
			const roles = yield* RolesService
			const toMember = { _tag: "BuiltIn", clerkKey: "org:member" } as const
			assert.strictEqual(
				yield* conflictReason(roles.setMemberRole(ADMIN, toMember).pipe(asAdmin)),
				"self",
			)
			assert.strictEqual(
				yield* conflictReason(
					roles
						.setMemberRole(ADMIN, toMember)
						.pipe(Effect.provideService(Policy.CurrentActor, operator)),
				),
				"last_admin",
			)
			const outsider = yield* Effect.flip(
				roles.setMemberRole(user("user_nobody"), toMember).pipe(asAdmin),
			)
			assert.instanceOf(outsider, RoleMemberNotFoundError)
			assert.deepStrictEqual(clerk.state.writes, [])
		}).pipe(Effect.provide(layer))
	})
})

describe("RolesService without Clerk", () => {
	const selfHosted = ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

	it.effect("answers that roles need Clerk, for reads and writes alike", () => {
		const layer = Layer.effect(RolesService, RolesService.make).pipe(
			Layer.provide(Layer.mergeAll(ClerkRolesGateway.layer, recordingRevocation().layer)),
			Layer.provide(Env.layer.pipe(Layer.provide(selfHosted))),
		)
		return Effect.gen(function* () {
			const roles = yield* RolesService
			const listed = yield* Effect.flip(roles.list.pipe(asAdmin))
			assert.instanceOf(listed, RolesUnavailableError)
			const created = yield* Effect.flip(
				roles
					.create(new CreateRoleRequest({ name: "On-call", permissions: ["telemetry:read"] }))
					.pipe(asAdmin),
			)
			assert.instanceOf(created, RolesUnavailableError)
		}).pipe(Effect.provide(layer))
	})
})
