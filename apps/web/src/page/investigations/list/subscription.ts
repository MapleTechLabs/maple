import { Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { listKeys } from "../../kit/list-keys"
import { focusableOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The list's keys, from anywhere on the page, while it shows rows. An open select keeps its arrows.

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	listKeys: entry(
		{ hasRows: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				hasRows:
					focusableOf(model).length > 0 && !model.kindSelect.isOpen && !model.sortSelect.isOpen,
			}),
			dependenciesToStream: ({ hasRows }) =>
				hasRows ? listKeys({ toMessage: (key) => Message.PressedListKey({ key }) }) : Stream.empty,
		},
	),
}))
