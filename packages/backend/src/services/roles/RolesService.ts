import {
	BuiltInRoleResponse,
	type CreateRoleRequest,
	type CurrentTenant,
	CustomRoleResponse,
	MemberRoleResponse,
	type OrgId,
	RoleConflictError,
	RoleListResponse,
	RoleMemberNotFoundError,
	RoleMemberResponse,
	RoleMembersResponse,
	RoleNotFoundError,
	type RoleRef,
	RolesUnavailableError,
	type UpdateRoleRequest,
	type UserId,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Order, Random, String as Str } from "effect"
import {
	type MembershipRevocationError,
	MembershipRevocationService,
} from "@maple/backend/services/auth/MembershipRevocationService"
import { ClerkRolesGateway, type RoleMembership } from "./ClerkRolesGateway"

/**
 * Custom roles and who holds which role. Clerk is the store (`Policy.customRolesFromOrgMetadata`):
 * the definitions sit in the organization's public metadata, and an `org:custom` member carries the
 * role's id and a copy of its permissions on their membership. Every write that can narrow what
 * someone holds ends with `demoteMembership`, so pinned credentials and membership caches follow at
 * once rather than when Clerk's webhook arrives.
 */

/** What the roles endpoints read off the caller. */
export type RolesTenant = Pick<CurrentTenant.TenantContext, "orgId" | "userId" | "permissions">

export interface RoleUpdate {
	readonly before: CustomRoleResponse
	readonly role: CustomRoleResponse
}

export interface RoleDeletion {
	readonly id: Policy.CustomRoleId
	readonly name: string
	/** How many members moved to `reassignTo`. */
	readonly moved: number
}

export interface MemberRoleChange {
	/** The Clerk role key the member held, or their custom role's id. */
	readonly previousRole: string
	readonly member: MemberRoleResponse
}

export interface RolesServiceApi {
	readonly list: (tenant: RolesTenant) => Effect.Effect<RoleListResponse, RolesUnavailableError>
	readonly members: (
		tenant: RolesTenant,
		roleId: Policy.CustomRoleId,
	) => Effect.Effect<RoleMembersResponse, RolesUnavailableError | RoleNotFoundError>
	readonly create: (
		tenant: RolesTenant,
		request: CreateRoleRequest,
	) => Effect.Effect<CustomRoleResponse, RolesUnavailableError | RoleConflictError>
	/** Holders whose membership carries other permissions are rewritten, then demoted. */
	readonly update: (
		tenant: RolesTenant,
		roleId: Policy.CustomRoleId,
		request: UpdateRoleRequest,
	) => Effect.Effect<RoleUpdate, RolesUnavailableError | RoleNotFoundError | RoleConflictError>
	/** Moves the role's holders to `reassignTo` first; required while anyone holds it. */
	readonly delete: (
		tenant: RolesTenant,
		roleId: Policy.CustomRoleId,
		reassignTo: RoleRef | undefined,
	) => Effect.Effect<RoleDeletion, RolesUnavailableError | RoleNotFoundError | RoleConflictError>
	readonly setMemberRole: (
		tenant: RolesTenant,
		userId: UserId,
		role: RoleRef,
	) => Effect.Effect<
		MemberRoleChange,
		RolesUnavailableError | RoleNotFoundError | RoleConflictError | RoleMemberNotFoundError
	>
}

const ADMIN_CLERK_KEY = "org:admin"

/** A role a member can be moved to, resolved to what Clerk stores and what it grants. */
interface AssignTarget {
	readonly ref: RoleRef
	readonly clerkKey: Policy.AssignableClerkRole
	/** The membership metadata for a custom role; `null` clears it for a built-in one. */
	readonly metadata: Policy.MembershipRoleMetadata | null
	readonly grants: Policy.Grants
}

const conflict = (reason: RoleConflictError["reason"], message: string) =>
	new RoleConflictError({ reason, message })

const notFound = (roleId: Policy.CustomRoleId) => new RoleNotFoundError({ roleId, message: "No such role." })

const revocationUnavailable = (error: MembershipRevocationError) =>
	new RolesUnavailableError({ message: "Could not apply the role change to credentials", cause: error })

