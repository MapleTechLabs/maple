import { CustomRoleResponse, RoleListResponse, RoleMembersResponse } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as Select from "@maple/views/ui/select"
import * as Tabs from "@maple/views/ui/tabs"
import { SessionGrants } from "../../kit/session-grants"
import * as CreateDialog from "../roles/create-dialog"
import { PermissionFilter } from "./model"

export const Message = defineMessageUnion({
	CompletedFetchSession: SessionGrants,
	CompletedFetchRoles: { result: Schema.Result(RoleListResponse, LoadFailure) },
	CompletedFetchMembers: { result: Schema.Result(RoleMembersResponse, LoadFailure) },
	ClickedRetry: {},
	ChangedName: { value: Schema.String },
	ChangedDescription: { value: Schema.String },
	ToggledPermission: { permission: Policy.PermissionName },
	ToggledLimit: {},
	GotNamespacesMessage: { message: Combobox.Message },
	CompletedFetchNamespaces: { result: Schema.Result(Schema.Array(Schema.String), LoadFailure) },
	ToggledGroup: { group: Schema.String },
	ChangedFilter: { value: Schema.String },
	ClearedFilter: {},
	ChangedShow: { show: PermissionFilter },
	GotCompareMessage: { message: Select.Message },
	GotTabsMessage: { message: Tabs.Message },
	ClickedDiscard: {},
	ClickedSave: {},
	CompletedSave: { result: Schema.Result(CustomRoleResponse, LoadFailure) },
	ClickedDuplicate: {},
	GotCreateMessage: { message: CreateDialog.Message },
})
export type Message = typeof Message.Type
