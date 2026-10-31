import { makeChatSessionId } from "@maple/domain/chat-session"
import type { V2Investigation } from "@maple/domain/http/v2"
import {
	type InvestigationContext,
	investigationNoun,
	investigationSuggestions,
} from "./investigation-context"
import { Command } from "foldkit"
import * as Dialog from "../../../ui/dialog"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { OutMessage as ConversationOut, type Message as ConversationMessage } from "../conversation/message"
import type { ReadOnly } from "../conversation/model"
import * as Conversation from "../conversation/update"
import { LoadKnownServices } from "./command"
import { investigationOf, tabOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The Chat and Transcript tabs: the investigation's conversation, whose subject the server
// seeded into the thread.

type Return = PageReturn<Model, Message>

/** The subject as the starter suggestions read it. */
export const contextOf = (investigation: V2Investigation): InvestigationContext => {
	const { subject, snapshot } = investigation
	const kind =
		subject.type === "freeform"
			? "freeform"
			: subject.type === "fix_verification"
				? "error"
				: subject.incident_kind
	const signalType = snapshot.facts.find((fact) => fact.label.toLowerCase() === "signal")?.value
	return {
		kind,
		title: snapshot.title,
		...(signalType ? { signalType } : undefined),
		...(snapshot.scope ? { scope: snapshot.scope } : undefined),
		...(investigation.report ? { aiSuspectedCause: investigation.report.suspectedCause } : undefined),
	}
}

export const suggestionsOf = (investigation: V2Investigation): ReadonlyArray<string> =>
	investigationSuggestions(contextOf(investigation))

export const placeholderOf = (investigation: V2Investigation): string =>
	`Ask about this ${investigationNoun(contextOf(investigation).kind)}…`

const readOnlyOf = (model: Model, investigation: V2Investigation): ReadOnly =>
	tabOf(model) === "transcript" ? "transcript" : investigation.status === "resolved" ? "resolved" : null

const liftConversation = (model: Model, step: Conversation.Return): Return => ({
	model: { ...model, conversation: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotConversationMessage({ message }),
	),
	outMessage:
		step.outMessage === undefined
			? undefined
			: ConversationOut.match(step.outMessage, {
					RequestedToast: ({ type, title }) =>
						PageOutMessage.RequestedToast({ type, title, description: "" }),
				}),
})

/**
 * Mounts the thread (session `<orgId>:inv-<investigation id>`) the first time a conversation tab
 * shows, and keeps its read-only reading in step with the tab: one thread serves Chat and Transcript.
 */
export const followConversation = (model: Model, context: PageContext): Return => {
	const tab = tabOf(model)
	if (tab !== "chat" && tab !== "transcript") return { model }
	const investigation = investigationOf(model)
	if (investigation._tag === "None") return { model }
	const readOnly = readOnlyOf(model, investigation.value)
	if (model.conversation !== null)
		return followKnownServices(
			model.conversation.readOnly === readOnly
				? { model }
				: { model: { ...model, conversation: { ...model.conversation, readOnly } } },
		)
	const sessionId = makeChatSessionId(context.orgId, `inv-${investigation.value.id}`)
	return followKnownServices(liftConversation(model, Conversation.init(sessionId, readOnly)))
}

/** The scroller shows once the thread has a turn or the report leads it: then the provider reads. */
const followKnownServices = (result: Return): Return => {
	const { model } = result
	const { conversation } = model
	const investigation = investigationOf(model)
	if (model.knownServices !== null || conversation === null || investigation._tag === "None") return result
	if (investigation.value.report === null && conversation.messages.length === 0) return result
	return {
		...result,
		model: { ...model, knownServices: [] },
		commands: [...(result.commands ?? []), LoadKnownServices()],
	}
}

export const stepConversation = (model: Model, message: ConversationMessage): Return =>
	model.conversation === null
		? { model }
		: followKnownServices(liftConversation(model, Conversation.update(model.conversation, message)))

const liftReportSheet = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		reportSheet: step.model,
		reportActionIndex: step.outMessage?._tag === "Closed" ? null : model.reportActionIndex,
	},
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotReportSheetMessage({ message }),
	),
})

/** A report card's action row: the card's own sheet opens on it. */
export const openReportAction = (model: Model, index: number): Return =>
	liftReportSheet({ ...model, reportActionIndex: index }, Dialog.open(model.reportSheet))

export const stepReportSheet = (model: Model, message: Dialog.Message): Return =>
	liftReportSheet(model, Dialog.update(model.reportSheet, message))
