import { Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { modalKeys } from "./error-modal-command"
import { Message } from "./message"
import type { Model } from "./model"

// The error modal's window keys (↑/↓ step groups, j/k step samples), for as long as it is open.

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	errorModalKeys: entry(
		{ isOpen: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ isOpen: model.errorModal.dialog.isOpen }),
			dependenciesToStream: ({ isOpen }) =>
				isOpen ? Stream.map(modalKeys, (message) => Message.GotErrorModalMessage({ message })) : Stream.empty,
		},
	),
}))
