import { Array, Effect, Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import type { ClerkExternalAccountResource } from "../../../../platform/clerk"
import { ClerkActionError } from "../../../../platform/clerk"
import * as Dialog from "../../../../ui/dialog"
import type { IconName } from "../../../../ui/icon"
import { PageOutMessage, type PageReturn } from "../../../contract"
import { settled, withUser, withUserReverified } from "../clerk-write"
import { readAccountUser } from "../user"
import { Message, type Model, ProviderId } from "./model"

type Return = PageReturn<Model, Message>

export const PROVIDERS = [
	{ strategy: "oauth_google", id: "google", label: "Google", icon: "GoogleIcon" },
	{ strategy: "oauth_github", id: "github", label: "GitHub", icon: "GithubIcon" },
] as const satisfies ReadonlyArray<{
	readonly strategy: "oauth_google" | "oauth_github"
	readonly id: ProviderId
	readonly label: string
	readonly icon: IconName
}>

export const providerOf = (id: ProviderId) => PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0]

const REDIRECT_URL = "/account?tab=connections"

const ReadConnectionsUser = Command.define("ReadConnectionsUser", {
	messages: [Message.CompletedReadUser],
	execute: Effect.map(readAccountUser, (user) => Message.CompletedReadUser({ user })),
})

const redirectOf = (account: ClerkExternalAccountResource): string | null => {
	const url = account.verification?.externalVerificationRedirectURL
	return url === null || url === undefined ? null : url.toString()
}

const startedWith =
	(provider: ProviderId) =>
	(effect: Effect.Effect<ClerkExternalAccountResource, ClerkActionError>) =>
		effect.pipe(
			Effect.map(redirectOf),
			Effect.mapError((error) => error.message),
			Effect.result,
			Effect.map((result) => Message.CompletedStart({ provider, result })),
		)

/** Linking leaves the app: the provider runs its own consent screen, then comes back here. */
const Connect = Command.define("CreateClerkExternalAccount", {
	args: { provider: ProviderId },
	messages: [Message.CompletedStart],
	execute: ({ provider }) => {
		const { strategy, label } = providerOf(provider)
		return withUser(`Failed to connect ${label}`, (user) =>
			user.createExternalAccount({ strategy, redirectUrl: REDIRECT_URL }),
		).pipe(startedWith(provider))
	},
})

const withAccount = <A>(
	accountId: string,
	fallback: string,
	run: (account: ClerkExternalAccountResource) => Promise<A>,
	write = withUser<A>,
) =>
	write(fallback, (user) =>
		Option.match(
			Array.findFirst(user.externalAccounts, (account) => account.id === accountId),
			{
				onNone: () => Promise.reject(new ClerkActionError({ message: fallback, cause: undefined })),
				onSome: run,
			},
		),
	)

/** An account that came back unverified runs the provider round trip again. */
const Retry = Command.define("ReauthorizeClerkExternalAccount", {
	args: { provider: ProviderId, accountId: Schema.String },
	messages: [Message.CompletedStart],
	execute: ({ provider, accountId }) =>
		withAccount(accountId, `Failed to reconnect ${providerOf(provider).label}`, (account) =>
			account.reauthorize({ redirectUrl: REDIRECT_URL }),
		).pipe(startedWith(provider)),
})

const FollowRedirect = Command.define("FollowProviderRedirect", {
	args: { url: Schema.String },
	messages: [Message.CompletedRedirect],
	execute: ({ url }) =>
		Effect.sync(() => {
			window.location.href = url
			return Message.CompletedRedirect()
		}),
})

const Disconnect = Command.define("DestroyClerkExternalAccount", {
	args: { accountId: Schema.String, label: Schema.String },
	messages: [Message.CompletedDisconnect],
	execute: ({ accountId, label }) =>
		withAccount(accountId, `Failed to disconnect ${label}`, (account) => account.destroy(), withUserReverified).pipe(
			settled((result) => Message.CompletedDisconnect({ result })),
		),
})

export const init = (): Return => ({
	model: {
		isLoaded: false,
		user: null,
		busy: null,
		removing: null,
		removeDialog: Dialog.init("account-disconnect", "alert-dialog"),
	},
	commands: [ReadConnectionsUser()],
})

const toast = (type: "success" | "error", title: string) => PageOutMessage.RequestedToast({ type, title, description: "" })

const liftRemove = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, removeDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotRemoveDialogMessage({ message })),
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedReadUser: ({ user }) => ({ model: { ...model, isLoaded: true, user } }),
		ClickedConnect: ({ provider }) =>
			model.busy !== null ? { model } : { model: { ...model, busy: provider }, commands: [Connect({ provider })] },
		ClickedRetry: ({ provider, accountId }) =>
			model.busy !== null ? { model } : { model: { ...model, busy: provider }, commands: [Retry({ provider, accountId })] },
		CompletedStart: ({ provider, result }) =>
			Result.match(result, {
				onSuccess: (url) =>
					url === null
						? {
								model: { ...model, busy: null },
								outMessage: toast("error", `${providerOf(provider).label} did not return a sign-in URL`),
							}
						: { model, commands: [FollowRedirect({ url })] },
				onFailure: (error) => ({ model: { ...model, busy: null }, outMessage: toast("error", error) }),
			}),
		CompletedRedirect: () => ({ model }),
		ClickedDisconnect: ({ provider, accountId }) =>
			liftRemove({ ...model, removing: { accountId, provider } }, Dialog.open(model.removeDialog)),
		GotRemoveDialogMessage: ({ message: child }) =>
			model.busy !== null ? { model } : liftRemove(model, Dialog.update(model.removeDialog, child)),
		ClickedConfirmDisconnect: () => {
			const removing = model.removing
			if (removing === null || model.busy !== null) return { model }
			return {
				model: { ...model, busy: removing.provider },
				commands: [Disconnect({ accountId: removing.accountId, label: providerOf(removing.provider).label })],
			}
		},
		CompletedDisconnect: ({ result }) => {
			const label = model.removing === null ? "" : providerOf(model.removing.provider).label
			return Result.match(result, {
				onSuccess: () => {
					const closed = liftRemove({ ...model, busy: null, removing: null }, Dialog.close(model.removeDialog))
					return {
						...closed,
						commands: [...(closed.commands ?? []), ReadConnectionsUser()],
						outMessage: toast("success", `${label} disconnected`),
					}
				},
				onFailure: (error) => ({ model: { ...model, busy: null }, outMessage: toast("error", error) }),
			})
		},
	})
