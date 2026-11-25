import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { UserId } from "@maple/primitives"
import {
	AssignableClerkRole,
	BuiltInClerkRole,
	BuiltInRoleName,
	CustomRoleDescription,
	CustomRoleId,
	CustomRoleName,
	PermissionName,
	RoleNamespaces,
} from "../policy"
import { EndpointAccess, requires } from "./endpoint-access"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

// Roles: the four built-in roles and the organization's custom roles. Definitions live in the Clerk
// organization's public metadata; a member on a custom role holds Clerk's `org:custom` role, with the
// role's id and permissions on their membership. Admins (`roles:manage`, `members:manage`) change
// them; everyone may read them, so the Members page can name every member's role.

/** Which role a member holds or moves to. */
export const RoleRef = Schema.Union([
	Schema.TaggedStruct("BuiltIn", { clerkKey: BuiltInClerkRole }),
	Schema.TaggedStruct("Custom", { id: CustomRoleId }),
])
export type RoleRef = typeof RoleRef.Type

/** A role as the Roles page addresses it: a custom role's id, or a built-in role's name. */
export const RoleKey = Schema.Union([CustomRoleId, BuiltInRoleName])
export type RoleKey = typeof RoleKey.Type

export class RoleMemberResponse extends Schema.Class<RoleMemberResponse>("RoleMemberResponse")({
	userId: UserId,
	name: Schema.NullOr(Schema.String),
	identifier: Schema.String,
	imageUrl: Schema.NullOr(Schema.String),
}) {}

export class BuiltInRoleResponse extends Schema.Class<BuiltInRoleResponse>("BuiltInRoleResponse")({
	clerkKey: AssignableClerkRole,
	label: Schema.String,
	summary: Schema.String,
	permissions: Schema.Array(PermissionName),
	memberCount: Schema.Number,
}) {}

