import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { ServiceDeploys } from "../model-deploys"
import { Operation } from "../model-tabs"

export const Side = Schema.Literals(["before", "after"])
export type Side = typeof Side.Type

export const Message = defineMessageUnion({
	CompletedFetchOperations: {
		side: Side,
		key: Schema.String,
		result: Schema.Result(Schema.Array(Operation), LoadFailure),
	},
	CompletedFetchShipped: { key: Schema.String, result: Schema.Result(ServiceDeploys, LoadFailure) },
	ClickedRetry: {},
	GotDialogMessage: { message: Dialog.Message },
})
export type Message = typeof Message.Type

/** A close clears `deploy` from the URL. */
export const OutMessage = defineMessageUnion({ Closed: {} })
export type OutMessage = typeof OutMessage.Type
