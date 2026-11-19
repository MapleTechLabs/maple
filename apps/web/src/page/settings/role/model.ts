import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Select from "@maple/views/ui/select"
import * as Tabs from "@maple/views/ui/tabs"
import * as CreateDialog from "../roles/create-dialog"
import { RoleListData } from "../roles/model"

// `/settings/roles/:roleId`: one role's name, description, permissions and holders. A custom role
// is edited in drafts until Save; a built-in role opens read-only.

/** Someone who holds the role. */
export const RoleMember = Schema.Struct({
	userId: Schema.String,
	name: Schema.String,
	identifier: Schema.String,
	imageUrl: Schema.String,
})
export type RoleMember = typeof RoleMember.Type

export const RoleMembersData = AsyncData.Schema(Schema.Array(RoleMember), LoadFailure)

/** Which permissions the list shows: all, the ones the draft holds, or the sensitive ones. */
export const PermissionFilter = Schema.Literals(["all", "granted", "sensitive"])
export type PermissionFilter = typeof PermissionFilter.Type

export const EditorTab = Schema.Literals(["permissions", "members"])
export type EditorTab = typeof EditorTab.Type

export const Model = Schema.Struct({
	/** The route's role: a custom role's id or a built-in role's name. */
	roleKey: Schema.String,
	grants: Schema.Array(Policy.PermissionName),
	list: RoleListData.schema,
	members: RoleMembersData.schema,
	/** The drafts, filled from the role once the list answers (`isDraftLoaded`). */
	name: Schema.String,
	description: Schema.String,
	permissions: Schema.Array(Policy.PermissionName),
	isDraftLoaded: Schema.Boolean,
	tabs: Tabs.Model,
	filter: Schema.String,
	show: PermissionFilter,
	/** The role the permissions are compared with, a role key. */
	compare: Select.Model,
	collapsedGroups: Schema.Array(Schema.String),
	isSaving: Schema.Boolean,
	create: CreateDialog.Model,
})
export type Model = typeof Model.Type

/** The viewer may change roles (`roles:manage`). */
export const canManageRoles = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "roles:manage")
