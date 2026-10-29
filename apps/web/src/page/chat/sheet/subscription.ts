import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { captureChatReferrer } from "../../../components/chat/auto-contexts"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { Tail, tailOf, tailsMessages } from "../conversation/subscription"
import { Message, type Model } from "./model"

// `GlobalChatSheet`'s listeners: `openGlobalChat()`'s document event, and `C` outside a field.
// The open sheet's conversation tails its live turn here too.

/** `OPEN_CHAT_EVENT`: whoever wants the sheet (the top bar, the command palette) dispatches it. */
export const OPEN_CHAT_EVENT = "maple:open-chat-sheet"

/** The event's detail when focus that lands in the sheet stays `:focus-visible` (from the palette's input). */
const FOCUS_VISIBLE_OPEN = "focus-visible"

/** `openGlobalChat()`. */
export const openGlobalChat = (options: Readonly<{ isFocusVisible?: boolean }> = {}): void => {
	document.dispatchEvent(
		new CustomEvent(OPEN_CHAT_EVENT, options.isFocusVisible === true ? { detail: FOCUS_VISIBLE_OPEN } : {}),
	)
}

const openTarget = (): Dom.TypedEventTarget<{ [OPEN_CHAT_EVENT]: Event }> => document

type RequestedOpen = ReturnType<typeof Message.RequestedOpen>

const openEvents: Stream.Stream<RequestedOpen> = Dom.streamFromEvent({
	target: openTarget,
	type: OPEN_CHAT_EVENT,
	mapEvent: (event) =>
		Message.RequestedOpen({ viaKeyboard: event instanceof CustomEvent && event.detail === FOCUS_VISIBLE_OPEN }),
})

const shortcut: Stream.Stream<RequestedOpen> = Dom.streamFromEventFilterMapPreventDefault({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) =>
		event.key.toLowerCase() !== "c" || event.metaKey || event.ctrlKey || event.altKey
			? Option.none()
			: isEditableTarget(event.target) || isDialogOpen()
				? Option.none()
				: Option.some(Message.RequestedOpen({ viaKeyboard: true })),
})

/** `isTypeAnywhere`: `/chat`'s composer takes printable keys first (`useTypeAnywhereFocus`, capture phase). */
export type SheetHost = Readonly<{ sheet: Model; isSignedIn: boolean; isTypeAnywhere: boolean; pathname: string }>

/** Handler names carry the sheet's owner prefix, so they never collide with another registry's. */
export const subscriptions = Subscription.make<SheetHost, Message>()((entry) => ({
	open: entry(
		"ChatSheet/OpenRequests",
		{ isSignedIn: Schema.Boolean, isTypeAnywhere: Schema.Boolean },
		{
			messages: [Message.RequestedOpen],
			modelToDependencies: ({ isSignedIn, isTypeAnywhere }) => ({ isSignedIn, isTypeAnywhere }),
			handler: function* () {
				return ({ isSignedIn, isTypeAnywhere }) =>
					!isSignedIn ? Stream.empty : isTypeAnywhere ? openEvents : Stream.merge(openEvents, shortcut)
			},
		},
	),
	/** `captureChatReferrer(pathname)`: the page a chat opens over, for its context chips. */
	referrer: entry(
		"ChatSheet/CaptureReferrer",
		{ pathname: Schema.String },
		{
			messages: [],
			modelToDependencies: ({ pathname }) => ({ pathname }),
			handler: function* () {
				return ({ pathname }) => Stream.fromEffectDrain(Effect.sync(() => captureChatReferrer(pathname)))
			},
		},
	),
	tail: entry(
		"ChatSheet/ConversationTail",
		{ tails: Schema.Array(Tail) },
		{
			messages: [Message.GotConversationMessage],
			modelToDependencies: ({ sheet }) => ({ tails: sheet.conversation === null ? [] : tailOf(sheet.conversation) }),
			handler: function* () {
				return ({ tails }) =>
					tails.length === 0
						? Stream.empty
						: tailsMessages(tails, (tabId, message) => Message.GotConversationMessage({ tabId, message }))
			},
		},
	),
}))

/** The registry's handler Layers; whoever lifts `subscriptions` merges this into its EffectsLayer. */
export const SubscriptionsLayer = Layer.mergeAll(
	subscriptions.open.layer,
	subscriptions.referrer.layer,
	subscriptions.tail.layer,
)
