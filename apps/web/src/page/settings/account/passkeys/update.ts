import { Array, Effect, Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import type { ClerkPasskeyResource } from "../../../../platform/clerk"
import { ClerkActionError } from "../../../../platform/clerk"
import * as Dialog from "../../../../ui/dialog"
import * as Menu from "../../../../ui/menu"
import { PageOutMessage, type PageReturn } from "../../../contract"
import { settled, withUser, withUserReverified } from "../clerk-write"
import { readAccountUser } from "../user"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

const ReadPasskeysUser = Command.define("ReadPasskeysUser", {
	messages: [Message.CompletedReadUser],
	execute: Effect.map(readAccountUser, (user) =>
		Message.CompletedReadUser({ user, isSupported: "PublicKeyCredential" in window }),
	),
})

const withPasskey = <A>(
	id: string,
	fallback: string,
	run: (passkey: ClerkPasskeyResource) => Promise<A>,
	write = withUser<A>,
) =>
	write(fallback, (user) =>
		Option.match(
			Array.findFirst(user.passkeys, (passkey) => passkey.id === id),
			{
				onNone: () => Promise.reject(new ClerkActionError({ message: fallback, cause: undefined })),
				onSome: run,
			},
		),
	)

/** `createPasskey()` takes no name: Clerk derives one from the authenticator. */
const CreatePasskey = Command.define("CreateClerkPasskey", {
	messages: [Message.CompletedCreate],
	execute: withUserReverified("Couldn't add a passkey", (user) => user.createPasskey()).pipe(
		settled((result) => Message.CompletedCreate({ result })),
	),
})

const RenamePasskey = Command.define("RenameClerkPasskey", {
	args: { id: Schema.String, name: Schema.String },
	messages: [Message.CompletedRename],
	execute: ({ id, name }) =>
		withPasskey(id, "Couldn't rename passkey", (passkey) => passkey.update({ name })).pipe(
			settled((result) => Message.CompletedRename({ result })),
		),
})

const RemovePasskey = Command.define("RemoveClerkPasskey", {
	args: { id: Schema.String },
	messages: [Message.CompletedRemove],
	execute: ({ id }) =>
		withPasskey(id, "Couldn't remove passkey", (passkey) => passkey.delete(), withUserReverified).pipe(
			settled((result) => Message.CompletedRemove({ result })),
		),
})

export const init = (): Return => ({
	model: {
		isLoaded: false,
		user: null,
		isSupported: true,
		isBusy: false,
		rowMenus: {},
		renaming: null,
		renameDialog: Dialog.init("passkey-rename", "dialog"),
		removing: null,
		removeDialog: Dialog.init("passkey-remove", "alert-dialog"),
	},
	commands: [ReadPasskeysUser()],
})

const toast = (type: "success" | "error", title: string) =>
	PageOutMessage.RequestedToast({ type, title, description: "" })

const liftRename = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		renameDialog: step.model,
		...(step.outMessage?._tag === "Closed" && { renaming: null }),
	},
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotRenameDialogMessage({ message }),
	),
})

const liftRemove = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, removeDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotRemoveDialogMessage({ message }),
	),
})

const refreshed = (step: Return, title: string): Return => ({
	...step,
	commands: [...(step.commands ?? []), ReadPasskeysUser()],
	outMessage: toast("success", title),
})

const pickedRowAction = (model: Model, menuId: string, value: string): Return =>
	Option.match(
		Option.flatMap(Option.fromNullishOr(model.user), (user) =>
			Array.findFirst(user.passkeys, (passkey) => `passkey-actions-${passkey.id}` === menuId),
		),
		{
			onNone: () => ({ model }),
			onSome: (passkey) =>
				model.isBusy
					? { model }
					: value === "rename"
						? liftRename(
								{ ...model, renaming: { id: passkey.id, name: passkey.name ?? "" } },
								Dialog.open(model.renameDialog),
							)
						: liftRemove({ ...model, removing: passkey }, Dialog.open(model.removeDialog)),
		},
	)

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedReadUser: ({ user, isSupported }) => ({
			model: { ...model, isLoaded: true, user, isSupported },
		}),
		ClickedAdd: () =>
			model.isBusy || !model.isSupported
				? { model }
				: { model: { ...model, isBusy: true }, commands: [CreatePasskey()] },
		CompletedCreate: ({ result }) =>
			Result.match(result, {
				onSuccess: () => refreshed({ model: { ...model, isBusy: false } }, "Passkey added"),
				onFailure: (error) => ({
					model: { ...model, isBusy: false },
					outMessage: toast("error", error),
				}),
			}),
		GotRowMenuMessage: ({ menuId, message: child }) => {
			const step = Menu.update(model.rowMenus[menuId] ?? Menu.init(menuId), child)
			const next = { ...model, rowMenus: { ...model.rowMenus, [menuId]: step.model } }
			const commands = Command.mapMessages(step.commands ?? [], (inner) =>
				Message.GotRowMenuMessage({ menuId, message: inner }),
			)
			if (step.outMessage?._tag !== "SelectedItem") return { model: next, commands }
			const after = pickedRowAction(next, menuId, step.outMessage.value)
			return { ...after, commands: [...commands, ...(after.commands ?? [])] }
		},
		GotRenameDialogMessage: ({ message: child }) =>
			model.isBusy ? { model } : liftRename(model, Dialog.update(model.renameDialog, child)),
		ChangedName: ({ value }) =>
			model.renaming === null
				? { model }
				: { model: { ...model, renaming: { ...model.renaming, name: value } } },
		SubmittedRename: () => {
			const renaming = model.renaming
			const name = renaming?.name.trim() ?? ""
			if (renaming === null || name.length === 0 || model.isBusy) return { model }
			return { model: { ...model, isBusy: true }, commands: [RenamePasskey({ id: renaming.id, name })] }
		},
		CompletedRename: ({ result }) =>
			Result.match(result, {
				onSuccess: () =>
					refreshed(
						liftRename({ ...model, isBusy: false }, Dialog.close(model.renameDialog)),
						"Passkey renamed",
					),
				onFailure: (error) => ({
					model: { ...model, isBusy: false },
					outMessage: toast("error", error),
				}),
			}),
		GotRemoveDialogMessage: ({ message: child }) =>
			model.isBusy ? { model } : liftRemove(model, Dialog.update(model.removeDialog, child)),
		ClickedConfirmRemove: () =>
			model.removing === null || model.isBusy
				? { model }
				: { model: { ...model, isBusy: true }, commands: [RemovePasskey({ id: model.removing.id })] },
		CompletedRemove: ({ result }) =>
			Result.match(result, {
				onSuccess: () =>
					refreshed(
						liftRemove(
							{ ...model, isBusy: false, removing: null },
							Dialog.close(model.removeDialog),
						),
						"Passkey removed",
					),
				onFailure: (error) => ({
					model: { ...model, isBusy: false },
					outMessage: toast("error", error),
				}),
			}),
	})
