import { Option, Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { modalKeys } from "./error-modal-command"
import { Message } from "./message"
import type { Model } from "./model"

// The error modal's window keys (↑/↓ step groups, j/k step samples), for as long as it is open.

/** The open group's place in the Errors read, which decides whether ↑/↓ step at all. */
const positionOf = (model: Model) => {
	const fingerprints = Option.match(AsyncData.getData(model.errors.data), {
		onNone: (): ReadonlyArray<string> => [],
		onSome: (errors) => errors.data.map((row) => row.fingerprint),
	})
	return { index: fingerprints.indexOf(model.errorModal.fingerprint ?? ""), total: fingerprints.length }
}

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	errorModalKeys: entry(
		{ isOpen: Schema.Boolean, index: Schema.Number, total: Schema.Number },
		{
			modelToDependencies: ({ model }) => ({ isOpen: model.errorModal.dialog.isOpen, ...positionOf(model) }),
			dependenciesToStream: ({ isOpen, index, total }) =>
				isOpen
					? Stream.map(modalKeys({ index, total }), (message) => Message.GotErrorModalMessage({ message }))
					: Stream.empty,
		},
	),
}))
