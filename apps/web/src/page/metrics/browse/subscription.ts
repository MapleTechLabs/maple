import { Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { listKeys } from "../../kit/list-keys"
import { Message } from "./message"
import type { Model } from "./model"
import { tableRows } from "./update"

// The table view's list keys, from anywhere on the page; the grid has none. An open select keeps its arrows.

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	listKeys: entry(
		{ hasRows: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				hasRows: tableRows(model).length > 0 && !model.typeSelect.isOpen,
			}),
			dependenciesToStream: ({ hasRows }) =>
				hasRows ? listKeys({ toMessage: (key) => Message.PressedListKey({ key }) }) : Stream.empty,
		},
	),
}))
