import { Array, Effect, Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import type { ClerkSessionActivityResource } from "../../../../platform/clerk"
import { ClerkActionError, currentClerkSessionId } from "../../../../platform/clerk"
import * as Dialog from "../../../../ui/dialog"
import { PageOutMessage, type PageReturn } from "../../../contract"
import { settled, withUser, withUserReverified } from "../clerk-write"
import { Message, type Model, type SessionRow } from "./model"

type Return = PageReturn<Model, Message>

const describeDevice = (session: ClerkSessionActivityResource): string => {
	const { browserName, browserVersion, deviceType } = session.latestActivity
	const browser = [browserName, browserVersion].filter(Boolean).join(" ")
	return [deviceType, browser].filter(Boolean).join(" · ") || "Unknown device"
}

const describeLocation = (session: ClerkSessionActivityResource): string => {
	const { city, country, ipAddress } = session.latestActivity
	return [city, country].filter(Boolean).join(", ") || ipAddress || "Unknown location"
}

const toRow = (session: ClerkSessionActivityResource): SessionRow => ({
	id: session.id,
	device: describeDevice(session),
	location: describeLocation(session),
	isMobile: session.latestActivity.isMobile ?? false,
	lastActiveAtMs: session.lastActiveAt.getTime(),
})

const LoadSessions = Command.define("LoadClerkSessions", {
	messages: [Message.CompletedLoad],
	execute: Effect.gen(function* () {
		const currentSessionId = yield* currentClerkSessionId
		const result = yield* withUser("Failed to load your sessions", (user) => user.getSessions()).pipe(
			Effect.map((sessions) => sessions.map(toRow)),
			Effect.mapError((error) => error.message),
			Effect.result,
		)
		return Message.CompletedLoad({ currentSessionId, result })
	}),
})

/** `revoke()` answers with the one session, so the list is read again rather than patched. */
const RevokeSession = Command.define("RevokeClerkSession", {
	args: { id: Schema.String },
	messages: [Message.CompletedRevoke],
	execute: ({ id }) =>
		withUserReverified("Failed to sign out that session", (user) =>
			user.getSessions().then((sessions) =>
				Option.match(
					Array.findFirst(sessions, (session) => session.id === id),
					{
						onNone: () =>
							Promise.reject(
								new ClerkActionError({
									message: "Failed to sign out that session",
									cause: undefined,
								}),
							),
						onSome: (session) => session.revoke(),
					},
				),
			),
		).pipe(settled((result) => Message.CompletedRevoke({ result }))),
})

export const init = (): Return => ({
	model: {
		state: { _tag: "Loading" },
		currentSessionId: null,
		revoking: null,
		revokeDialog: Dialog.init("account-revoke-session", "alert-dialog"),
		isRevoking: false,
	},
	commands: [LoadSessions()],
})

const liftRevoke = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		revokeDialog: step.model,
		...(step.outMessage?._tag === "Closed" && { revoking: null }),
	},
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotRevokeDialogMessage({ message }),
	),
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedLoad: ({ currentSessionId, result }) => ({
			model: {
				...model,
				currentSessionId,
				state: Result.match(result, {
					onSuccess: (sessions) => ({ _tag: "Ready", sessions }) as const,
					onFailure: (error) => ({ _tag: "Failed", message: error }) as const,
				}),
			},
		}),
		ClickedRetry: () => ({ model, commands: [LoadSessions()] }),
		ClickedSignOut: ({ session }) =>
			liftRevoke({ ...model, revoking: session }, Dialog.open(model.revokeDialog)),
		GotRevokeDialogMessage: ({ message: child }) =>
			model.isRevoking ? { model } : liftRevoke(model, Dialog.update(model.revokeDialog, child)),
		ClickedConfirmSignOut: () =>
			model.revoking === null || model.isRevoking
				? { model }
				: {
						model: { ...model, isRevoking: true },
						commands: [RevokeSession({ id: model.revoking.id })],
					},
		CompletedRevoke: ({ result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftRevoke(
						{ ...model, isRevoking: false },
						Dialog.close(model.revokeDialog),
					)
					return {
						...closed,
						commands: [...(closed.commands ?? []), LoadSessions()],
						outMessage: PageOutMessage.RequestedToast({
							type: "success",
							title: "Session signed out",
							description: "",
						}),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isRevoking: false },
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: error,
						description: "",
					}),
				}),
			}),
	})
