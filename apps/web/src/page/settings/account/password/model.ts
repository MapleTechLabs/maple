import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { AccountUser } from "../user"

// The Password tab.

export const PasswordField = Schema.Literals(["current", "next", "confirm"])
export type PasswordField = typeof PasswordField.Type

export const Model = Schema.Struct({
	isLoaded: Schema.Boolean,
	user: Schema.NullOr(AccountUser),
	current: Schema.String,
	next: Schema.String,
	confirm: Schema.String,
	isSigningOutOthers: Schema.Boolean,
	isSaving: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedReadUser: { user: Schema.NullOr(AccountUser) },
	ChangedPassword: { field: PasswordField, value: Schema.String },
	ToggledSignOutOthers: {},
	ClickedSubmit: {},
	CompletedSubmit: { hadPassword: Schema.Boolean, result: Schema.Result(Schema.Void, Schema.String) },
})
export type Message = typeof Message.Type
