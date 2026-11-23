import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { StatusPageId } from "@maple/domain"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { StatusPageSummary } from "../shared/derive"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	ComputedOrgKey: { orgKey: Schema.String },
	CompletedFetchSession: SessionGrants,
	CompletedFetchPages: { key: Schema.String, result: LoadOutcome(Schema.Array(StatusPageSummary)) },
	ClickedRetry: {},
	GotRowMenuMessage: { pageId: StatusPageId, message: Menu.Message },
	CompletedOpenPage: {},
	ClickedConfirmDelete: {},
	CompletedDelete: { result: LoadOutcome(Schema.Void) },
	GotDeleteDialogMessage: { message: Dialog.Message },
})
export type Message = typeof Message.Type
