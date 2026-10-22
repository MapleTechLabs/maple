import { makeChatSessionId } from "@maple/domain/chat-session"
import { Option, Result } from "effect"
import { Command, type Update } from "foldkit"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import * as Tooltip from "../../../ui/tooltip"
import { SignalPresenceData } from "../../kit/signal-presence"
import { OutMessage as ConversationOut } from "../conversation/message"
import { activeContextsOf, pageContextPreamble } from "../kit/preamble"
import * as Conversation from "../conversation/update"
import {
	CreateSheetTab,
	EnsureStoredTab,
	LoadKnownServices,
	LoadPresence,
	ReadSheetTab,
	ReleaseFocus,
	RenameStoredTab,
} from "./command"
import { init as initSheet, Message, type Model, OutMessage } from "./model"

export type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

/** The page the sheet was opened over, as the first message's context block. */
const sendContext = (model: Model): Conversation.SendContext => ({
	preamble: pageContextPreamble(
		model.referrerPath,
		activeContextsOf(model.referrerPath, model.dismissedContexts),
	),
})

const withCommands = (result: Return, commands: Commands): Return => ({
	...result,
	commands: [...(result.commands ?? []), ...commands],
})

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => {
	const closed = step.outMessage?._tag === "Closed"
	// The content mounts only while open: closing drops the conversation (history reloads on reopen).
	const next: Model = closed ? { ...initSheet(), dialog: step.model } : { ...model, dialog: step.model }
	return {
		model: next,
		commands: [
			...Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
			...(closed ? [ReleaseFocus()] : []),
		],
	}
}

const liftConversation = (model: Model, step: Conversation.Return): Return => {
	const next: Model = { ...model, conversation: step.model }
	const tabId = step.model.tabId
	const commands = Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotConversationMessage({ tabId, message }),
	)
	const out = Option.fromNullishOr(step.outMessage)
	const lifted: Return = Option.match(out, {
		onNone: () => ({ model: next, commands }),
		onSome: (message) =>
			ConversationOut.match<Return>(message, {
				SentFirstMessage: ({ title }) => ({
					model: next,
					commands:
						model.orgId === null
							? commands
							: [
									...commands,
									RenameStoredTab({ orgId: model.orgId, tabId: model.tabId, title }),
								],
				}),
				RequestedToast: ({ type, title }) => ({
					model: next,
					commands,
					outMessage: OutMessage.RequestedToast({ type, title }),
				}),
			}),
	})
	const hasMessages = (step.model.messages.length ?? 0) > 0
	return hasMessages && !model.isKnownServicesRequested
		? withCommands({ ...lifted, model: { ...lifted.model, isKnownServicesRequested: true } }, [
				LoadKnownServices(),
			])
		: lifted
}

const updateTooltip = (model: Model, message: Tooltip.Message): Return => {
	const step = Tooltip.update(model.tooltip, message)
	return {
		model: { ...model, tooltip: step.model },
		commands: Command.mapMessages(step.commands ?? [], (child) =>
			Message.GotTooltipMessage({ message: child }),
		),
	}
}

const startConversation = (model: Model, orgId: string, tabId: string, referrerPath: string | null): Return =>
	liftConversation(
		{ ...model, orgId, tabId, referrerPath, dismissedContexts: [] },
		Conversation.init(tabId, makeChatSessionId(orgId, tabId)),
	)

/** `orgId` is the session's org; the sheet does nothing without one (`if (!orgId) return null`). */
export const update = (model: Model, message: Message, orgId: string | null): Return =>
	Message.match<Return>(message, {
		RequestedOpen: ({ viaKeyboard }) =>
			orgId === null || model.dialog.isOpen
				? { model }
				: withCommands(
						liftDialog(
							{
								...model,
								orgId,
								isInitialFocusPointer: !viaKeyboard,
								presence: SignalPresenceData.Loading(),
							},
							Dialog.open(model.dialog),
						),
						[ReadSheetTab({ orgId }), LoadPresence({ orgId })],
					),
		CompletedReadSheetTab: ({ orgId: forOrg, tabId, nowMs, referrerPath }) =>
			!model.dialog.isOpen || forOrg !== model.orgId
				? { model }
				: startConversation({ ...model, nowMs }, forOrg, tabId, referrerPath),
		GotDialogMessage: ({ message: child }) => liftDialog(model, Dialog.update(model.dialog, child)),
		// Focus leaving a header button ends the pointer-opened initial focus.
		GotTooltipMessage: ({ message: child }) =>
			updateTooltip(
				child._tag === "BlurredTrigger" ? { ...model, isInitialFocusPointer: false } : model,
				child,
			),
		MovedOverTrigger: ({ triggerId }) =>
			model.tooltip.isOpen && model.tooltip.triggerId === triggerId
				? { model }
				: updateTooltip(model, Tooltip.Message.EnteredTrigger({ triggerId })),
		FocusedVisibleTrigger: ({ triggerId }) =>
			model.isInitialFocusPointer
				? { model }
				: updateTooltip(
						model,
						Tooltip.Message.CheckedFocusVisible({ triggerId, isFocusVisible: true }),
					),
		ClickedNewChat: () =>
			model.orgId === null ? { model } : { model, commands: [CreateSheetTab({ orgId: model.orgId })] },
		CreatedSheetTab: ({ orgId: forOrg, tabId, referrerPath }) =>
			!model.dialog.isOpen || forOrg !== model.orgId
				? { model }
				: startConversation(model, forOrg, tabId, referrerPath),
		DismissedContext: ({ id }) =>
			model.dismissedContexts.includes(id)
				? { model }
				: { model: { ...model, dismissedContexts: [...model.dismissedContexts, id] } },
		ClickedOpenFullPage: () =>
			model.orgId === null
				? { model }
				: withCommands(liftDialog(model, Dialog.close(model.dialog)), [
						EnsureStoredTab({ orgId: model.orgId, tabId: model.tabId }),
					]),
		CompletedEnsureStoredTab: () => ({ model }),
		CompletedRenameStoredTab: () => ({ model }),
		GotConversationMessage: ({ tabId, message: child }) =>
			model.conversation === null || model.conversation.tabId !== tabId
				? { model }
				: liftConversation(model, Conversation.update(model.conversation, child, sendContext(model))),
		CompletedLoadPresence: ({ orgId, result }) =>
			orgId !== model.orgId
				? { model }
				: {
						model: {
							...model,
							presence: Result.match(result, {
								onSuccess: (data) => SignalPresenceData.Success({ data }),
								onFailure: (error) => SignalPresenceData.Failure({ error }),
							}),
						},
					},
		CompletedLoadKnownServices: ({ services }) => ({ model: { ...model, knownServices: services } }),
		CompletedMountScroller: () => ({ model }),
		CompletedReleaseFocus: () => ({ model }),
	})

/**
 * The session's org moved under an open sheet: `<GlobalChatPanel key={orgId}>` remounts on the
 * new org's thread, and without an org (signed out) the sheet renders nothing.
 */
export const sessionChanged = (model: Model, orgId: string | null): Return =>
	model.orgId === null || model.orgId === orgId
		? { model }
		: orgId === null
			? liftDialog(model, Dialog.close(model.dialog))
			: {
					model: {
						...initSheet(),
						dialog: model.dialog,
						orgId,
						presence: SignalPresenceData.Loading(),
					},
					commands: [ReadSheetTab({ orgId }), LoadPresence({ orgId })],
				}
