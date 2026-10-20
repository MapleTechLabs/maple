import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { captureChatReferrer } from "../../../components/chat/auto-contexts"
import { Effect, Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
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

const openEvents: Stream.Stream<Message> = Dom.streamFromEvent({
	target: openTarget,
	type: OPEN_CHAT_EVENT,
	mapEvent: (event) =>
		Message.RequestedOpen({ viaKeyboard: event instanceof CustomEvent && event.detail === FOCUS_VISIBLE_OPEN }),
})

const shortcut: Stream.Stream<Message> = Dom.streamFromEventFilterMapPreventDefault({
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

export const subscriptions = Subscription.make<SheetHost, Message, Resources>()((entry) => ({
	open: entry(
		{ isSignedIn: Schema.Boolean, isTypeAnywhere: Schema.Boolean },
		{
			modelToDependencies: ({ isSignedIn, isTypeAnywhere }) => ({ isSignedIn, isTypeAnywhere }),
			dependenciesToStream: ({ isSignedIn, isTypeAnywhere }) =>
				!isSignedIn ? Stream.empty : isTypeAnywhere ? openEvents : Stream.merge(openEvents, shortcut),
		},
	),
	/** `captureChatReferrer(pathname)`: the page a chat opens over, for its context chips. */
	referrer: entry(
		{ pathname: Schema.String },
		{
			modelToDependencies: ({ pathname }) => ({ pathname }),
			dependenciesToStream: ({ pathname }) => Stream.fromEffectDrain(Effect.sync(() => captureChatReferrer(pathname))),
		},
	),
	tail: entry(
		{ tails: Schema.Array(Tail) },
		{
			modelToDependencies: ({ sheet }) => ({ tails: sheet.conversation === null ? [] : tailOf(sheet.conversation) }),
			dependenciesToStream: ({ tails }) =>
				tails.length === 0 ? Stream.empty : tailsMessages(tails, (tabId, message) => Message.GotConversationMessage({ tabId, message })),
		},
	),
}))
