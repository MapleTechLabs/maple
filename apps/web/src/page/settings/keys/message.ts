import { ApiKeyId } from "@maple/domain/http"
import { V2ApiKey } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Select from "../../../ui/select"
import * as CreateDialog from "./create-dialog"
import { KeyTypeFilter } from "./model"
import * as RollDialog from "./roll-dialog"

export const Message = defineMessageUnion({
	UpdatedApiKeys: { rows: Schema.Array(V2ApiKey) },
	FailedLoadApiKeys: {},
	ClickedRetryLoad: {},
	ClickedTypeFilter: { type: KeyTypeFilter },
	GotStatusSelectMessage: { message: Select.Message },
	ChangedSearch: { value: Schema.String },
	ClickedClearSearch: {},
	ClickedCreateKey: {},
	GotCreateMenuMessage: { message: Menu.Message },
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	GotRevokeDialogMessage: { message: Dialog.Message },
	ClickedConfirmRevoke: {},
	CompletedRevoke: { id: ApiKeyId, result: Schema.Result(Schema.Void, LoadFailure) },
	GotRollMessage: { message: RollDialog.Message },
	GotCreateMessage: { message: CreateDialog.Message },
	GotBaseUrlCopyMessage: { message: CopyButton.Message },
	ToggledScopes: {},
})
export type Message = typeof Message.Type
