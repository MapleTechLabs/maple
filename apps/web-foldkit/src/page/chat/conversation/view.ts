import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { skeleton } from "../../../ui/skeleton"
import { composer, failureNotice } from "../kit/view-composer"
import { type TranscriptHost, transcript } from "../kit/view-transcript"
import { Message } from "./message"
import { isLoading, type Model } from "./model"

// `ChatConversation` (apps/web components/chat/chat-conversation.tsx): transcript, notices, composer.
// TODO(chat-investigation-mode): the investigation and widget-fix subjects (attachment cards, their
// suggestions and empty notices, the widget-fix auto-send) are not ported.

export type ConversationViewOptions<M> = Readonly<{
	toMessage: (message: Message) => M
	timeZone: string
	/** Base UI's `useId` on the composer's textarea. */
	textareaId: string
	placeholder: string
	/** `ChatEmptyState` (or the host's own) for a fresh conversation. */
	emptyState: () => Html
	/** `PageContextChips` inside the composer. */
	chips: ReadonlyArray<Html>
	permalinkFor?: (messageId: string) => string
	scrollerMount: TranscriptHost<M>["scrollerMount"]
	/** Cards the host draws (inline cards, approvals, sub-agents, structured tool output). */
	cards?: Pick<TranscriptHost<M>, "inlineCard" | "ownCard" | "taskCard" | "structured" | "markdownOverrides">
}>

const loadingSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex flex-col gap-3 py-6"), h.AriaHidden(true)],
		[skeleton(h, "h-3 w-1/2"), skeleton(h, "h-3 w-2/3"), skeleton(h, "h-3 w-1/3")],
	)

/** `EmptyNotice`: an eyebrow and a sentence, centred where the thread will be. */
export const emptyNotice = <M>(h: HtmlBuilder<M>, title: string, body: string): Html =>
	h.div(
		[h.Class("flex flex-col items-center justify-center gap-2 text-center")],
		[
			eyebrow(h, { as: "p", variant: "label", className: "flex items-center gap-1.5 text-muted-foreground/70" }, [
				h.span([], [title]),
			]),
			h.p([h.Class("max-w-sm text-sm text-muted-foreground")], [body]),
		],
	)

const emptyStateOf = <M>(h: HtmlBuilder<M>, model: Model, options: ConversationViewOptions<M>): Html => {
	if (!model.historyReady) return loadingSkeleton(h)
	switch (model.readOnly) {
		case "shared":
			return emptyNotice(
				h,
				"Shared conversation",
				"This shared conversation is unavailable or empty. It may have been deleted, or belong to a different workspace than the one you're signed in to.",
			)
		case "resolved":
			return emptyNotice(
				h,
				"Resolved",
				"This investigation was resolved before anything was recorded. Reopen it to pick the thread back up.",
			)
		case "transcript":
			return emptyNotice(
				h,
				"Nothing recorded yet",
				"The agents' reasoning log appears here as the pass runs — every tool call and what it returned.",
			)
		case null:
			return options.emptyState()
	}
}

export const transcriptHostOf = <M>(model: Model, options: ConversationViewOptions<M>): TranscriptHost<M> => ({
	isOpen: (id) => model.openPanels.includes(id),
	onToggle: (id) => options.toMessage(Message.ToggledPanel({ id })),
	markdown: model.markdown,
	timeZone: options.timeZone,
	isLoading: isLoading(model),
	readOnly: model.readOnly,
	copies: model.copies,
	onCopy: (id, message) => options.toMessage(Message.GotCopyMessage({ id, message })),
	scrollerMount: options.scrollerMount,
	permalinkFor: options.permalinkFor,
	...options.cards,
})

const notices = <M>(h: HtmlBuilder<M>, model: Model, options: ConversationViewOptions<M>): ReadonlyArray<Html> => {
	if (model.failedSend !== null) {
		const text = `Message not sent: ${model.failedSend.error}`
		return [
			failureNotice(h, {
				text: ["Message not sent: ", model.failedSend.error],
				actionLabel: "Try again",
				onAction: options.toMessage(Message.ClickedRetrySend({ text: model.failedSend.message })),
				truncateTitle: text,
			}),
		]
	}
	return model.error === null
		? []
		: [
				failureNotice(h, {
					text: ["Response failed: ", model.error],
					actionLabel: "Continue",
					onAction: options.toMessage(Message.ClickedContinue()),
				}),
			]
}

export const conversationView = <M>(h: HtmlBuilder<M>, model: Model, options: ConversationViewOptions<M>): Html => {
	const loading = isLoading(model)
	return h.div(
		[h.Class("flex h-full min-h-0 flex-col")],
		[
			transcript(h, transcriptHostOf(model, options), model.messages, () => emptyStateOf(h, model, options)),
			...(model.readOnly !== null
				? []
				: [
						h.div(
							[h.Class("mx-auto w-full max-w-3xl shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]")],
							[
								...notices(h, model, options),
								composer(h, {
									textareaId: options.textareaId,
									draft: model.draft,
									placeholder: options.placeholder,
									status: model.status,
									onStop: loading ? options.toMessage(Message.ClickedStop()) : undefined,
									isDisabled: false,
									onInput: (text) => options.toMessage(Message.ChangedDraft({ text })),
									onSubmit: options.toMessage(Message.SubmittedComposer()),
									chips: options.chips,
								}),
							],
						),
					]),
		],
	)
}