/** What a custom role's stored codes grant, in catalog order. */
const customGrants = (codes: ReadonlyArray<number>): Policy.Grants =>
	Policy.grantsOf([Policy.CUSTOM_ROLE_CLERK_KEY], Policy.decodeCustomPermissions(codes))

/** The custom role an `org:custom` membership names. */
const heldCustomRole = (membership: RoleMembership): Option.Option<Policy.MembershipRoleMetadata> =>
	membership.role === Policy.CUSTOM_ROLE_CLERK_KEY
		? Policy.membershipRoleFromMetadata(membership.metadata)
		: Option.none()

const holdersOf = (memberships: ReadonlyArray<RoleMembership>, roleId: Policy.CustomRoleId) =>
	Arr.filter(memberships, (membership) =>
		Option.exists(heldCustomRole(membership), (held) => held.id === roleId),
	)

const sameCodes = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
	a.length === b.length && Arr.every(a, (code, index) => code === b[index])

const toCustomRole = (role: Policy.StoredCustomRole, memberCount: number) =>
	new CustomRoleResponse({
		id: role.id,
		name: role.name,
		description: role.description,
		permissions: customGrants(role.permissions),
		memberCount,
		createdAt: role.createdAt,
		updatedAt: role.updatedAt,
	})

const byName = Order.mapInput(Order.String, (role: Policy.StoredCustomRole) => Str.toLowerCase(role.name))

