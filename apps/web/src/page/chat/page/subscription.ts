import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { Tail, tailOf, tailsMessages } from "../conversation/subscription"
import { Message } from "./message"
import type { Model } from "./model"

// The live tails, `Mod+Shift+O` (new tab) and type-anywhere (`useTypeAnywhereFocus("page")`).

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)

const newChatKey: Stream.Stream<Message> = Dom.streamFromEventFilterMapPreventDefault({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) => {
		const mod = isMac() ? event.metaKey : event.ctrlKey
		return mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o"
			? Option.some(Message.PressedNewChatKey())
			: Option.none()
	},
})

const typeAnywhere: Stream.Stream<Message> = Dom.streamFromEventFilterMapPreventDefault({
	target: () => window,
	type: "keydown",
	filterMapEvent: (event) => {
		if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return Option.none()
		if (isEditableTarget(event.target) || isDialogOpen()) return Option.none()
		return Option.some(Message.TypedAnywhere({ char: event.key }))
	},
})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		tails: entry(
			{ tails: Schema.Array(Tail) },
			{
				modelToDependencies: ({ model }) => ({
					tails: Object.values(model.conversations).flatMap(tailOf),
				}),
				dependenciesToStream: ({ tails }) =>
					tails.length === 0
						? Stream.empty
						: tailsMessages(tails, (tabId, message) =>
								Message.GotConversationMessage({ tabId, message }),
							),
			},
		),
		newChatKey: entry(
			{ isTabs: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({
					isTabs: model.shared === null && model.tabs !== null,
				}),
				dependenciesToStream: ({ isTabs }) => (isTabs ? newChatKey : Stream.empty),
			},
		),
		typeAnywhere: entry(
			{ isWritable: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({
					isWritable: model.shared === null && model.tabs !== null,
				}),
				dependenciesToStream: ({ isWritable }) => (isWritable ? typeAnywhere : Stream.empty),
			},
		),
	}),
)
