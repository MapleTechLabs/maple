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
import {
	OutMessage as ConversationOut,
	type Message as ConversationMessage,
} from "../../chat/conversation/message"
import type { ReadOnly } from "../../chat/conversation/model"
import * as Conversation from "../../chat/conversation/update"
import { LoadKnownServices } from "./command"
import { investigationOf, tabOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The Chat and Transcript tabs: `ChatConversation` in investigation mode over the chat area's
// conversation. The server seeded the thread's subject, so no context preamble is sent.

type Return = PageReturn<Model, Message>

const SEEDED_BY_SERVER: Conversation.SendContext = { preamble: "" }

const factValue = (facts: V2Investigation["snapshot"]["facts"], label: string): string | undefined =>
	facts.find((fact) => fact.label.toLowerCase() === label)?.value

const factKey = (label: string): string =>
	label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "")

/** `contextFromInvestigation`: the subject as the chat knows it. */
export const contextOf = (investigation: V2Investigation): InvestigationContext => {
	const { subject, snapshot } = investigation
	const kind =
		subject.type === "freeform"
			? "freeform"
			: subject.type === "fix_verification"
				? "error"
				: subject.incident_kind
	const signalType = factValue(snapshot.facts, "signal")
	const id =
		subject.type === "freeform"
			? investigation.id
			: subject.type === "fix_verification"
				? subject.issue_id
				: subject.incident_id
	return {
		kind,
		id,
		title: snapshot.title,
		severity: investigation.severity ?? snapshot.severity ?? "unclassified",
		status: investigation.status,
		...(signalType ? { signalType } : undefined),
		...(snapshot.scope ? { scope: snapshot.scope } : undefined),
		facts: snapshot.facts.map((fact) => ({
			key: factKey(fact.label),
			label: fact.label,
			value: fact.value,
		})),
		refs:
			subject.type === "incident"
				? {
						incidentId: subject.incident_id,
						...(subject.issue_id ? { issueId: subject.issue_id } : undefined),
						...(snapshot.scope ? { serviceName: snapshot.scope } : undefined),
					}
				: subject.type === "fix_verification"
					? {
							issueId: subject.issue_id,
							...(snapshot.scope ? { serviceName: snapshot.scope } : undefined),
						}
					: undefined,
		...(investigation.report
			? {
					aiSummary: investigation.report.summary,
					aiSuspectedCause: investigation.report.suspectedCause,
				}
			: undefined),
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
					SentFirstMessage: () => undefined,
					RequestedToast: ({ type, title }) =>
						PageOutMessage.RequestedToast({ type, title, description: "" }),
				}),
})

/**
 * Mounts the thread the first time a conversation tab shows (`tabId` `inv-<subject id>`), and keeps
 * its read-only reading in step with the tab: the same thread serves Chat and Transcript.
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
	const tabId = `inv-${investigation.value.id}`
	return followKnownServices(
		liftConversation(model, Conversation.init(tabId, makeChatSessionId(context.orgId, tabId), readOnly)),
	)
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
		: followKnownServices(
				liftConversation(model, Conversation.update(model.conversation, message, SEEDED_BY_SERVER)),
			)

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
