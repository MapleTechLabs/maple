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
	type RoleKey,
	type RoleRef,
	RolesUnavailableError,
	type UpdateRoleRequest,
	type UserId,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Order,
	Random,
	Record as Rec,
	Ref,
	Result,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import {
	type MembershipRevocationError,
	MembershipRevocationService,
} from "@maple/backend/services/auth/MembershipRevocationService"
import { ClerkRolesGateway, type RoleMembership } from "./ClerkRolesGateway"
import { RoleWriteLock } from "./RoleWriteLock"

/**
 * Custom roles and who holds which role. Clerk is the store (`Policy.versionedCustomRolesFromOrgMetadata`):
 * the definitions sit in the organization's public metadata, and an `org:custom` member carries the
 * role's id and a copy of its permissions on their membership. Every write that can narrow what
 * someone holds ends with `demoteMembership`, so pinned credentials and membership caches follow at
 * once rather than when Clerk's webhook arrives.
 *
 * Clerk has no locks, so every write holds the org's {@link RoleWriteLock} while it reads and
 * writes Clerk. A change made outside Maple (Clerk's dashboard) can still land in between: the
 * definitions carry a version that every write checks and bumps (`editRoles`), and every write to a
 * role or onto one ends by reconciling its holders with the latest stored definition
 * (`reconcileHolders`).
 */

/** What the roles endpoints read off the caller. */
export type RolesTenant = Pick<CurrentTenant.TenantContext, "orgId" | "userId">

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
		/** A custom role's id or a built-in role's name. */
		roleKey: RoleKey,
	) => Effect.Effect<RoleMembersResponse, RolesUnavailableError | RoleNotFoundError>
	readonly create: (
		tenant: RolesTenant,
		request: CreateRoleRequest,
	) => Effect.Effect<CustomRoleResponse, RolesUnavailableError | RoleConflictError>
	/** Holders whose membership then carries other permissions are rewritten, then demoted. */
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
	/**
	 * The permissions an `org:custom` membership holds, checked against the role it names: a role
	 * since deleted holds nothing and one since narrowed holds its current codes, and the membership is
	 * rewritten to match. For Clerk's webhook, so a role set outside Maple cannot revive stale codes.
	 */
	readonly settleMembership: (
		orgId: OrgId,
		userId: UserId,
		held: Policy.MembershipRoleMetadata,
	) => Effect.Effect<ReadonlyArray<Policy.Permission>, RolesUnavailableError>
}

/** How many times a write to the definitions is tried while other writes keep landing first. */
const MAX_EDIT_ATTEMPTS = 3

/** How many times holders are reconciled while the role keeps changing under them. */
const MAX_RECONCILE_PASSES = 3

/** How often one holder's rewrite is retried before the pass reports it. */
const HOLDER_RETRY = Schedule.max([Schedule.exponential("100 millis"), Schedule.recurs(2)])

/** What an `org:custom` member with no role on the membership holds. */
const NOTHING = Policy.grantsOf([Policy.CUSTOM_ROLE_CLERK_KEY], [])

/** A role a member can be moved to, resolved to what Clerk stores and what it grants. */
interface AssignTarget {
	readonly clerkKey: Policy.AssignableClerkRole
	/** The membership metadata for a custom role; `null` clears it for a built-in one. */
	readonly metadata: Policy.MembershipRoleMetadata | null
	readonly grants: Policy.Grants
}

/** The definitions to write, and what the edit answers. */
interface RolesEdit<A> {
	readonly next: ReadonlyArray<Policy.StoredCustomRole>
	readonly result: A
}

const conflict = (reason: RoleConflictError["reason"], message: string) =>
	new RoleConflictError({ reason, message })

const concurrentEdit = conflict(
	"concurrent_edit",
	"Another admin changed the roles at the same time. Try again.",
)

/** A write that raced another one, worth retrying; a save from a stale editor is not. */
const isConcurrentEdit = (error: unknown): boolean => error === concurrentEdit

const staleEdit = conflict(
	"concurrent_edit",
	"Another admin saved this role after you opened it. Reload to see their changes, then edit again.",
)

const sameRole = Schema.toEquivalence(Policy.StoredCustomRole)

const sameStoredRole = Option.makeEquivalence(sameRole)

/** The roles two definition lists disagree on: in one only, or stored differently. */
const disagreeing = (
	a: ReadonlyArray<Policy.StoredCustomRole>,
	b: ReadonlyArray<Policy.StoredCustomRole>,
): ReadonlyArray<Policy.CustomRoleId> => {
	const differs = (
		from: ReadonlyArray<Policy.StoredCustomRole>,
		to: ReadonlyArray<Policy.StoredCustomRole>,
	) => Arr.filter(from, (role) => !Arr.some(to, (other) => sameRole(role, other)))
	return Arr.dedupe(Arr.map([...differs(a, b), ...differs(b, a)], (role) => role.id))
}

