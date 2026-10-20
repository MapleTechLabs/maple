import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "../../../../ui/dialog"
import * as Menu from "../../../../ui/menu"
import { AccountPasskey, AccountUser } from "../user"

// The Passkeys tab.

export const Model = Schema.Struct({
	isLoaded: Schema.Boolean,
	user: Schema.NullOr(AccountUser),
	/** `isWebAuthnSupported()`: `PublicKeyCredential` on `window`. */
	isSupported: Schema.Boolean,
	isBusy: Schema.Boolean,
	rowMenus: Schema.Record(Schema.String, Menu.Model),
	renaming: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
	renameDialog: Dialog.Model,
	removing: Schema.NullOr(AccountPasskey),
	removeDialog: Dialog.Model,
})
export type Model = typeof Model.Type

const done = { result: Schema.Result(Schema.Void, Schema.String) }

export const Message = defineMessageUnion({
	CompletedReadUser: { user: Schema.NullOr(AccountUser), isSupported: Schema.Boolean },
	ClickedAdd: {},
	CompletedCreate: done,
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	GotRenameDialogMessage: { message: Dialog.Message },
	ChangedName: { value: Schema.String },
	SubmittedRename: {},
	CompletedRename: done,
	GotRemoveDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemove: {},
	CompletedRemove: done,
})
export type Message = typeof Message.Type
