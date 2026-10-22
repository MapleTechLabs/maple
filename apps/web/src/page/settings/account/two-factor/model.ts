import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as CopyButton from "../../../../ui/copy-button"
import * as Dialog from "../../../../ui/dialog"
import * as OtpField from "../../../../ui/otp-field"
import { AccountUser } from "../user"

// The Two-factor tab.

/**
 * Enrollment: scan the `createTOTP()` key, type a code, then the backup codes `verifyTOTP()`
 * returns, shown once.
 */
export const EnrollStep = Schema.Union([
	Schema.TaggedStruct("Scan", { uri: Schema.String, secret: Schema.String }),
	Schema.TaggedStruct("Verify", { uri: Schema.String, secret: Schema.String }),
	Schema.TaggedStruct("Codes", { codes: Schema.Array(Schema.String) }),
])
export type EnrollStep = typeof EnrollStep.Type

export const Model = Schema.Struct({
	isLoaded: Schema.Boolean,
	user: Schema.NullOr(AccountUser),
	isBusy: Schema.Boolean,
	enrollDialog: Dialog.Model,
	/** What the dialog shows; kept through its exit animation. */
	enroll: Schema.NullOr(EnrollStep),
	code: OtpField.Model,
	secretCopy: CopyButton.Model,
	codesCopy: CopyButton.Model,
	disableDialog: Dialog.Model,
})
export type Model = typeof Model.Type

const done = { result: Schema.Result(Schema.Void, Schema.String) }

export const Message = defineMessageUnion({
	CompletedReadUser: { user: Schema.NullOr(AccountUser) },
	ClickedSetUp: {},
	/** `null`: Clerk returned no setup key. */
	CompletedCreateTotp: {
		result: Schema.Result(
			Schema.NullOr(Schema.Struct({ uri: Schema.String, secret: Schema.String })),
			Schema.String,
		),
	},
	GotEnrollDialogMessage: { message: Dialog.Message },
	ClickedCancelEnroll: {},
	ClickedContinue: {},
	ClickedBack: {},
	GotCodeMessage: { message: OtpField.Message },
	ClickedVerify: {},
	CompletedVerify: { result: Schema.Result(Schema.Array(Schema.String), Schema.String) },
	ClickedSavedCodes: {},
	GotSecretCopyMessage: { message: CopyButton.Message },
	GotCodesCopyMessage: { message: CopyButton.Message },
	ClickedRegenerate: {},
	CompletedRegenerate: { result: Schema.Result(Schema.Array(Schema.String), Schema.String) },
	ClickedRemove: {},
	GotDisableDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemove: {},
	CompletedDisable: done,
})
export type Message = typeof Message.Type
