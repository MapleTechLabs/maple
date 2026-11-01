import { Effect, Option, Result, Schema } from "effect"
import { Command, File } from "foldkit"
import * as Dialog from "../../../../ui/dialog"
import { signOutOfClerk } from "../../../../platform/clerk"
import { PageOutMessage, type PageReturn } from "../../../contract"
import { checkImage, clickFileInput } from "../../kit/image-dropzone"
import { settled, withUser, withUserReverified } from "../clerk-write"
import { type AccountUser, readAccountUser } from "../user"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

export const AVATAR_INPUT_ID = "account-avatar-input"

export const ReadProfileUser = Command.define("ReadProfileUser", {
	messages: [Message.CompletedReadUser],
	execute: Effect.map(readAccountUser, (user) => Message.CompletedReadUser({ user })),
})

const SaveName = Command.define("UpdateClerkUserName", {
	args: { firstName: Schema.String, lastName: Schema.String },
	messages: [Message.CompletedSaveName],
	execute: ({ firstName, lastName }) =>
		withUser("Couldn't update profile", (user) => user.update({ firstName, lastName })).pipe(
			settled((result) => Message.CompletedSaveName({ result })),
		),
})

const PickAvatar = Command.define("PickProfilePicture", {
	messages: [Message.CompletedPickAvatar],
	execute: clickFileInput(AVATAR_INPUT_ID).pipe(Effect.as(Message.CompletedPickAvatar())),
})

const SetAvatar = Command.define("SetClerkProfileImage", {
	args: { file: Schema.NullOr(File.File) },
	messages: [Message.CompletedSetAvatar],
	execute: ({ file }) =>
		withUser(
			file === null ? "Couldn't remove profile picture" : "Couldn't update profile picture",
			(user) => user.setProfileImage({ file }),
		).pipe(settled((result) => Message.CompletedSetAvatar({ isRemoved: file === null, result }))),
})

/** `user.delete()`, then `signOut()`: the session is gone with the user. */
const DeleteAccount = Command.define("DeleteClerkUser", {
	messages: [Message.CompletedDelete],
	execute: withUserReverified("Couldn't delete account", (user) => user.delete()).pipe(
		Effect.tap(() => signOutOfClerk),
		settled((result) => Message.CompletedDelete({ result })),
	),
})

export const init = (): Return => ({
	model: {
		isLoaded: false,
		user: null,
		draft: null,
		isSavingName: false,
		isSavingAvatar: false,
		isDragging: false,
		deleteDialog: Dialog.init("account-delete", "alert-dialog"),
		confirmText: "",
		isDeleting: false,
	},
	commands: [ReadProfileUser()],
})

const toast = (type: "success" | "error", title: string) =>
	PageOutMessage.RequestedToast({ type, title, description: "" })

/** The name fields: the edits typed against this user, else the saved name. */
export const namesOf = (model: Model, user: AccountUser) =>
	model.draft !== null && model.draft.userId === user.id
		? { firstName: model.draft.firstName, lastName: model.draft.lastName }
		: { firstName: user.firstName, lastName: user.lastName }

export const isNameDirty = (model: Model, user: AccountUser): boolean => {
	const names = namesOf(model, user)
	return names.firstName.trim() !== user.firstName || names.lastName.trim() !== user.lastName
}

/** A user has no unique display name to type back, so the primary email is the confirm string. */
export const isConfirmMatching = (model: Model, user: AccountUser): boolean =>
	user.primaryEmail !== null &&
	user.primaryEmail.length > 0 &&
	model.confirmText.trim() === user.primaryEmail

const liftDelete = (model: Model, step: ReturnType<typeof Dialog.update>): Return => {
	const closed = step.outMessage?._tag === "Closed"
	return {
		model: { ...model, deleteDialog: step.model, ...(closed && { confirmText: "" }) },
		commands: Command.mapMessages(step.commands ?? [], (message) =>
			Message.GotDeleteDialogMessage({ message }),
		),
	}
}

const editName = (model: Model, patch: Readonly<{ firstName?: string; lastName?: string }>): Return => {
	const user = model.user
	if (user === null) return { model }
	return { model: { ...model, draft: { userId: user.id, ...namesOf(model, user), ...patch } } }
}

const startAvatar = (model: Model, file: File.File | null): Return =>
	model.isSavingAvatar
		? { model }
		: { model: { ...model, isSavingAvatar: true, isDragging: false }, commands: [SetAvatar({ file })] }

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedReadUser: ({ user }) => ({ model: { ...model, isLoaded: true, user } }),
		ChangedFirstName: ({ value }) => editName(model, { firstName: value }),
		ChangedLastName: ({ value }) => editName(model, { lastName: value }),
		ClickedSaveName: () => {
			const user = model.user
			if (user === null || model.isSavingName || !isNameDirty(model, user)) return { model }
			const names = namesOf(model, user)
			return {
				model: { ...model, isSavingName: true },
				commands: [SaveName({ firstName: names.firstName.trim(), lastName: names.lastName.trim() })],
			}
		},
		CompletedSaveName: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: { ...model, isSavingName: false, draft: null },
					commands: [ReadProfileUser()],
					outMessage: toast("success", "Profile updated"),
				}),
				onFailure: (error) => ({
					model: { ...model, isSavingName: false },
					outMessage: toast("error", error),
				}),
			}),
		ClickedPickAvatar: () => (model.isSavingAvatar ? { model } : { model, commands: [PickAvatar()] }),
		CompletedPickAvatar: () => ({ model }),
		DraggedOverAvatar: () => ({ model: { ...model, isDragging: true } }),
		LeftAvatar: () => ({ model: { ...model, isDragging: false } }),
		PickedAvatar: ({ files }) =>
			Option.match(Option.fromNullishOr(files[0]), {
				onNone: () => ({ model: { ...model, isDragging: false } }),
				onSome: (file) =>
					Option.match(checkImage(file), {
						onNone: () => startAvatar(model, file),
						onSome: (problem) => ({
							model: { ...model, isDragging: false },
							outMessage: toast("error", problem),
						}),
					}),
			}),
		ClickedRemoveAvatar: () => startAvatar(model, null),
		CompletedSetAvatar: ({ isRemoved, result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: { ...model, isSavingAvatar: false },
					commands: [ReadProfileUser()],
					outMessage: toast(
						"success",
						isRemoved ? "Profile picture removed" : "Profile picture updated",
					),
				}),
				onFailure: (error) => ({
					model: { ...model, isSavingAvatar: false },
					outMessage: toast("error", error),
				}),
			}),
		ClickedDelete: () => liftDelete(model, Dialog.open(model.deleteDialog)),
		GotDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting ? { model } : liftDelete(model, Dialog.update(model.deleteDialog, child)),
		ChangedConfirmText: ({ value }) => ({ model: { ...model, confirmText: value } }),
		ClickedConfirmDelete: () => {
			const user = model.user
			if (user === null || model.isDeleting || !isConfirmMatching(model, user)) return { model }
			return { model: { ...model, isDeleting: true }, commands: [DeleteAccount()] }
		},
		CompletedDelete: ({ result }) =>
			Result.match(result, {
				// `afterSignOutUrl` takes the signed-out app to the sign-in page.
				onSuccess: () => ({ model: { ...model, isDeleting: false } }),
				onFailure: (error) => ({
					model: { ...model, isDeleting: false },
					outMessage: toast("error", error),
				}),
			}),
	})