const make = Effect.gen(function* () {
	const clerk = yield* ClerkRolesGateway
	const revocation = yield* MembershipRevocationService

	const readRoles = (orgId: OrgId) =>
		clerk.organizationMetadata(orgId).pipe(Effect.map(Policy.customRolesFromOrgMetadata))

	const readState = (orgId: OrgId) =>
		Effect.all({ roles: readRoles(orgId), memberships: clerk.memberships(orgId) }, { concurrency: 2 })

	const findRole = (roles: ReadonlyArray<Policy.StoredCustomRole>, roleId: Policy.CustomRoleId) =>
		Effect.fromOption(
			Arr.findFirst(roles, (role) => role.id === roleId),
			() => notFound(roleId),
		)

	const checkPermissions = (tenant: RolesTenant, permissions: ReadonlyArray<Policy.Permission>) => {
		if (!Arr.every(permissions, Policy.grantableToCustomRoles)) {
			return Effect.fail(
				conflict("not_grantable", "Members, roles and the organization stay with Admin."),
			)
		}
		if (Policy.exceeds(permissions, tenant.permissions)) {
			return Effect.fail(conflict("exceeds_caller", "A role can only hold permissions you hold."))
		}
		return Effect.void
	}

	const checkName = (
		roles: ReadonlyArray<Policy.StoredCustomRole>,
		name: string,
		except?: Policy.CustomRoleId,
	) => {
		const wanted = Str.toLowerCase(name)
		const taken =
			Arr.some(Policy.builtInRoles, (role) => Str.toLowerCase(role.label) === wanted) ||
			Arr.some(roles, (role) => role.id !== except && Str.toLowerCase(role.name) === wanted)
		return taken
			? Effect.fail(conflict("name_taken", `A role named ${name} already exists.`))
			: Effect.void
	}

	// Twelve base-36 digits: [a-z0-9].
	const newRoleId = Effect.map(
		Effect.forEach(Arr.range(1, 12), () => Random.nextIntBetween(0, 35)),
		(digits) =>
			Policy.CustomRoleId.make(
				`role_${Arr.join(
					Arr.map(digits, (digit) => digit.toString(36)),
					"",
				)}`,
			),
	)

	const resolveTarget = (roles: ReadonlyArray<Policy.StoredCustomRole>, ref: RoleRef) =>
		ref._tag === "BuiltIn"
			? Effect.succeed<AssignTarget>({
					ref,
					clerkKey: ref.clerkKey,
					metadata: null,
					grants: Policy.grantsOf([ref.clerkKey]),
				})
			: Effect.map(findRole(roles, ref.id), (role): AssignTarget => ({
					ref,
					clerkKey: Policy.CUSTOM_ROLE_CLERK_KEY,
					metadata: { id: role.id, permissions: role.permissions },
					grants: customGrants(role.permissions),
				}))

	const demote = (orgId: OrgId, userId: UserId, grants: Policy.Grants) =>
		revocation.demoteMembership(orgId, userId, grants).pipe(Effect.mapError(revocationUnavailable))

	/**
	 * Move one member. The membership metadata is written before Clerk's role becomes `org:custom`,
	 * and cleared only after it leaves it, so the webhook each write fires never sees `org:custom`
	 * without permissions (which reads as holding nothing and would retire every key they hold).
	 */
	const assign = (orgId: OrgId, userId: UserId, target: AssignTarget) =>
		Effect.gen(function* () {
			if (target.metadata === null) {
				yield* clerk.setMembershipRole(orgId, userId, target.clerkKey)
				yield* clerk.setMembershipCustomRole(orgId, userId, null)
			} else {
				yield* clerk.setMembershipCustomRole(orgId, userId, target.metadata)
				yield* clerk.setMembershipRole(orgId, userId, target.clerkKey)
			}
			yield* demote(orgId, userId, target.grants)
		})

	const list = Effect.fn("RolesService.list")(function* (tenant: RolesTenant) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
		const { roles, memberships } = yield* readState(tenant.orgId)
		return new RoleListResponse({
			builtIn: Arr.map(
				Policy.builtInRoles,
				(role) =>
					new BuiltInRoleResponse({
						clerkKey: role.clerkKey,
						label: role.label,
						summary: role.summary,
						permissions: Policy.grantsOf([role.clerkKey]),
						memberCount: Arr.filter(
							memberships,
							(membership) => membership.role === role.clerkKey,
						).length,
					}),
			),
			custom: Arr.map(Arr.sort(roles, byName), (role) =>
				toCustomRole(role, holdersOf(memberships, role.id).length),
			),
			customRoleLimit: Policy.MAX_CUSTOM_ROLES,
		})
	})

	const members = Effect.fn("RolesService.members")(function* (
		tenant: RolesTenant,
		roleId: Policy.CustomRoleId,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.role.id": roleId })
		const { roles, memberships } = yield* readState(tenant.orgId)
		yield* findRole(roles, roleId)
		return new RoleMembersResponse({
			members: Arr.map(
				holdersOf(memberships, roleId),
				(holder) =>
					new RoleMemberResponse({
						userId: holder.userId,
						name: holder.name,
						identifier: holder.identifier,
						imageUrl: holder.imageUrl,
					}),
			),
		})
	})

	const create = Effect.fn("RolesService.create")(function* (
		tenant: RolesTenant,
		request: CreateRoleRequest,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
		yield* checkPermissions(tenant, request.permissions)
		const roles = yield* readRoles(tenant.orgId)
		yield* checkName(roles, request.name)
		if (roles.length >= Policy.MAX_CUSTOM_ROLES) {
			return yield* conflict(
				"limit_reached",
				`An organization can define up to ${Policy.MAX_CUSTOM_ROLES} custom roles.`,
			)
		}
		const now = yield* Clock.currentTimeMillis
		const role: Policy.StoredCustomRole = {
			id: yield* newRoleId,
			name: request.name,
			description: request.description ?? "",
			permissions: Policy.encodePermissions(request.permissions),
			createdAt: now,
			updatedAt: now,
		}
		yield* Effect.annotateCurrentSpan({ "maple.role.id": role.id })
		yield* clerk.writeCustomRoles(tenant.orgId, [...roles, role])
		return toCustomRole(role, 0)
	})

	const update = Effect.fn("RolesService.update")(function* (
		tenant: RolesTenant,
		roleId: Policy.CustomRoleId,
		request: UpdateRoleRequest,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.role.id": roleId })
		const { roles, memberships } = yield* readState(tenant.orgId)
		const current = yield* findRole(roles, roleId)
		if (request.permissions !== undefined) yield* checkPermissions(tenant, request.permissions)
		if (request.name !== undefined) yield* checkName(roles, request.name, roleId)

		const next: Policy.StoredCustomRole = {
			...current,
			name: request.name ?? current.name,
			description: request.description ?? current.description,
			permissions:
				request.permissions === undefined
					? current.permissions
					: Policy.encodePermissions(request.permissions),
			updatedAt: yield* Clock.currentTimeMillis,
		}
		const holders = holdersOf(memberships, roleId)
		// Every holder whose membership carries other codes, not only on a permission change: a
		// rewrite that failed half way is finished by the next save.
		const stale = Arr.filter(holders, (holder) =>
			Option.exists(heldCustomRole(holder), (held) => !sameCodes(held.permissions, next.permissions)),
		)
		yield* Effect.annotateCurrentSpan({ "maple.role.holders_rewritten": stale.length })
		const metadata: Policy.MembershipRoleMetadata = { id: roleId, permissions: next.permissions }
		// Holders before the definition: a retry after a failure here still sees the change to make.
		yield* Effect.forEach(
			stale,
			(holder) => clerk.setMembershipCustomRole(tenant.orgId, holder.userId, metadata),
			{ concurrency: 4, discard: true },
		)
		yield* clerk.writeCustomRoles(
			tenant.orgId,
			Arr.map(roles, (role) => (role.id === roleId ? next : role)),
		)
		const grants = customGrants(next.permissions)
		yield* Effect.forEach(stale, (holder) => demote(tenant.orgId, holder.userId, grants), {
			concurrency: 4,
			discard: true,
		})
		return { before: toCustomRole(current, holders.length), role: toCustomRole(next, holders.length) }
	})

	const deleteRole = Effect.fn("RolesService.delete")(function* (
		tenant: RolesTenant,
		roleId: Policy.CustomRoleId,
		reassignTo: RoleRef | undefined,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.role.id": roleId })
		const { roles, memberships } = yield* readState(tenant.orgId)
		const role = yield* findRole(roles, roleId)
		const holders = holdersOf(memberships, roleId)
		if (holders.length > 0) {
			if (reassignTo === undefined) {
				return yield* conflict("in_use", "Choose the role its members move to.")
			}
			if (reassignTo._tag === "Custom" && reassignTo.id === roleId) {
				return yield* conflict("in_use", "Its members must move to a different role.")
			}
			const target = yield* resolveTarget(roles, reassignTo)
			yield* Effect.forEach(holders, (holder) => assign(tenant.orgId, holder.userId, target), {
				concurrency: 4,
				discard: true,
			})
		}
		yield* clerk.writeCustomRoles(
			tenant.orgId,
			Arr.filter(roles, (candidate) => candidate.id !== roleId),
		)
		return { id: role.id, name: role.name, moved: holders.length }
	})

	const setMemberRole = Effect.fn("RolesService.setMemberRole")(function* (
		tenant: RolesTenant,
		userId: UserId,
		ref: RoleRef,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.role.member_id": userId })
		const { roles, memberships } = yield* readState(tenant.orgId)
		const member = yield* Effect.fromOption(
			Arr.findFirst(memberships, (membership) => membership.userId === userId),
			() => new RoleMemberNotFoundError({ userId, message: "No such member in this organization." }),
		)
		if (userId === tenant.userId) {
			return yield* conflict("self", "You cannot change your own role.")
		}
		const target = yield* resolveTarget(roles, ref)
		const admins = Arr.filter(memberships, (membership) => membership.role === ADMIN_CLERK_KEY)
		if (member.role === ADMIN_CLERK_KEY && target.clerkKey !== ADMIN_CLERK_KEY && admins.length <= 1) {
			return yield* conflict("last_admin", "An organization needs at least one Admin.")
		}
		yield* assign(tenant.orgId, userId, target)
		return {
			previousRole: Option.match(heldCustomRole(member), {
				onNone: () => member.role,
				onSome: (held) => held.id,
			}),
			member: new MemberRoleResponse({ userId, role: ref, permissions: target.grants }),
		}
	})

	return { list, members, create, update, delete: deleteRole, setMemberRole } satisfies RolesServiceApi
})

export class RolesService extends Context.Service<RolesService, RolesServiceApi>()(
	"@maple/backend/services/roles/RolesService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(ClerkRolesGateway.layer, MembershipRevocationService.layer)),
	)
}
