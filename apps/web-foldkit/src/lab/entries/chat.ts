import type { AutoContext } from "../../components/chat/auto-contexts"
import { cn } from "@maple/ui/lib/utils"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Message as ConversationMessage } from "../../page/chat/conversation/message"
import { Model as ConversationModel } from "../../page/chat/conversation/model"
import * as Conversation from "../../page/chat/conversation/update"
import { themeMount, transcriptHostOf } from "../../page/chat/conversation/view"
import { LoadKnownServices } from "../../page/chat/page/command"
import { approvalCard } from "../../page/chat/kit/view-cards"
import { composer, contextChips } from "../../page/chat/kit/view-composer"
import { MountMessageScroller } from "../../page/chat/kit/scroller"
import { transcript } from "../../page/chat/kit/view-transcript"
import type { Resources } from "../../platform/resources"
import * as Toast from "../../ui/toast"
import { viewerFlags } from "../../ui/logs/viewer"
import { buildChatLabMessages } from "../chat-fixture"
import { defineLabWithFlags } from "../define"
import { foldLabToasts, initLabToasts, labRoot } from "../toasts"

// `/lab/chat`: the real transcript over a fixture thread, at the
// page, sheet and narrow widths, idle or streaming, with the composer's context tray.

const WIDTHS = [
	{ label: "Page (768px)", value: 768 },
	{ label: "Sheet (620px)", value: 620 },
	{ label: "Narrow (420px)", value: 420 },
] as const

/** The composer's tray: a long subject and a subject-less chip. */
const LAB_CONTEXTS: ReadonlyArray<AutoContext> = [
	{ kind: "service_map", id: "service_map" },
	{ kind: "service", id: "service:checkout", serviceName: "checkout-api-eu-west" },
	{ kind: "trace", id: "trace:9f2c", traceId: "9f2c41b8ad0e4c1f" },
	{ kind: "container", id: "container:ingest", containerName: "ingest-gateway" },
]

const Flags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String, locale: Schema.String })
type Flags = typeof Flags.Type

const Model = Schema.Struct({
	conversation: ConversationModel,
	width: Schema.Number,
	isLoading: Schema.Boolean,
	dismissedContexts: Schema.Array(Schema.String),
	knownServices: Schema.Array(Schema.String),
	nowMs: Schema.Number,
	timeZone: Schema.String,
	toasts: Toast.Model,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	ClickedWidth: { width: Schema.Number },
	ToggledStreaming: {},
	DismissedContext: { id: Schema.String },
	ClickedLabApprove: { toolCallId: Schema.String },
	ClickedLabDeny: { toolCallId: Schema.String },
	GotConversationMessage: { message: ConversationMessage },
	CompletedLoadKnownServices: { services: Schema.Array(Schema.String) },
	CompletedMountScroller: {},
	GotToastMessage: { message: Toast.Message },
})
type Message = typeof Message.Type

type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const liftConversation = (model: Model, step: Conversation.Return): Return => ({
	model: { ...model, conversation: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotConversationMessage({ message })),
})

const NO_CONTEXT: Conversation.SendContext = { preamble: "" }

const init = (flags: Flags): Return => {
	const started = Conversation.withMessages(Conversation.init("lab", "org_lab:lab"), buildChatLabMessages(flags.nowMs))
	// The fixture is the history: the conversation's own history read never runs here.
	const lifted = liftConversation(
		{
			conversation: started.model,
			width: 768,
			isLoading: false,
			dismissedContexts: [],
			knownServices: [],
			nowMs: flags.nowMs,
			timeZone: flags.timeZone,
			toasts: initLabToasts(),
		},
		{ ...started, commands: (started.commands ?? []).filter((command) => command.name !== "LoadChatHistory") },
	)
	return { ...lifted, commands: [...(lifted.commands ?? []), LoadKnownServices()] }
}

