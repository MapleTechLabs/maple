import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	type CustomRoleResponse,
	MapleInternalApi,
	type RoleRef,
	RolesForbiddenError,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { RolesService } from "@maple/backend/services/roles/RolesService"
import { diffAuditChanges } from "@/routes/v2/audit-changes"

const requirePermission = (permission: Policy.Permission) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentTenant.Context
		yield* Policy.check(
			tenant.permissions,
			permission,
			(denial) => new RolesForbiddenError({ message: denial.message }),
		)
		return tenant
	})

/** How the audit log names a role: the Clerk key of a built-in one, the id of a custom one. */
const roleKey = (ref: RoleRef): string => (ref._tag === "BuiltIn" ? ref.clerkKey : ref.id)

/** What a role update can change, as the audit log diffs it. */
const auditedFields = (role: CustomRoleResponse) => ({
	name: role.name,
	description: role.description,
	permissions: role.permissions,
	namespaces: role.namespaces ?? [],
})

// Every member reads the roles (the Members page names each member's role); only Admin changes them.
export const HttpRolesLive = HttpApiBuilder.group(MapleInternalApi, "roles", (handlers) =>
	Effect.gen(function* () {
		const roles = yield* RolesService

		return handlers
			.handle("list", () => CurrentTenant.Context.pipe(Effect.flatMap(roles.list)))
			.handle("members", ({ params }) =>
				CurrentTenant.Context.pipe(Effect.flatMap((tenant) => roles.members(tenant, params.roleId))),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requirePermission("roles:manage")
					const role = yield* roles.create(tenant, payload)
					const namespaces = role.namespaces ?? []
					const created = {
						roleId: role.id,
						name: role.name,
						permissions: Arr.join(role.permissions, ","),
					}
					yield* recordHttpAudit("role.created", {
						metadata:
							namespaces.length === 0
								? created
								: { ...created, namespaces: Arr.join(namespaces, ",") },
					})
					return role
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requirePermission("roles:manage")
					const { before, role } = yield* roles.update(tenant, params.roleId, payload)
					yield* recordHttpAudit("role.updated", {
						changes: diffAuditChanges(auditedFields(before), auditedFields(role)),
						metadata: { roleId: role.id, name: role.name, memberCount: role.memberCount },
					})
					return role
				}),
			)
			.handle("delete", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requirePermission("roles:manage")
					const deleted = yield* roles.delete(tenant, params.roleId, payload.reassignTo)
					yield* recordHttpAudit("role.deleted", {
						metadata: {
							roleId: deleted.id,
							name: deleted.name,
							membersMoved: deleted.moved,
							...(deleted.moved > 0 && payload.reassignTo !== undefined
								? { reassignedTo: roleKey(payload.reassignTo) }
								: undefined),
						},
					})
				}),
			)
			.handle("setMemberRole", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requirePermission("members:manage")
					const change = yield* roles.setMemberRole(tenant, params.userId, payload.role)
					yield* recordHttpAudit("member.role_changed", {
						affectedUserId: params.userId,
						changes: diffAuditChanges(
							{ role: change.previousRole },
							{ role: roleKey(payload.role) },
						),
					})
					return change.member
				}),
			)
	}),
)
