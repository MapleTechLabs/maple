import { Effect, Result, Schema } from "effect"
import { Command } from "foldkit"
import * as CopyButton from "../../../../ui/copy-button"
import * as Dialog from "../../../../ui/dialog"
import * as OtpField from "../../../../ui/otp-field"
import { PageOutMessage, type PageReturn } from "../../../contract"
import { settled, withUser, withUserReverified } from "../clerk-write"
import { initCode, isComplete } from "../code-field"
import { readAccountUser } from "../user"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

const CODE_ID = "account-totp-code"

const ReadTwoFactorUser = Command.define("ReadTwoFactorUser", {
	messages: [Message.CompletedReadUser],
	execute: Effect.map(readAccountUser, (user) => Message.CompletedReadUser({ user })),
})

const toMessageResult =
	<A, B>(toMessage: (result: Result.Result<A, string>) => B) =>
	<E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
		effect.pipe(
			Effect.mapError((error) => error.message),
			Effect.result,
			Effect.map(toMessage),
		)

const CreateTotp = Command.define("CreateClerkTotp", {
	messages: [Message.CompletedCreateTotp],
	execute: withUserReverified("Failed to start two-factor setup", (user) => user.createTOTP()).pipe(
		Effect.map((totp) =>
			totp.uri === undefined || totp.uri === "" || totp.secret === undefined || totp.secret === ""
				? null
				: { uri: totp.uri, secret: totp.secret },
		),
		toMessageResult((result) => Message.CompletedCreateTotp({ result })),
	),
})

/** Backup codes come with the first second factor and are shown exactly once. */
const VerifyTotp = Command.define("VerifyClerkTotp", {
	args: { code: Schema.String },
	messages: [Message.CompletedVerify],
	execute: ({ code }) =>
		withUser("That code did not match", (user) => user.verifyTOTP({ code })).pipe(
			Effect.map((result) => result.backupCodes ?? []),
			toMessageResult((result) => Message.CompletedVerify({ result })),
		),
})

const CreateBackupCodes = Command.define("CreateClerkBackupCodes", {
	messages: [Message.CompletedRegenerate],
	execute: withUserReverified("Failed to generate backup codes", (user) => user.createBackupCode()).pipe(
		Effect.map((result) => result.codes),
		toMessageResult((result) => Message.CompletedRegenerate({ result })),
	),
})

const DisableTotp = Command.define("DisableClerkTotp", {
	messages: [Message.CompletedDisable],
	execute: withUserReverified("Failed to disable two-factor authentication", (user) =>
		user.disableTOTP(),
	).pipe(settled((result) => Message.CompletedDisable({ result }))),
})

export const init = (): Return => ({
	model: {
		isLoaded: false,
		user: null,
		isBusy: false,
		enrollDialog: Dialog.init("account-totp-enroll", "dialog"),
		enroll: null,
		code: initCode(CODE_ID),
		secretCopy: CopyButton.init(),
		codesCopy: CopyButton.init(),
		disableDialog: Dialog.init("account-totp-disable", "alert-dialog"),
	},
	commands: [ReadTwoFactorUser()],
})

const toast = (type: "success" | "error", title: string) =>
	PageOutMessage.RequestedToast({ type, title, description: "" })

const liftEnroll = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, enrollDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotEnrollDialogMessage({ message }),
	),
})

const liftDisable = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, disableDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotDisableDialogMessage({ message }),
	),
})

const verify = (model: Model, code: string): Return =>
	model.enroll?._tag !== "Verify" || code.length < 6 || model.isBusy
		? { model }
		: { model: { ...model, isBusy: true }, commands: [VerifyTotp({ code })] }

const showCodes = (model: Model, codes: ReadonlyArray<string>): Return => {
	const next = {
		...model,
		isBusy: false,
		enroll: { _tag: "Codes", codes },
		codesCopy: CopyButton.init(),
	} as const
	return model.enrollDialog.isOpen ? { model: next } : liftEnroll(next, Dialog.open(model.enrollDialog))
}

