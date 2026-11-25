import { RoleListResponse, RoleMembersResponse } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import * as CreateDialog from "./create-dialog"

// The Roles tab: the built-in roles and the organization's own, with the create and delete dialogs.

export const RoleListData = AsyncData.Schema(RoleListResponse, LoadFailure)
export const RoleMembersData = AsyncData.Schema(RoleMembersResponse, LoadFailure)

export const Model = Schema.Struct({
	grants: Schema.Array(Policy.PermissionName),
	list: RoleListData.schema,
	rowMenus: Schema.Record(Schema.String, Menu.Model),
	create: CreateDialog.Model,
	/** The custom role on the delete dialog. */
	deleting: Schema.NullOr(
		Schema.Struct({ id: Policy.CustomRoleId, name: Schema.String, memberCount: Schema.Number }),
	),
	deleteDialog: Dialog.Model,
	/** Who holds the role being deleted, read when the dialog opens on a role someone holds. */
	deleteMembers: RoleMembersData.schema,
	/** Where the deleted role's members move, a role key. */
	reassignTo: Select.Model,
	isDeleting: Schema.Boolean,
})
export type Model = typeof Model.Type

/** The viewer may create, change and delete roles (`roles:manage`). */
export const canManageRoles = (model: Pick<Model, "grants">): boolean =>
	Policy.can(model.grants, "roles:manage")

export const Message = defineMessageUnion({
	CompletedFetchRoles: { result: Schema.Result(RoleListResponse, LoadFailure) },
	ClickedRetry: {},
	ClickedCreate: {},
	GotCreateMessage: { message: CreateDialog.Message },
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	GotDeleteDialogMessage: { message: Dialog.Message },
	CompletedFetchDeleteMembers: {
		roleId: Policy.CustomRoleId,
		result: Schema.Result(RoleMembersResponse, LoadFailure),
	},
	GotReassignMessage: { message: Select.Message },
	ClickedConfirmDelete: {},
	CompletedDelete: { name: Schema.String, result: Schema.Result(Schema.Void, LoadFailure) },
})
export type Message = typeof Message.Type
