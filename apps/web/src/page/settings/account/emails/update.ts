import { Array, Effect, Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import type { ClerkEmailAddressResource, ClerkUserResource } from "../../../../platform/clerk"
import { ClerkActionError, clerkTry } from "../../../../platform/clerk"
import * as Dialog from "../../../../ui/dialog"
import * as Menu from "../../../../ui/menu"
import * as OtpField from "../../../../ui/otp-field"
import { PageOutMessage, type PageReturn } from "../../../contract"
import { settled, withUser, withUserReverified } from "../clerk-write"
import { initCode, isComplete } from "../code-field"
import { type AccountEmail, readAccountUser } from "../user"
import { type AddStep, Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

const ReadEmailsUser = Command.define("ReadEmailsUser", {
	messages: [Message.CompletedReadUser],
	execute: Effect.map(readAccountUser, (user) => Message.CompletedReadUser({ user })),
})

/** The address resource behind a row, looked up on the user when the write runs. */
const withAddress = <A>(
	addressId: string,
	fallback: string,
	run: (address: ClerkEmailAddressResource, user: ClerkUserResource) => Promise<A>,
	write = withUser<A>,
) =>
	write(fallback, (user) =>
		Option.match(
			Array.findFirst(user.emailAddresses, (address) => address.id === addressId),
			{
				onNone: () => Promise.reject(new ClerkActionError({ message: fallback, cause: undefined })),
				onSome: (address) => run(address, user),
			},
		),
	)

const CreateEmail = Command.define("CreateClerkEmailAddress", {
	args: { email: Schema.String },
	messages: [Message.CompletedCreate],
	execute: ({ email }) =>
		withUserReverified("Couldn't add email address", (user) => user.createEmailAddress({ email })).pipe(
			Effect.tap((address) =>
				clerkTry("Couldn't add email address", () => address.prepareVerification({ strategy: "email_code" })),
			),
			Effect.map((address) => ({ addressId: address.id, email: address.emailAddress })),
			Effect.mapError((error) => error.message),
			Effect.result,
			Effect.map((result) => Message.CompletedCreate({ result })),
		),
})

const VerifyEmail = Command.define("VerifyClerkEmailAddress", {
	args: { addressId: Schema.String, code: Schema.String },
	messages: [Message.CompletedVerify],
	execute: ({ addressId, code }) =>
		withAddress(addressId, "That code did not match", (address) => address.attemptVerification({ code })).pipe(
			settled((result) => Message.CompletedVerify({ result })),
		),
})

/** Re-opens the code step for an address added earlier but never verified. */
const PrepareVerification = Command.define("PrepareClerkEmailVerification", {
	args: { addressId: Schema.String, email: Schema.String },
	messages: [Message.CompletedPrepare],
	execute: ({ addressId, email }) =>
		withAddress(addressId, "Couldn't send a verification code", (address) =>
			address.prepareVerification({ strategy: "email_code" }),
		).pipe(settled((result) => Message.CompletedPrepare({ addressId, email, result }))),
})

/** Primary is a property of the user: Clerk has no `emailAddress.setPrimary()`. */
const SetPrimary = Command.define("SetClerkPrimaryEmail", {
	args: { addressId: Schema.String, email: Schema.String },
	messages: [Message.CompletedSetPrimary],
	execute: ({ addressId, email }) =>
		withUser("Couldn't change your primary email", (user) => user.update({ primaryEmailAddressId: addressId })).pipe(
			settled((result) => Message.CompletedSetPrimary({ email, result })),
		),
})

const RemoveEmail = Command.define("RemoveClerkEmailAddress", {
	args: { addressId: Schema.String },
	messages: [Message.CompletedRemove],
	execute: ({ addressId }) =>
		withAddress(addressId, "Couldn't remove email address", (address) => address.destroy(), withUserReverified).pipe(
			settled((result) => Message.CompletedRemove({ result })),
		),
})

const CODE_ID = "account-email-code"

export const init = (): Return => ({
	model: {
		isLoaded: false,
		user: null,
		addDialog: Dialog.init("account-add-email", "dialog"),
		add: { _tag: "Email", value: "" },
		code: initCode(CODE_ID),
		isBusy: false,
		rowMenus: {},
		removing: null,
		removeDialog: Dialog.init("account-remove-email", "alert-dialog"),
	},
	commands: [ReadEmailsUser()],
})

const toast = (type: "success" | "error", title: string) => PageOutMessage.RequestedToast({ type, title, description: "" })

const liftAdd = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		addDialog: step.model,
		...(step.outMessage?._tag === "Closed" && { add: { _tag: "Email", value: "" } as const, code: initCode(CODE_ID) }),
	},
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotAddDialogMessage({ message })),
})

const liftRemove = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, removeDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotRemoveDialogMessage({ message })),
})

const withCommands = (step: Return, commands: ReadonlyArray<Command.Command<Message>>): Return => ({
	...step,
	commands: [...(step.commands ?? []), ...commands],
})

/** Clerk requires one verified address, so the primary and the last verified one stay. */
export const canRemove = (user: { readonly primaryEmailAddressId: string | null; readonly emails: ReadonlyArray<AccountEmail> }, address: AccountEmail): boolean => {
	const verifiedCount = user.emails.filter((email) => email.isVerified).length
	const isPrimary = address.id === user.primaryEmailAddressId
	return !isPrimary && !(address.isVerified && verifiedCount === 1)
}

