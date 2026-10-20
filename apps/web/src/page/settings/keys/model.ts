import { V2ApiKey } from "@maple/domain/http/v2"
import { Schema } from "effect"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Select from "../../../ui/select"
import * as CreateDialog from "./create-dialog"
import * as RollDialog from "./roll-dialog"

// `ApiKeysSection`: API and MCP keys in one filterable list, the API reference and the create, roll
// and revoke flows.

export const KeyTypeFilter = Schema.Literals(["all", "api", "mcp"])
export type KeyTypeFilter = typeof KeyTypeFilter.Type
export const KeyStatusFilter = Schema.Literals(["active", "expired", "revoked"])
export type KeyStatusFilter = typeof KeyStatusFilter.Type

export const Model = Schema.Struct({
	isAdmin: Schema.Boolean,
	userId: Schema.NullOr(Schema.String),
	/** `useApiKeysList()`: `null` until the shape's first answer. */
	apiKeys: Schema.NullOr(Schema.Array(V2ApiKey)),
	/** The shape failed before its first answer: the list shows the sync error, not a skeleton. */
	isLoadFailed: Schema.Boolean,
	typeFilter: KeyTypeFilter,
	statusFilter: KeyStatusFilter,
	statusSelect: Select.Model,
	search: Schema.String,
	createMenu: Menu.Model,
	rowMenus: Schema.Record(Schema.String, Menu.Model),
	revokeDialog: Dialog.Model,
	revoking: Schema.NullOr(V2ApiKey),
	isRevoking: Schema.Boolean,
	roll: RollDialog.Model,
	create: CreateDialog.Model,
	baseUrlCopy: CopyButton.Model,
	isScopesOpen: Schema.Boolean,
})
export type Model = typeof Model.Type