const resolve = (model: Model, toolCallId: string, outcome: "applied" | "denied"): Return => ({
	model: {
		...model,
		conversation: {
			...model.conversation,
			resolvedApprovals: { ...model.conversation.resolvedApprovals, [toolCallId]: outcome },
		},
	},
})

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedWidth: ({ width }) => ({ model: { ...model, width } }),
		// The transcript reads `isLoading`; the composer shows the streaming submit with nothing to stop.
		ToggledStreaming: () => {
			const isLoading = !model.isLoading
			return {
				model: { ...model, isLoading, conversation: { ...model.conversation, status: isLoading ? "streaming" : "ready" } },
			}
		},
		DismissedContext: ({ id }) => ({ model: { ...model, dismissedContexts: [...model.dismissedContexts, id] } }),
		ClickedLabApprove: ({ toolCallId }) => resolve(model, toolCallId, "applied"),
		ClickedLabDeny: ({ toolCallId }) => resolve(model, toolCallId, "denied"),
		GotConversationMessage: ({ message: child }) =>
			// `PromptInput onSubmit={() => {}}`: the lab's composer sends nothing.
			child._tag === "SubmittedComposer"
				? { model: { ...model, conversation: { ...model.conversation, draft: "" } } }
				: liftConversation(model, Conversation.update(model.conversation, child, NO_CONTEXT)),
		CompletedLoadKnownServices: ({ services }) => ({ model: { ...model, knownServices: services } }),
		CompletedMountScroller: () => ({ model }),
		GotToastMessage: ({ message: child }) => foldToasts(model, child),
	})

type H = HtmlBuilder<Message>

const toConversation = (message: ConversationMessage) => Message.GotConversationMessage({ message })

const toolbarButton = (h: H, label: string, isActive: boolean, onClick: Message): Html =>
	h.button(
		[
			h.Class(cn("rounded-md border px-2 py-1 transition-colors hover:bg-accent", isActive && "bg-accent")),
			h.Type("button"),
			h.OnClick(onClick),
		],
		[label],
	)

const labView = (model: Model, h: H): Html => {
	const conversation = model.conversation
	const host = transcriptHostOf(h, conversation, {
		toMessage: toConversation,
		timeZone: model.timeZone,
		textareaId: "lab-chat-composer",
		placeholder: "Ask about your system…",
		emptyState: () => h.p([h.Class("text-sm text-muted-foreground")], ["Nothing here yet."]),
		chips: [],
		scrollerMount: MountMessageScroller({ focusMessageId: null }),
		knownServices: new Set(model.knownServices),
		nowMs: model.nowMs,
		ownCard: (part) =>
			part.state !== "proposed"
				? null
				: approvalCard(h, {
						toolName: part.toolName,
						input: part.input,
						resolved: conversation.resolvedApprovals[part.toolCallId],
						isRawOpen: conversation.openPanels.includes(`raw:${part.toolCallId}`),
						isDeciding: false,
						onToggleRaw: toConversation(ConversationMessage.ToggledPanel({ id: `raw:${part.toolCallId}` })),
						onApprove: Message.ClickedLabApprove({ toolCallId: part.toolCallId }),
						onDeny: Message.ClickedLabDeny({ toolCallId: part.toolCallId }),
					}),
	})
	const contexts = LAB_CONTEXTS.filter((context) => !model.dismissedContexts.includes(context.id))
	return h.div(
		[h.Class("flex h-screen flex-col bg-background"), h.OnMount(themeMount(toConversation))],
		[
			h.div(
				[h.Class("flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs")],
				[
					h.span([h.Class("font-semibold")], ["Chat transcript"]),
					...WIDTHS.map((option) =>
						toolbarButton(h, option.label, model.width === option.value, Message.ClickedWidth({ width: option.value })),
					),
					toolbarButton(h, model.isLoading ? "Streaming" : "Idle", model.isLoading, Message.ToggledStreaming()),
				],
			),
			h.div(
				[h.Class("flex min-h-0 flex-1 justify-center")],
				[
					h.div(
						[h.Class("flex min-h-0 flex-col border-x"), h.Style({ width: `${model.width}px` })],
						[
							transcript(h, { ...host, isLoading: model.isLoading }, conversation.messages, () =>
								h.p([h.Class("text-sm text-muted-foreground")], ["Nothing here yet."]),
							),
							h.div(
								[h.Class("shrink-0 px-4 pb-4")],
								[
									composer(h, {
										textareaId: "lab-chat-composer",
										draft: conversation.draft,
										placeholder: "Ask about your system…",
										status: model.isLoading ? "streaming" : "ready",
										onStop: undefined,
										isDisabled: false,
										onInput: (text) => toConversation(ConversationMessage.ChangedDraft({ text })),
										onSubmit: toConversation(ConversationMessage.SubmittedComposer()),
										chips: contextChips(h, contexts, (id) => Message.DismissedContext({ id })),
									}),
								],
							),
						],
					),
				],
			),
		],
	)
}

export const lab = defineLabWithFlags<Model, Message, Flags>("Chat transcript", {
	Model,
	Flags,
	flags: Effect.zipWith(viewerFlags, Clock.currentTimeMillis, (viewer, nowMs) => ({ ...viewer, nowMs })),
	init,
	update,
	view: (model, h) => labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), labView(model, h)),
})

