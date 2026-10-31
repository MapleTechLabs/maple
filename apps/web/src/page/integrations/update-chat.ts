import type { ChatWorkspaceId } from "@maple/domain/primitives"
import { Option } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import type { LoadFailure } from "../../data/load-failure"
import * as Dialog from "../../ui/dialog"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { chatConnectorOf, chatManifestOf, integrationOfSearch } from "./catalog"
import {
	type ChatCardModel,
	DisconnectChatWorkspace,
	InstallChat,
	LinkChatIdentity,
	UnlinkChatIdentity,
} from "./chat"
import { Message } from "./message"
import type { Model } from "./model"
import { chain, requestStatus } from "./update-status"

// The chat card's writes: install, account link, workspace disconnect (`ChatIntegrationCard`).

type Return = PageReturn<Model, Message>

const withCard = (model: Model, card: Partial<ChatCardModel>): Model => ({
	...model,
	chatCard: { ...model.chatCard, ...card },
})

const connectorOfPage = (model: Model) => {
	const integration = integrationOfSearch(model.search.integration)
	return integration === null ? null : chatConnectorOf(integration)
}

const platformOf = (model: Model) => {
	const connector = connectorOfPage(model)
	return connector === null ? "" : (chatManifestOf(connector)?.name ?? "")
}

/** The connector's entry in the list (`status`), if it answered. */
export const chatConnectorStatus = (model: Model) => {
	const connector = connectorOfPage(model)
	return Option.getOrNull(
		Option.map(
			AsyncData.getData(model.statuses.chat.data),
			(response) => response.data.find((entry) => entry.id === connector) ?? null,
		),
	)
}

const toast = (model: Model, type: "success" | "error", title: string, description = ""): Return => ({
	model,
	outMessage: PageOutMessage.RequestedToast({ type, title, description }),
})

/** `toastExit`: a success title (optional) or the error title with the failure's message. */
const outcome = (
	model: Model,
	context: PageContext,
	failure: LoadFailure | null,
	titles: Readonly<{ success?: string; error: string }>,
): Return =>
	failure === null
		? chain(model, [
				(next) =>
					titles.success === undefined ? { model: next } : toast(next, "success", titles.success),
				(next) => requestStatus(next, context, "chat", "Supersede"),
			])
		: toast(model, "error", titles.error, failure.message)

export const clickedInstall = (model: Model): Return => {
	const connector = connectorOfPage(model)
	if (connector === null || model.chatCard.busy !== null) return { model }
	return { model: withCard(model, { busy: "install" }), commands: [InstallChat({ connector })] }
}

/** Success keeps the card busy: the browser is already leaving for the platform. */
export const completedInstall = (model: Model, context: PageContext, failure: LoadFailure | null): Return =>
	failure === null
		? requestStatus(model, context, "chat", "Supersede")
		: outcome(withCard(model, { busy: null }), context, failure, {
				error: `Couldn't start the ${platformOf(model)} install`,
			})

export const clickedIdentity = (model: Model): Return => {
	const connector = connectorOfPage(model)
	const status = chatConnectorStatus(model)
	if (connector === null || model.chatCard.identityBusy) return { model }
	return {
		model: withCard(model, { identityBusy: true }),
		commands: [
			status?.identity === undefined
				? LinkChatIdentity({ connector })
				: UnlinkChatIdentity({ connector }),
		],
	}
}

export const completedIdentity = (
	model: Model,
	context: PageContext,
	kind: "link" | "unlink",
	failure: LoadFailure | null,
): Return =>
	kind === "link"
		? failure === null
			? requestStatus(model, context, "chat", "Supersede")
			: outcome(withCard(model, { identityBusy: false }), context, failure, {
					error: "Couldn't start the account link",
				})
		: outcome(withCard(model, { identityBusy: false }), context, failure, {
				success: "Account unlinked",
				error: "Couldn't unlink the account",
			})

const withDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, disconnect: { ...model.disconnect, dialog: step.model } },
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDisconnectDialogMessage({ message }),
	),
})

export const clickedDisconnect = (model: Model, workspaceId: ChatWorkspaceId): Return =>
	withDialog(withCard(model, { confirmId: workspaceId }), Dialog.open(model.disconnect.dialog))

/** The dialog stays open, pending, until the workspace is gone (`pending={busy === confirmId}`). */
export const confirmedDisconnect = (model: Model): Return => {
	const id = model.chatCard.confirmId
	if (id === null || model.chatCard.busy !== null) return { model }
	return { model: withCard(model, { busy: id }), commands: [DisconnectChatWorkspace({ id })] }
}

export const completedDisconnect = (
	model: Model,
	context: PageContext,
	failure: LoadFailure | null,
): Return => {
	const closed = withDialog(
		withCard(model, { busy: null, confirmId: null }),
		Dialog.close(model.disconnect.dialog),
	)
	return chain(closed.model, [
		() => closed,
		(next) =>
			outcome(next, context, failure, {
				success: "Workspace disconnected",
				error: "Couldn't disconnect the workspace",
			}),
	])
}
