import { McpToolCatalogEntry } from "@maple/domain/http"
import { McpConnectionPublicId, V2McpConnection } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Tabs from "../../../ui/tabs"
import * as CreateKey from "../keys/create-dialog"

export const Message = defineMessageUnion({
	CompletedFetchConnections: { result: Schema.Result(Schema.Array(V2McpConnection), LoadFailure) },
	CompletedFetchTools: { result: Schema.Result(Schema.Array(McpToolCatalogEntry), LoadFailure) },
	GotClientTabsMessage: { message: Tabs.Message },
	GotServerUrlCopyMessage: { message: CopyButton.Message },
	GotSnippetCopyMessage: { snippet: Schema.String, message: CopyButton.Message },
	ClickedCreateMcpKey: {},
	GotCreateKeyMessage: { message: CreateKey.Message },
	ClickedRevoke: { connectionId: McpConnectionPublicId },
	GotRevokeDialogMessage: { message: Dialog.Message },
	ClickedConfirmRevoke: {},
	CompletedRevoke: { result: Schema.Result(Schema.Void, LoadFailure) },
	ChangedToolSearch: { value: Schema.String },
	ClickedClearToolSearch: {},
	ToggledToolGroup: { groupId: Schema.String },
	ClickedShowAllTools: { groupId: Schema.String },
})
export type Message = typeof Message.Type
