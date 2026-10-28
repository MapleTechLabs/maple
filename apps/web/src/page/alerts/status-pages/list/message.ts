import { V2StatusPage } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import { StatusPageSummary } from "../../shared/status-page-derive"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Message = defineMessageUnion({
	CompletedFetchPages: { key: Schema.String, result: outcome(Schema.Array(StatusPageSummary)) },
	ClickedRetry: {},
	ClickedNew: {},
	ChangedName: { value: Schema.String },
	ChangedSlug: { value: Schema.String },
	SubmittedCreate: {},
	CompletedCreate: { result: outcome(V2StatusPage) },
	GotCreateDialogMessage: { message: Dialog.Message },
})
export type Message = typeof Message.Type
