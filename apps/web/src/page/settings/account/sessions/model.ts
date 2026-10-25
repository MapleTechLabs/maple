import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "../../../../ui/dialog"

// The Active sessions tab.

export const SessionRow = Schema.Struct({
	id: Schema.String,
	device: Schema.String,
	location: Schema.String,
	isMobile: Schema.Boolean,
	lastActiveAtMs: Schema.Number,
})
export type SessionRow = typeof SessionRow.Type

/** `user.getSessions()` is imperative: loading, a failure with Clerk's message, or the list. */
export const LoadState = Schema.Union([
	Schema.TaggedStruct("Loading", {}),
	Schema.TaggedStruct("Failed", { message: Schema.String }),
	Schema.TaggedStruct("Ready", { sessions: Schema.Array(SessionRow) }),
])
export type LoadState = typeof LoadState.Type

export const Model = Schema.Struct({
	state: LoadState,
	currentSessionId: Schema.NullOr(Schema.String),
	revoking: Schema.NullOr(SessionRow),
	revokeDialog: Dialog.Model,
	isRevoking: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedLoad: {
		currentSessionId: Schema.NullOr(Schema.String),
		result: Schema.Result(Schema.Array(SessionRow), Schema.String),
	},
	ClickedRetry: {},
	ClickedSignOut: { session: SessionRow },
	GotRevokeDialogMessage: { message: Dialog.Message },
	ClickedConfirmSignOut: {},
	CompletedRevoke: { result: Schema.Result(Schema.Void, Schema.String) },
})
export type Message = typeof Message.Type