const liftCopy = (
	model: Model,
	key: "secretCopy" | "codesCopy",
	message: CopyButton.Message,
	wrap: (message: CopyButton.Message) => Message,
): Return => {
	const step = CopyButton.update(model[key], message)
	return { model: { ...model, [key]: step.model }, commands: Command.mapMessages(step.commands, wrap) }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedReadUser: ({ user }) => ({ model: { ...model, isLoaded: true, user } }),
		ClickedSetUp: () =>
			model.isBusy ? { model } : { model: { ...model, isBusy: true }, commands: [CreateTotp()] },
		CompletedCreateTotp: ({ result }) =>
			Result.match(result, {
				onSuccess: (totp) =>
					totp === null
						? {
								model: { ...model, isBusy: false },
								outMessage: toast("error", "Clerk did not return a setup key"),
							}
						: liftEnroll(
								{
									...model,
									isBusy: false,
									enroll: { _tag: "Scan", ...totp },
									code: initCode(CODE_ID),
									secretCopy: CopyButton.init(),
								},
								Dialog.open(model.enrollDialog),
							),
				onFailure: (error) => ({
					model: { ...model, isBusy: false },
					outMessage: toast("error", error),
				}),
			}),
		GotEnrollDialogMessage: ({ message: child }) =>
			liftEnroll(model, Dialog.update(model.enrollDialog, child)),
		ClickedCancelEnroll: () => liftEnroll(model, Dialog.close(model.enrollDialog)),
		ClickedContinue: () =>
			model.enroll?._tag === "Scan"
				? {
						model: {
							...model,
							enroll: { ...model.enroll, _tag: "Verify" },
							code: initCode(CODE_ID),
						},
					}
				: { model },
		ClickedBack: () =>
			model.enroll?._tag === "Verify" && !model.isBusy
				? { model: { ...model, enroll: { ...model.enroll, _tag: "Scan" } } }
				: { model },
		GotCodeMessage: ({ message: child }) => {
			const step = OtpField.update(model.code, child)
			const next = { ...model, code: step.model }
			const commands = Command.mapMessages(step.commands ?? [], (inner) =>
				Message.GotCodeMessage({ message: inner }),
			)
			if (!isComplete(model.code) && isComplete(step.model)) {
				const verified = verify(next, OtpField.valueOf(step.model))
				return { ...verified, commands: [...commands, ...(verified.commands ?? [])] }
			}
			return { model: next, commands }
		},
		ClickedVerify: () => verify(model, OtpField.valueOf(model.code)),
		CompletedVerify: ({ result }) =>
			Result.match(result, {
				onSuccess: (codes) => {
					// No codes (backup codes off for the instance): close out instead of an empty list.
					const step =
						codes.length > 0
							? showCodes(model, codes)
							: liftEnroll({ ...model, isBusy: false }, Dialog.close(model.enrollDialog))
					return {
						...step,
						commands: [...(step.commands ?? []), ReadTwoFactorUser()],
						outMessage: toast("success", "Two-factor authentication enabled"),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isBusy: false },
					outMessage: toast("error", error),
				}),
			}),
		ClickedSavedCodes: () => liftEnroll(model, Dialog.close(model.enrollDialog)),
		GotSecretCopyMessage: ({ message: child }) =>
			liftCopy(model, "secretCopy", child, (inner) => Message.GotSecretCopyMessage({ message: inner })),
		GotCodesCopyMessage: ({ message: child }) =>
			liftCopy(model, "codesCopy", child, (inner) => Message.GotCodesCopyMessage({ message: inner })),
		ClickedRegenerate: () =>
			model.isBusy ? { model } : { model: { ...model, isBusy: true }, commands: [CreateBackupCodes()] },
		CompletedRegenerate: ({ result }) =>
			Result.match(result, {
				onSuccess: (codes) => {
					const shown = showCodes(model, codes)
					return {
						...shown,
						commands: [...(shown.commands ?? []), ReadTwoFactorUser()],
						outMessage: toast("success", "New backup codes generated"),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isBusy: false },
					outMessage: toast("error", error),
				}),
			}),
		ClickedRemove: () => liftDisable(model, Dialog.open(model.disableDialog)),
		GotDisableDialogMessage: ({ message: child }) =>
			model.isBusy ? { model } : liftDisable(model, Dialog.update(model.disableDialog, child)),
		ClickedConfirmRemove: () =>
			model.isBusy ? { model } : { model: { ...model, isBusy: true }, commands: [DisableTotp()] },
		CompletedDisable: ({ result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftDisable({ ...model, isBusy: false }, Dialog.close(model.disableDialog))
					return {
						...closed,
						commands: [...(closed.commands ?? []), ReadTwoFactorUser()],
						outMessage: toast("success", "Two-factor authentication disabled"),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isBusy: false },
					outMessage: toast("error", error),
				}),
			}),
	})
