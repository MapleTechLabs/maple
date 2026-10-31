import { Effect, Result, Schema } from "effect"
import { Command } from "foldkit"
import { PageOutMessage, type PageReturn } from "../../../contract"
import { settled, withUserReverified } from "../clerk-write"
import { readAccountUser } from "../user"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

export const MIN_PASSWORD_LENGTH = 8

const ReadPasswordUser = Command.define("ReadPasswordUser", {
	messages: [Message.CompletedReadUser],
	execute: Effect.map(readAccountUser, (user) => Message.CompletedReadUser({ user })),
})

const UpdatePassword = Command.define("UpdateClerkPassword", {
	args: {
		newPassword: Schema.String,
		currentPassword: Schema.optional(Schema.String),
		signOutOfOtherSessions: Schema.Boolean,
	},
	messages: [Message.CompletedSubmit],
	execute: ({ newPassword, currentPassword, signOutOfOtherSessions }) =>
		withUserReverified("Couldn't update your password", (user) =>
			user.updatePassword({
				newPassword,
				// Clerk rejects `currentPassword` on an account that has none yet.
				...(currentPassword !== undefined && { currentPassword }),
				signOutOfOtherSessions,
			}),
		).pipe(settled((result) => Message.CompletedSubmit({ hadPassword: currentPassword !== undefined, result }))),
})

export const init = (): Return => ({
	model: {
		isLoaded: false,
		user: null,
		current: "",
		next: "",
		confirm: "",
		isSigningOutOthers: true,
		isSaving: false,
	},
	commands: [ReadPasswordUser()],
})

export const hasPasswordOf = (model: Model): boolean => model.user?.passwordEnabled ?? false
export const isTooShort = (model: Model): boolean => model.next.length > 0 && model.next.length < MIN_PASSWORD_LENGTH
export const isMismatch = (model: Model): boolean => model.confirm.length > 0 && model.confirm !== model.next

export const canSubmit = (model: Model): boolean =>
	model.next.length >= MIN_PASSWORD_LENGTH &&
	model.confirm === model.next &&
	(!hasPasswordOf(model) || model.current.length > 0)

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedReadUser: ({ user }) => ({ model: { ...model, isLoaded: true, user } }),
		ChangedPassword: ({ field, value }) => ({ model: { ...model, [field]: value } }),
		ToggledSignOutOthers: () => ({ model: { ...model, isSigningOutOthers: !model.isSigningOutOthers } }),
		ClickedSubmit: () => {
			if (model.isSaving || !canSubmit(model)) return { model }
			return {
				model: { ...model, isSaving: true },
				commands: [
					UpdatePassword({
						newPassword: model.next,
						...(hasPasswordOf(model) && { currentPassword: model.current }),
						signOutOfOtherSessions: model.isSigningOutOthers,
					}),
				],
			}
		},
		CompletedSubmit: ({ hadPassword, result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: { ...model, isSaving: false, current: "", next: "", confirm: "" },
					commands: [ReadPasswordUser()],
					outMessage: PageOutMessage.RequestedToast({
						type: "success",
						title: hadPassword ? "Password changed" : "Password set",
						description: "",
					}),
				}),
				onFailure: (error) => ({
					model: { ...model, isSaving: false },
					outMessage: PageOutMessage.RequestedToast({ type: "error", title: error, description: "" }),
				}),
			}),
	})
