import type { Html, HtmlBuilder } from "foldkit/html"
import { confirmDialog } from "../../ui/confirm-dialog"
import type * as Dialog from "../../ui/dialog"
import { type DisconnectProvider, disconnectSpec, disconnectTitle } from "./disconnect"
import { Message } from "./message"
import type { Model } from "./model"

/**
 * Every provider's disconnect confirmation: the spec's copy, and a confirm that stays pending until
 * the mutation answers (the parent closes the dialog then).
 */
export const disconnectConfirm = (
	h: HtmlBuilder<Message>,
	options: Readonly<{
		provider: DisconnectProvider
		slotId: string
		model: Dialog.Model
		toParentMessage: (message: Dialog.Message) => Message
		onConfirm: Message
		isPending: boolean
		/** The connection's own name in the title, in place of the provider's. */
		subject?: string
		description?: string | ReadonlyArray<Html | string>
		children?: ReadonlyArray<Html | string>
	}>,
): Html => {
	const spec = disconnectSpec(options.provider)
	const description = options.description ?? spec.description
	return confirmDialog(h, {
		slotId: options.slotId,
		model: options.model,
		toParentMessage: options.toParentMessage,
		title: disconnectTitle(options.subject ?? spec.subject),
		description: description === "" ? undefined : description,
		children: options.children,
		confirmLabel: "Disconnect",
		isPending: options.isPending,
		onConfirm: options.onConfirm,
	})
}

/** The providers whose disconnect runs the page's shared `Disconnect` command. */
export type SharedDisconnect = Exclude<DisconnectProvider, "aws" | "gcp" | "chat">

/** The page's shared disconnect dialog for one integration, opened by `ClickedDisconnect`. */
export const disconnectDialog = (
	h: HtmlBuilder<Message>,
	model: Model,
	integration: SharedDisconnect,
): Html =>
	disconnectConfirm(h, {
		provider: integration,
		slotId: "integration-disconnect",
		model: model.disconnect.dialog,
		toParentMessage: (message) => Message.GotDisconnectDialogMessage({ message }),
		onConfirm: Message.ConfirmedDisconnect(),
		isPending: model.disconnect.isPending,
	})