const verify = (model: Model, code: string): Return =>
	model.add._tag !== "Code" || code.length < 6 || model.isBusy
		? { model }
		: { model: { ...model, isBusy: true }, commands: [VerifyEmail({ addressId: model.add.addressId, code })] }

const codeStep = (addressId: string, email: string): AddStep => ({ _tag: "Code", addressId, email })

const pickedRowAction = (model: Model, menuId: string, value: string): Return => {
	const address = Option.flatMap(Option.fromNullishOr(model.user), (user) =>
		Array.findFirst(user.emails, (email) => `email-actions-${email.id}` === menuId),
	)
	return Option.match(address, {
		onNone: () => ({ model }),
		onSome: (row) => {
			if (model.isBusy) return { model }
			if (value === "verify")
				return {
					model: { ...model, isBusy: true },
					commands: [PrepareVerification({ addressId: row.id, email: row.email })],
				}
			if (value === "primary")
				return { model: { ...model, isBusy: true }, commands: [SetPrimary({ addressId: row.id, email: row.email })] }
			return liftRemove({ ...model, removing: row }, Dialog.open(model.removeDialog))
		},
	})
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedReadUser: ({ user }) => ({ model: { ...model, isLoaded: true, user } }),
		ClickedAdd: () => liftAdd({ ...model, add: { _tag: "Email", value: "" }, code: initCode(CODE_ID) }, Dialog.open(model.addDialog)),
		GotAddDialogMessage: ({ message: child }) => liftAdd(model, Dialog.update(model.addDialog, child)),
		ChangedEmail: ({ value }) => ({ model: { ...model, add: { _tag: "Email", value } } }),
		SubmittedAdd: () => {
			if (model.add._tag === "Code") return verify(model, OtpField.valueOf(model.code))
			const email = model.add.value.trim()
			if (email.length === 0 || model.isBusy) return { model }
			return { model: { ...model, isBusy: true }, commands: [CreateEmail({ email })] }
		},
		CompletedCreate: ({ result }) =>
			Result.match(result, {
				onSuccess: ({ addressId, email }) => ({
					model: { ...model, isBusy: false, add: codeStep(addressId, email), code: initCode(CODE_ID) },
					commands: [ReadEmailsUser()],
				}),
				onFailure: (error) => ({ model: { ...model, isBusy: false }, outMessage: toast("error", error) }),
			}),
		GotCodeMessage: ({ message: child }) => {
			const step = OtpField.update(model.code, child)
			const next = { ...model, code: step.model }
			const commands = Command.mapMessages(step.commands ?? [], (inner) => Message.GotCodeMessage({ message: inner }))
			// `onValueComplete`: the sixth digit submits.
			return !isComplete(model.code) && isComplete(step.model)
				? withCommands(verify(next, OtpField.valueOf(step.model)), commands)
				: { model: next, commands }
		},
		CompletedVerify: ({ result }) =>
			Result.match(result, {
				onSuccess: () =>
					withCommands(
						{ ...liftAdd({ ...model, isBusy: false }, Dialog.close(model.addDialog)), outMessage: toast("success", "Email address verified") },
						[ReadEmailsUser()],
					),
				onFailure: (error) => ({ model: { ...model, isBusy: false }, outMessage: toast("error", error) }),
			}),
		CompletedPrepare: ({ addressId, email, result }) =>
			Result.match(result, {
				onSuccess: () =>
					liftAdd({ ...model, isBusy: false, add: codeStep(addressId, email), code: initCode(CODE_ID) }, Dialog.open(model.addDialog)),
				onFailure: (error) => ({ model: { ...model, isBusy: false }, outMessage: toast("error", error) }),
			}),
		CompletedSetPrimary: ({ email, result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: { ...model, isBusy: false },
					commands: [ReadEmailsUser()],
					outMessage: toast("success", `${email} is now your primary email`),
				}),
				onFailure: (error) => ({ model: { ...model, isBusy: false }, outMessage: toast("error", error) }),
			}),
		GotRowMenuMessage: ({ menuId, message: child }) => {
			const step = Menu.update(model.rowMenus[menuId] ?? Menu.init(menuId), child)
			const next = { ...model, rowMenus: { ...model.rowMenus, [menuId]: step.model } }
			const commands = Command.mapMessages(step.commands ?? [], (inner) => Message.GotRowMenuMessage({ menuId, message: inner }))
			if (step.outMessage?._tag !== "SelectedItem") return { model: next, commands }
			const after = pickedRowAction(next, menuId, step.outMessage.value)
			return { ...after, commands: [...commands, ...(after.commands ?? [])] }
		},
		GotRemoveDialogMessage: ({ message: child }) =>
			model.isBusy ? { model } : liftRemove(model, Dialog.update(model.removeDialog, child)),
		ClickedConfirmRemove: () =>
			model.removing === null || model.isBusy
				? { model }
				: { model: { ...model, isBusy: true }, commands: [RemoveEmail({ addressId: model.removing.id })] },
		CompletedRemove: ({ result }) =>
			Result.match(result, {
				onSuccess: () =>
					withCommands(
						{
							...liftRemove({ ...model, isBusy: false, removing: null }, Dialog.close(model.removeDialog)),
							outMessage: toast("success", "Email address removed"),
						},
						[ReadEmailsUser()],
					),
				onFailure: (error) => ({ model: { ...model, isBusy: false }, outMessage: toast("error", error) }),
			}),
	})