export class CustomRoleResponse extends Schema.Class<CustomRoleResponse>("CustomRoleResponse")({
	id: CustomRoleId,
	name: Schema.String,
	description: Schema.String,
	permissions: Schema.Array(PermissionName),
	/** The `service.namespace` values the role is limited to; absent or empty when it reads every namespace. */
	namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
	memberCount: Schema.Number,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class RoleListResponse extends Schema.Class<RoleListResponse>("RoleListResponse")({
	builtIn: Schema.Array(BuiltInRoleResponse),
	/** By name. */
	custom: Schema.Array(CustomRoleResponse),
	/** How many custom roles the organization may define. */
	customRoleLimit: Schema.Number,
	/** The first few holders of each role, by role key, for the list's avatars; `memberCount` counts them all. */
	holders: Schema.Record(Schema.String, Schema.Array(RoleMemberResponse)),
}) {}

export class RoleMembersResponse extends Schema.Class<RoleMembersResponse>("RoleMembersResponse")({
	members: Schema.Array(RoleMemberResponse),
}) {}

export class CreateRoleRequest extends Schema.Class<CreateRoleRequest>("CreateRoleRequest")({
	name: CustomRoleName,
	description: Schema.optionalKey(CustomRoleDescription),
	permissions: Schema.Array(PermissionName),
	/** Limit the role to these namespaces. It then holds `telemetry:read_scoped`, not `telemetry:read`. */
	namespaces: Schema.optionalKey(RoleNamespaces),
}) {}

/** The whole role as the editor saves it. */
export class UpdateRoleRequest extends Schema.Class<UpdateRoleRequest>("UpdateRoleRequest")({
	name: CustomRoleName,
	description: CustomRoleDescription,
	permissions: Schema.Array(PermissionName),
	/** Empty lifts the limit. Absent keeps it, so an editor that predates namespaces cannot lift one. */
	namespaces: Schema.optionalKey(RoleNamespaces),
	/** The `updatedAt` the editor loaded: another save since is a `concurrent_edit`, not overwritten. */
	expectedUpdatedAt: Schema.Number,
}) {}

export class DeleteRoleRequest extends Schema.Class<DeleteRoleRequest>("DeleteRoleRequest")({
	/** Where the role's members move. Required while anyone holds the role. */
	reassignTo: Schema.optionalKey(RoleRef),
}) {}

export class SetMemberRoleRequest extends Schema.Class<SetMemberRoleRequest>("SetMemberRoleRequest")({
	role: RoleRef,
}) {}

export class MemberRoleResponse extends Schema.Class<MemberRoleResponse>("MemberRoleResponse")({
	userId: UserId,
	role: RoleRef,
	permissions: Schema.Array(PermissionName),
}) {}

export class RolesUnavailableError extends HttpTaggedError<RolesUnavailableError>()(
	"@maple/http/roles/RolesUnavailableError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
	{
		status: 503,
		code: "roles_unavailable",
		title: "Roles are temporarily unavailable",
		message: "Roles could not be read or changed right now. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class RolesForbiddenError extends HttpTaggedError<RolesForbiddenError>()(
	"@maple/http/roles/RolesForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "roles_forbidden",
		title: "Not allowed",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class RoleNotFoundError extends HttpTaggedError<RoleNotFoundError>()(
	"@maple/http/roles/RoleNotFoundError",
	{ message: Schema.String, roleId: CustomRoleId },
	{
		status: 404,
		code: "role_not_found",
		title: "Role not found",
		retry: "never",
		recovery: "refresh",
		exposure: "public_message",
	},
) {}

export class RoleMemberNotFoundError extends HttpTaggedError<RoleMemberNotFoundError>()(
	"@maple/http/roles/RoleMemberNotFoundError",
	{ message: Schema.String, userId: UserId },
	{
		status: 404,
		code: "role_member_not_found",
		title: "Member not found",
		retry: "never",
		recovery: "refresh",
		exposure: "public_message",
	},
) {}

/**
 * The request is well formed but cannot be done: a taken name, the role limit, a role still held,
 * a namespace-limited role given a permission that needs all telemetry, or other admins changing
 * the roles at the same moment.
 */
export class RoleConflictError extends HttpTaggedError<RoleConflictError>()(
	"@maple/http/roles/RoleConflictError",
	{
		message: Schema.String,
		reason: Schema.Literals([
			"name_taken",
			"limit_reached",
			"in_use",
			"not_grantable",
			"needs_all_telemetry",
			"last_admin",
			"self",
			"concurrent_edit",
		]),
	},
	{
		status: 409,
		code: "role_conflict",
		title: "Role change not possible",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

const roleErrors = [RolesUnavailableError, RolesForbiddenError, RoleNotFoundError, RoleConflictError]

/** Session only: roles describe people in the organization. */
export class RolesApiGroup extends HttpApiGroup.make("roles")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: RoleListResponse,
			error: RolesUnavailableError,
		}).annotate(EndpointAccess, "personal"),
	)
	.add(
		HttpApiEndpoint.get("members", "/:roleId/members", {
			params: { roleId: RoleKey },
			success: RoleMembersResponse,
			error: [RolesUnavailableError, RoleNotFoundError],
		}).annotate(EndpointAccess, "personal"),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CreateRoleRequest,
			success: CustomRoleResponse,
			error: roleErrors,
		}).annotate(EndpointAccess, requires("roles:manage")),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:roleId", {
			params: { roleId: CustomRoleId },
			payload: UpdateRoleRequest,
			success: CustomRoleResponse,
			error: roleErrors,
		}).annotate(EndpointAccess, requires("roles:manage")),
	)
	.add(
		HttpApiEndpoint.post("delete", "/:roleId/delete", {
			params: { roleId: CustomRoleId },
			payload: DeleteRoleRequest,
			success: Schema.Void,
			error: roleErrors,
		}).annotate(EndpointAccess, requires("roles:manage")),
	)
	.add(
		HttpApiEndpoint.put("setMemberRole", "/members/:userId", {
			params: { userId: UserId },
			payload: SetMemberRoleRequest,
			success: MemberRoleResponse,
			error: [...roleErrors, RoleMemberNotFoundError],
		}).annotate(EndpointAccess, requires("members:manage")),
	)
	.prefix("/internal/roles")
	.middleware(SessionAuthorization) {}
