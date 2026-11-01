import { Schema } from "effect"
import { File } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "../../../../ui/dialog"
import { AccountUser } from "../user"

// The Profile tab.

/** Name edits tagged with the user they were typed against, so a user switch drops them. */
export const NameDraft = Schema.Struct({ userId: Schema.String, firstName: Schema.String, lastName: Schema.String })

export const Model = Schema.Struct({
	isLoaded: Schema.Boolean,
	/** `null` signed out (the skeleton stays). */
	user: Schema.NullOr(AccountUser),
	draft: Schema.NullOr(NameDraft),
	isSavingName: Schema.Boolean,
	isSavingAvatar: Schema.Boolean,
	isDragging: Schema.Boolean,
	deleteDialog: Dialog.Model,
	confirmText: Schema.String,
	isDeleting: Schema.Boolean,
})
export type Model = typeof Model.Type

const done = { result: Schema.Result(Schema.Void, Schema.String) }

export const Message = defineMessageUnion({
	CompletedReadUser: { user: Schema.NullOr(AccountUser) },
	ChangedFirstName: { value: Schema.String },
	ChangedLastName: { value: Schema.String },
	ClickedSaveName: {},
	ClickedDiscardName: {},
	CompletedSaveName: done,
	ClickedPickAvatar: {},
	CompletedPickAvatar: {},
	DraggedOverAvatar: {},
	LeftAvatar: {},
	PickedAvatar: { files: Schema.Array(File.File) },
	ClickedRemoveAvatar: {},
	CompletedSetAvatar: { isRemoved: Schema.Boolean, ...done },
	ClickedDelete: {},
	GotDeleteDialogMessage: { message: Dialog.Message },
	ChangedConfirmText: { value: Schema.String },
	ClickedConfirmDelete: {},
	CompletedDelete: done,
})
export type Message = typeof Message.Type
