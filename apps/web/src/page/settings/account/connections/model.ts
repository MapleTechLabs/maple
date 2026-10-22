import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "../../../../ui/dialog"
import { AccountUser } from "../user"

// The Connected accounts tab.

export const ProviderId = Schema.Literals(["google", "github"])
export type ProviderId = typeof ProviderId.Type

export const Model = Schema.Struct({
	isLoaded: Schema.Boolean,
	user: Schema.NullOr(AccountUser),
	/** The provider row whose round trip or disconnect is in flight. */
	busy: Schema.NullOr(ProviderId),
	removing: Schema.NullOr(Schema.Struct({ accountId: Schema.String, provider: ProviderId })),
	removeDialog: Dialog.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedReadUser: { user: Schema.NullOr(AccountUser) },
	ClickedConnect: { provider: ProviderId },
	ClickedRetry: { provider: ProviderId, accountId: Schema.String },
	/** `null` redirect: the provider gave no consent URL. */
	CompletedStart: {
		provider: ProviderId,
		result: Schema.Result(Schema.NullOr(Schema.String), Schema.String),
	},
	CompletedRedirect: {},
	ClickedDisconnect: { provider: ProviderId, accountId: Schema.String },
	GotRemoveDialogMessage: { message: Dialog.Message },
	ClickedConfirmDisconnect: {},
	CompletedDisconnect: { result: Schema.Result(Schema.Void, Schema.String) },
})
export type Message = typeof Message.Type
