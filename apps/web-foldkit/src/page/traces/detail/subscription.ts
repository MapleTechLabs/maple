import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"

// `useAppHotkey("list.clear", handleCloseSpanDetails, { enabled: selectedSpan !== null })`:
// Escape anywhere but a field closes the span panel; an open dialog or sheet keeps its own Escape.

const escapes: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) =>
		event.key !== "Escape" || isEditableTarget(event.target) || isDialogOpen()
			? Option.none()
			: Option.some(Message.PressedPageEscape()),
})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	escapeClosesSpan: entry(
		{ hasSpan: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ hasSpan: model.search.spanId !== undefined }),
			dependenciesToStream: ({ hasSpan }) => (hasSpan ? escapes : Stream.empty),
		},
	),
}))
