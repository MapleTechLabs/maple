import { makeChatSessionId } from "@maple/domain/chat-session"
import { Option, Result } from "effect"
import { Command, type Update } from "foldkit"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import * as Tooltip from "../../../ui/tooltip"
import { SignalPresenceData } from "../../kit/signal-presence"
import { OutMessage as ConversationOut } from "../conversation/message"
import * as Conversation from "../conversation/update"
import {
	CreateSheetTab,
	EnsureStoredTab,
	LoadKnownServices,
	LoadPresence,
	ReadSheetTab,
	RenameStoredTab,
} from "./command"
import { init as initSheet, Message, type Model, OutMessage } from "./model"

export type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

const NO_CONTEXT: Conversation.SendContext = { preamble: "" }

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
		commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
	}
}

const liftConversation = (model: Model, step: Conversation.Return): Return => {
	const next: Model = { ...model, conversation: step.model }
	const commands = Command.mapMessages(step.commands ?? [], (message) => Message.GotConversationMessage({ message }))
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
							: [...commands, RenameStoredTab({ orgId: model.orgId, tabId: model.tabId, title })],
				}),
				RequestedToast: ({ type, title }) => ({ model: next, commands, outMessage: OutMessage.RequestedToast({ type, title }) }),
			}),
	})
	const hasMessages = (step.model.messages.length ?? 0) > 0
	return hasMessages && !model.isKnownServicesRequested
		? withCommands({ ...lifted, model: { ...lifted.model, isKnownServicesRequested: true } }, [LoadKnownServices()])
		: lifted
}

const updateTooltip = (model: Model, message: Tooltip.Message): Return => {
	const step = Tooltip.update(model.tooltip, message)
	return {
		model: { ...model, tooltip: step.model },
		commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotTooltipMessage({ message: child })),
	}
}

const startConversation = (model: Model, orgId: string, tabId: string): Return =>
	liftConversation({ ...model, orgId, tabId }, Conversation.init(tabId, makeChatSessionId(orgId, tabId)))

/** `orgId` is the session's org; the sheet does nothing without one (`if (!orgId) return null`). */
export const update = (model: Model, message: Message, orgId: string | null): Return =>
	Message.match<Return>(message, {
		RequestedOpen: ({ viaKeyboard }) =>
			orgId === null || model.dialog.isOpen
				? { model }
				: withCommands(liftDialog({ ...model, orgId, isInitialFocusPointer: !viaKeyboard }, Dialog.open(model.dialog)), [
						ReadSheetTab({ orgId }),
					]),
		CompletedReadSheetTab: ({ orgId: forOrg, tabId, nowMs }) =>
			!model.dialog.isOpen || forOrg !== model.orgId
				? { model }
				: startConversation({ ...model, nowMs }, forOrg, tabId),
		GotDialogMessage: ({ message: child }) => liftDialog(model, Dialog.update(model.dialog, child)),
		// Focus leaving a header button ends the pointer-opened initial focus.
		GotTooltipMessage: ({ message: child }) =>
			updateTooltip(child._tag === "BlurredTrigger" ? { ...model, isInitialFocusPointer: false } : model, child),
		MovedOverTrigger: ({ triggerId }) =>
			model.tooltip.isOpen && model.tooltip.triggerId === triggerId
				? { model }
				: updateTooltip(model, Tooltip.Message.EnteredTrigger({ triggerId })),
		FocusedVisibleTrigger: ({ triggerId }) =>
			model.isInitialFocusPointer
				? { model }
				: updateTooltip(model, Tooltip.Message.FocusedTrigger({ triggerId })),
		ClickedNewChat: () => (model.orgId === null ? { model } : { model, commands: [CreateSheetTab({ orgId: model.orgId })] }),
		// A fresh conversation mounts a fresh empty state, which asks for the signal presence again.
		CreatedSheetTab: ({ orgId: forOrg, tabId }) =>
			!model.dialog.isOpen || forOrg !== model.orgId
				? { model }
				: startConversation({ ...model, isPresenceRequested: false }, forOrg, tabId),
		ClickedOpenFullPage: () =>
			model.orgId === null
				? { model }
				: withCommands(liftDialog(model, Dialog.close(model.dialog)), [EnsureStoredTab({ orgId: model.orgId, tabId: model.tabId })]),
		CompletedEnsureStoredTab: () => ({ model }),
		CompletedRenameStoredTab: () => ({ model }),
		GotConversationMessage: ({ message: child }) =>
			model.conversation === null ? { model } : liftConversation(model, Conversation.update(model.conversation, child, NO_CONTEXT)),
		PaintedEmptyState: () =>
			model.isPresenceRequested
				? { model }
				: { model: { ...model, isPresenceRequested: true, presence: SignalPresenceData.Loading() }, commands: [LoadPresence()] },
		CompletedLoadPresence: ({ result }) => ({
			model: {
				...model,
				presence: Result.match(result, {
					onSuccess: (data) => SignalPresenceData.Success({ data }),
					onFailure: (error) => SignalPresenceData.Failure({ error }),
				}),
			},
		}),
		CompletedLoadKnownServices: ({ services }) => ({ model: { ...model, knownServices: services } }),
		CompletedMountScroller: () => ({ model }),
	})