const notFound = (roleId: Policy.CustomRoleId) => new RoleNotFoundError({ roleId, message: "No such role." })

const revocationUnavailable = (error: MembershipRevocationError) =>
	new RolesUnavailableError({ message: "Could not apply the role change to credentials", cause: error })

const isAdmin = (clerkKey: string): boolean =>
	Option.exists(Policy.builtInRoleOf(clerkKey), (role) => role.role === "admin")

/** What a custom role's stored codes grant, in catalog order. */
const customGrants = (codes: ReadonlyArray<number>): Policy.Grants =>
	Policy.grantsOf([Policy.CUSTOM_ROLE_CLERK_KEY], Policy.decodeCustomPermissions(codes))

const builtInTarget = (ref: Extract<RoleRef, { _tag: "BuiltIn" }>): AssignTarget => ({
	clerkKey: ref.clerkKey,
	metadata: null,
	grants: Policy.grantsOf([ref.clerkKey]),
})

const customTarget = (role: Policy.StoredCustomRole) =>
	({
		clerkKey: Policy.CUSTOM_ROLE_CLERK_KEY,
		metadata: { id: role.id, permissions: role.permissions },
		grants: customGrants(role.permissions),
	}) satisfies AssignTarget

/** The custom role an `org:custom` membership names. */
const heldCustomRole = (membership: RoleMembership): Option.Option<Policy.MembershipRoleMetadata> =>
	membership.role === Policy.CUSTOM_ROLE_CLERK_KEY
		? Policy.membershipRoleFromMetadata(membership.metadata)
		: Option.none()

const holdersOf = (memberships: ReadonlyArray<RoleMembership>, roleId: Policy.CustomRoleId) =>
	Arr.filter(memberships, (membership) =>
		Option.exists(heldCustomRole(membership), (held) => held.id === roleId),
	)

const toMember = (holder: RoleMembership) =>
	new RoleMemberResponse({
		userId: holder.userId,
		name: holder.name,
		identifier: holder.identifier,
		imageUrl: holder.imageUrl,
	})

/** How many holders a role's row shows as avatars before "+N". */
const HOLDER_PREVIEW = 5

const previewOf = (holders: ReadonlyArray<RoleMembership>) =>
	Arr.map(Arr.take(holders, HOLDER_PREVIEW), toMember)

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

const findRole = (roles: ReadonlyArray<Policy.StoredCustomRole>, roleId: Policy.CustomRoleId) =>
	Effect.fromOption(
		Arr.findFirst(roles, (role) => role.id === roleId),
		() => notFound(roleId),
	)

const resolveTarget = (roles: ReadonlyArray<Policy.StoredCustomRole>, ref: RoleRef) =>
	ref._tag === "BuiltIn"
		? Effect.succeed<AssignTarget>(builtInTarget(ref))
		: Effect.map(findRole(roles, ref.id), (role): AssignTarget => customTarget(role))

/** roles:manage is Admin's alone, so the caller holds every permission; only the grantable ones are a question. */
const checkGrantable = (permissions: ReadonlyArray<Policy.Permission>) =>
	Arr.every(permissions, Policy.grantableToCustomRoles)
		? Effect.void
		: Effect.fail(conflict("not_grantable", "Members, roles and the organization stay with Admin."))

const checkName = (
	roles: ReadonlyArray<Policy.StoredCustomRole>,
	name: string,
	except?: Policy.CustomRoleId,
) => {
	const wanted = Str.toLowerCase(name)
	const taken =
		Arr.some(Policy.builtInRoles, (role) => Str.toLowerCase(role.label) === wanted) ||
		Arr.some(roles, (role) => role.id !== except && Str.toLowerCase(role.name) === wanted)
	return taken ? Effect.fail(conflict("name_taken", `A role named ${name} already exists.`)) : Effect.void
}

