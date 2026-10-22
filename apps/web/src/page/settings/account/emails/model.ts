import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "../../../../ui/dialog"
import * as Menu from "../../../../ui/menu"
import * as OtpField from "../../../../ui/otp-field"
import { AccountEmail, AccountUser } from "../user"

// The Email addresses tab.

/** The add flow: create the address, then verify the emailed code on that address. */
export const AddStep = Schema.Union([
	Schema.TaggedStruct("Email", { value: Schema.String }),
	Schema.TaggedStruct("Code", { addressId: Schema.String, email: Schema.String }),
])
export type AddStep = typeof AddStep.Type

export const Model = Schema.Struct({
	isLoaded: Schema.Boolean,
	user: Schema.NullOr(AccountUser),
	addDialog: Dialog.Model,
	add: AddStep,
	code: OtpField.Model,
	isBusy: Schema.Boolean,
	rowMenus: Schema.Record(Schema.String, Menu.Model),
	removing: Schema.NullOr(AccountEmail),
	removeDialog: Dialog.Model,
})
export type Model = typeof Model.Type

const done = { result: Schema.Result(Schema.Void, Schema.String) }

export const Message = defineMessageUnion({
	CompletedReadUser: { user: Schema.NullOr(AccountUser) },
	ClickedAdd: {},
	GotAddDialogMessage: { message: Dialog.Message },
	ChangedEmail: { value: Schema.String },
	SubmittedAdd: {},
	CompletedCreate: { result: Schema.Result(Schema.Struct({ addressId: Schema.String, email: Schema.String }), Schema.String) },
	GotCodeMessage: { message: OtpField.Message },
	CompletedVerify: done,
	CompletedPrepare: { addressId: Schema.String, email: Schema.String, ...done },
	CompletedSetPrimary: { email: Schema.String, ...done },
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	GotRemoveDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemove: {},
	CompletedRemove: done,
})
export type Message = typeof Message.Type
