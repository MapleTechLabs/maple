import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Option, Schema, Stream } from "effect"
import { AsyncData, Dom, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { Message } from "./message"
import type { Model, SessionView } from "./model"

// `useAppHotkey("session.view*")` (session-views.tsx): 1/2/3/4 switch views from anywhere on the page.

const VIEW_KEYS = new Map<string, SessionView>([
	["1", "overview"],
	["2", "trace"],
	["3", "flow"],
	["4", "transcript"],
])

const viewKeys: Stream.Stream<Message> = Dom.streamFromEventFilterMapPreventDefault({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) => {
		const view = VIEW_KEYS.get(event.key)
		if (view === undefined || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
			return Option.none()
		if (isEditableTarget(event.target) || isDialogOpen()) return Option.none()
		return Option.some(Message.PressedViewKey({ view }))
	},
})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	/** Only once the views are on the page: the loading and not-found states have no switcher. */
	viewKeys: entry(
		{ hasViews: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				hasViews: Option.exists(
					AsyncData.getData(model.firstPage.data),
					(page) => page.data.length > 0,
				),
			}),
			dependenciesToStream: ({ hasViews }) => (hasViews ? viewKeys : Stream.empty),
		},
	),
}))
