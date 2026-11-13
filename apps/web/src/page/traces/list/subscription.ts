import { isDialogOpen } from "@maple/ui/lib/keyboard"
import { Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { listKeys } from "../../kit/list-keys"
import { MOBILE_QUERY } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { allRows } from "./update"

// List navigation over the rows and the peek sheet's keys (↑/↓/J/K step, Enter opens the page): document keys while no field has focus. The peek's keys work with its sheet open.

const keys = (isPeeking: boolean): Stream.Stream<Message> =>
	listKeys({
		extraKeys: ["f", "F"],
		// The sheet's Escape is the Dialog's; without a peek, a dialog owns the keyboard.
		isBlocked: (key) => (isPeeking ? key === "Escape" : isDialogOpen()),
		toMessage: (key) =>
			Message.PressedListKey({ key, isMobile: window.matchMedia(MOBILE_QUERY).matches }),
	})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	listKeys: entry(
		{ hasRows: Schema.Boolean, isPeeking: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				hasRows: allRows(model).length > 0,
				isPeeking: model.search.peek !== undefined,
			}),
			dependenciesToStream: ({ hasRows, isPeeking }) =>
				hasRows || isPeeking ? keys(isPeeking) : Stream.empty,
		},
	),
}))