const make = Effect.gen(function* () {
	const clerk = yield* ClerkRolesGateway
	const revocation = yield* MembershipRevocationService
	const lock = yield* RoleWriteLock

	const readState = (orgId: OrgId) =>
		Effect.all(
			{
				roles: Effect.map(clerk.customRoles(orgId), (stored) => stored.roles),
				memberships: clerk.memberships(orgId),
			},
			{ concurrency: 2 },
		)

	/**
	 * Write the definitions `edit` derives from the list Clerk holds. Clerk has no conditional write,
	 * so the version is re-read just before writing, and the list read back after: two writers can
	 * both pass the version check, and the later write drops the earlier. When another write landed
	 * first, or a role this edit changed is not stored as written, the holders of every role the two
	 * lists disagree on are brought in line with what Clerk holds and the edit is redone from the
	 * fresh list, at most {@link MAX_EDIT_ATTEMPTS} times in all. A later write that kept this one's
	 * changes is not a loss. This narrows the race; it cannot close it.
	 */
	const editRoles = <A, E>(
		orgId: OrgId,
		edit: (roles: ReadonlyArray<Policy.StoredCustomRole>) => Effect.Effect<RolesEdit<A>, E>,
	) =>
		Effect.gen(function* () {
			const { version, roles } = yield* clerk.customRoles(orgId)
			const { next, result } = yield* edit(roles)
			const latest = yield* clerk.customRoles(orgId)
			if (latest.version !== version) return yield* concurrentEdit
			yield* clerk.writeCustomRoles(orgId, { version: version + 1, roles: next })
			const stored = yield* clerk.customRoles(orgId)
			const differing = disagreeing(next, stored.roles)
			if (Arr.some(disagreeing(roles, next), (roleId) => Arr.contains(differing, roleId))) {
				yield* Effect.forEach(differing, (roleId) => reconcileHolders(orgId, roleId, undefined), {
					discard: true,
				})
				return yield* concurrentEdit
			}
			return result
		}).pipe(Effect.retry({ times: MAX_EDIT_ATTEMPTS - 1, while: isConcurrentEdit }))

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

	/**
	 * One pass of {@link reconcileHolders}: the holders of `roleId` take the codes of the definition
	 * read together with them. Holders carrying other codes are rewritten and demoted, not only after a
	 * permission change: a rewrite that failed half way is finished by the next save. If the role is
	 * gone its holders move to `orphansTo`; with none, or when that is gone too, they keep `org:custom`
	 * with nothing on the membership, which holds nothing. Any built-in role could be more access than
	 * the role that vanished.
	 */
	const reconcilePass = (orgId: OrgId, roleId: Policy.CustomRoleId, orphansTo: RoleRef | undefined) =>
		Effect.gen(function* () {
			const { roles, memberships } = yield* readState(orgId)
			const holders = holdersOf(memberships, roleId)
			const role = Arr.findFirst(roles, (candidate) => candidate.id === roleId)
			if (Option.isSome(role)) {
				const target = customTarget(role.value)
				const stale = Arr.filter(holders, (holder) =>
					Option.exists(
						heldCustomRole(holder),
						(held) => !sameCodes(held.permissions, role.value.permissions),
					),
				)
				yield* Effect.annotateCurrentSpan({ "maple.role.holders_rewritten": stale.length })
				// One holder Clerk refuses must not leave the rest on the old codes: each is retried on
				// its own, every one is tried, and only then does a failure fail the pass.
				const results = yield* Effect.forEach(
					stale,
					(holder) =>
						Effect.result(
							clerk
								.setMembershipCustomRole(orgId, holder.userId, target.metadata)
								.pipe(
									Effect.andThen(demote(orgId, holder.userId, target.grants)),
									Effect.retry(HOLDER_RETRY),
								),
						),
					{ concurrency: 4 },
				)
				const failed = Arr.filter(results, Result.isFailure)
				if (failed.length > 0) {
					yield* Effect.annotateCurrentSpan({ "maple.role.holders_failed": failed.length })
					return yield* new RolesUnavailableError({
						message: `${failed.length} of ${stale.length} members still hold this role's previous permissions. Save the role again to finish.`,
						cause: failed[0]?.failure,
					})
				}
				return { role, holders: holders.length }
			}
			const target =
				orphansTo === undefined
					? Option.none<AssignTarget>()
					: yield* Effect.option(resolveTarget(roles, orphansTo))
			yield* Effect.annotateCurrentSpan({ "maple.role.holders_moved": holders.length })
			yield* Effect.forEach(
				holders,
				(holder) =>
					Option.match(target, {
						// Already `org:custom`: clearing the membership's role leaves them holding nothing.
						onNone: () =>
							clerk
								.setMembershipCustomRole(orgId, holder.userId, null)
								.pipe(Effect.andThen(demote(orgId, holder.userId, NOTHING))),
						onSome: (to) => assign(orgId, holder.userId, to),
					}),
				{ concurrency: 4, discard: true },
			)
			return { role, holders: holders.length }
		})

	/**
	 * Bring the holders of `roleId` in line with the definition Clerk holds. Every write to a role or
	 * onto one ends here. A pass writes the codes it read, so a save that narrowed the role in between
	 * would be undone by it: the definition is read again after the pass, and while it no longer matches
	 * the one applied the pass is redone, at most {@link MAX_RECONCILE_PASSES} times.
	 */
	const reconcileHolders = Effect.fn("RolesService.reconcileHolders")(function* (
		orgId: OrgId,
		roleId: Policy.CustomRoleId,
		orphansTo: RoleRef | undefined,
	) {
		const passes = yield* Ref.make(0)
		const settledPass = Effect.gen(function* () {
			yield* Ref.update(passes, (count) => count + 1)
			const result = yield* reconcilePass(orgId, roleId, orphansTo)
			const { roles } = yield* clerk.customRoles(orgId)
			const now = Arr.findFirst(roles, (candidate) => candidate.id === roleId)
			return sameStoredRole(now, result.role) ? result : yield* concurrentEdit
		})
		const result = yield* settledPass.pipe(
			Effect.retry({ times: MAX_RECONCILE_PASSES - 1, while: isConcurrentEdit }),
			Effect.tapError((error) =>
				isConcurrentEdit(error)
					? Effect.logWarning("Role holders did not settle while the role kept changing").pipe(
							Effect.annotateLogs({ orgId, "maple.role.id": roleId }),
						)
					: Effect.void,
			),
		)
		yield* Effect.annotateCurrentSpan({ "maple.role.reconcile_passes": yield* Ref.get(passes) })
		return result
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
			holders: {
				...Rec.fromEntries(
					Arr.map(Policy.builtInRoles, (role) => [
						role.role,
						previewOf(Arr.filter(memberships, (membership) => membership.role === role.clerkKey)),
					]),
				),
				...Rec.fromEntries(
					Arr.map(roles, (role) => [role.id, previewOf(holdersOf(memberships, role.id))]),
				),
			},
		})
	})

	const members = Effect.fn("RolesService.members")(function* (tenant: RolesTenant, roleKey: RoleKey) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.role.id": roleKey })
		const { roles, memberships } = yield* readState(tenant.orgId)
		const holders = Schema.is(Policy.CustomRoleId)(roleKey)
			? yield* Effect.as(findRole(roles, roleKey), holdersOf(memberships, roleKey))
			: Arr.filter(memberships, (membership) =>
					Option.exists(Policy.builtInRoleOf(membership.role), (role) => role.role === roleKey),
				)
		return new RoleMembersResponse({ members: Arr.map(holders, toMember) })
	})

	const createUnlocked = Effect.fn("RolesService.create")(function* (
		tenant: RolesTenant,
		request: CreateRoleRequest,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
		yield* checkGrantable(request.permissions)
		const role = yield* editRoles(tenant.orgId, (roles) =>
			Effect.gen(function* () {
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
					permissions: Policy.encodePermissions(Policy.withImplied(request.permissions)),
					createdAt: now,
					updatedAt: now,
				}
				return { next: [...roles, role], result: role }
			}),
		)
		yield* Effect.annotateCurrentSpan({ "maple.role.id": role.id })
		return toCustomRole(role, 0)
	})

	const updateUnlocked = Effect.fn("RolesService.update")(function* (
		tenant: RolesTenant,
		roleId: Policy.CustomRoleId,
		request: UpdateRoleRequest,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.role.id": roleId })
		yield* checkGrantable(request.permissions)
		const { before, after } = yield* editRoles(tenant.orgId, (roles) =>
			Effect.gen(function* () {
				const current = yield* findRole(roles, roleId)
				const permissions = Policy.encodePermissions(Policy.withImplied(request.permissions))
				// A save repeated after its holders failed to update finds its own definition stored:
				// it writes nothing and goes on to finish the holders.
				const alreadySaved =
					current.name === request.name &&
					current.description === request.description &&
					sameCodes(current.permissions, permissions)
				if (alreadySaved) return { next: roles, result: { before: current, after: current } }
				if (current.updatedAt !== request.expectedUpdatedAt) return yield* staleEdit
				yield* checkName(roles, request.name, roleId)
				const next: Policy.StoredCustomRole = {
					...current,
					name: request.name,
					description: request.description,
					permissions,
					updatedAt: yield* Clock.currentTimeMillis,
				}
				return {
					next: Arr.map(roles, (role) => (role.id === roleId ? next : role)),
					result: { before: current, after: next },
				}
			}),
		)
		// After the definition, so a member put on the role meanwhile with its old codes is caught.
		const { holders } = yield* reconcileHolders(tenant.orgId, roleId, undefined)
		return { before: toCustomRole(before, holders), role: toCustomRole(after, holders) }
	})

	const deleteUnlocked = Effect.fn("RolesService.delete")(function* (
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
			// From the read just made, right before the move: a target deleted since is a 404.
			const target = yield* resolveTarget(roles, reassignTo)
			yield* Effect.forEach(holders, (holder) => assign(tenant.orgId, holder.userId, target), {
				concurrency: 4,
				discard: true,
			})
		}
		yield* editRoles(tenant.orgId, (current) =>
			Effect.succeed({
				next: Arr.filter(current, (candidate) => candidate.id !== roleId),
				result: undefined,
			}),
		)
		// Members put on the role while it was removed follow the others, to nothing if none was named.
		const late = yield* reconcileHolders(tenant.orgId, roleId, reassignTo)
		const moved = holders.length + late.holders
		// The target may have changed, or gone, while its new members arrived.
		if (reassignTo?._tag === "Custom" && moved > 0) {
			const settled = yield* reconcileHolders(tenant.orgId, reassignTo.id, undefined)
			if (Option.isNone(settled.role)) return yield* notFound(reassignTo.id)
		}
		return { id: role.id, name: role.name, moved }
	})

	const setMemberRoleUnlocked = Effect.fn("RolesService.setMemberRole")(function* (
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
		const admins = Arr.filter(memberships, (membership) => isAdmin(membership.role))
		if (isAdmin(member.role) && !isAdmin(target.clerkKey) && admins.length <= 1) {
			return yield* conflict("last_admin", "An organization needs at least one Admin.")
		}
		yield* assign(tenant.orgId, userId, target)
		// The custom role may have changed, or gone, while the member moved onto it.
		const grants =
			ref._tag === "Custom"
				? yield* reconcileHolders(tenant.orgId, ref.id, undefined).pipe(
						Effect.flatMap(({ role }) => Effect.fromOption(role, () => notFound(ref.id))),
						Effect.map((role) => customTarget(role).grants),
					)
				: target.grants
		return {
			previousRole: Option.match(heldCustomRole(member), {
				onNone: () => member.role,
				onSome: (held) => held.id,
			}),
			member: new MemberRoleResponse({ userId, role: ref, permissions: grants }),
		}
	})

	// Every write holds the org's lock, so the checks it makes (a name, the version, the last Admin)
	// still hold when it writes.
	const create: RolesServiceApi["create"] = (tenant, request) =>
		lock.withLock(tenant.orgId, createUnlocked(tenant, request))
	const update: RolesServiceApi["update"] = (tenant, roleId, request) =>
		lock.withLock(tenant.orgId, updateUnlocked(tenant, roleId, request))
	const deleteRole: RolesServiceApi["delete"] = (tenant, roleId, reassignTo) =>
		lock.withLock(tenant.orgId, deleteUnlocked(tenant, roleId, reassignTo))
	const setMemberRole: RolesServiceApi["setMemberRole"] = (tenant, userId, ref) =>
		lock.withLock(tenant.orgId, setMemberRoleUnlocked(tenant, userId, ref))

	const settleUnlocked = Effect.fn("RolesService.settleMembership")(function* (
		orgId: OrgId,
		userId: UserId,
		held: Policy.MembershipRoleMetadata,
	) {
		yield* Effect.annotateCurrentSpan({ orgId, "maple.role.member_id": userId })
		const { roles } = yield* clerk.customRoles(orgId)
		const role = Arr.findFirst(roles, (candidate) => candidate.id === held.id)
		if (Option.isNone(role)) {
			yield* Effect.annotateCurrentSpan({ "maple.role.settled": "cleared" })
			yield* clerk.setMembershipCustomRole(orgId, userId, null)
			return []
		}
		if (!sameCodes(held.permissions, role.value.permissions)) {
			yield* Effect.annotateCurrentSpan({ "maple.role.settled": "rewritten" })
			yield* clerk.setMembershipCustomRole(orgId, userId, customTarget(role.value).metadata)
		}
		return Policy.decodeCustomPermissions(role.value.permissions)
	})

	const settleMembership: RolesServiceApi["settleMembership"] = (orgId, userId, held) =>
		lock.withLock(orgId, settleUnlocked(orgId, userId, held))

	return {
		list,
		members,
		create,
		update,
		delete: deleteRole,
		setMemberRole,
		settleMembership,
	} satisfies RolesServiceApi
})

export class RolesService extends Context.Service<RolesService, RolesServiceApi>()(
	"@maple/backend/services/roles/RolesService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(ClerkRolesGateway.layer, MembershipRevocationService.layer, RoleWriteLock.layer),
		),
	)
}
