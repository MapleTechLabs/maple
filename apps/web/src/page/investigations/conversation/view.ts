import type { AiTriageResult } from "@maple/domain/http"
import { parseDiagnosisMarker } from "./kit/diagnosis-marker"
import { cn } from "@maple/ui/lib/utils"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AREA_CHART_TOKENS } from "../../../charts/area-chart"
import { BAR_CHART_TOKENS } from "../../../charts/bar-chart"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { button } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import type { LoadFailure } from "../../../data/load-failure"
import { eyebrow } from "../../../ui/eyebrow"
import { skeleton } from "../../../ui/skeleton"
import { approvalCard } from "./kit/view-cards"
import { taskCard, taskSheetId } from "./kit/view-task"
import * as Dialog from "../../../ui/dialog"
import { composer, failureNotice } from "./kit/view-composer"
import { MountTurnMinimap } from "./kit/turn-minimap-mount"
import { MountJumpToMessage } from "./kit/scroller"
import { MountRunningClock } from "./kit/view-tool"
import { findDiagnosisMessageId } from "./kit/transcript-rows"
import { inlineCard } from "./kit/view-inline"
import { chatMarkdownOverrides } from "./kit/view-markdown"
import { type TranscriptHost, transcript } from "./kit/view-transcript"
import { Message } from "./message"
import { isLoading, type Model } from "./model"

// One conversation: transcript, notices, composer.

/** The area and bar plots' colours, read once for every chart fence. */
const CHART_TOKENS = [...new Set([...AREA_CHART_TOKENS, ...BAR_CHART_TOKENS])]

export type ConversationViewOptions<M> = Readonly<{
	toMessage: (message: Message) => M
	timeZone: string
	/** Base UI's `useId` on the composer's textarea. */
	textareaId: string
	placeholder: string
	/** The host's empty state for a fresh conversation. */
	emptyState: () => Html
	scrollerMount: TranscriptHost<M>["scrollerMount"]
	/** The org's service names (`KnownServicesProvider`): table cells that name one link to it. */
	knownServices: ReadonlySet<string>
	/** The clock a chart's in-flight bucket is judged against. */
	nowMs: number
	/** An investigation thread's report card, drawn ahead of its turns (`fallbackDiagnosis`). */
	fallback?: Html
	/** The subject's starter prompts above the composer of an empty thread. */
	suggestions?: Readonly<{ items: ReadonlyArray<string>; onSelect: (text: string) => M }>
	/** `DiagnosisReportCard` for a `submit_diagnosis` turn; without it the turn draws nothing. */
	diagnosisCard?: (report: AiTriageResult) => Html
}>

/** Approvals, sub-agent rows, inline cards and the chat's tables and charts. */
const cardsOf = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	options: ConversationViewOptions<M>,
): Pick<TranscriptHost<M>, "inlineCard" | "ownCard" | "taskCard" | "markdownOverrides"> => ({
	inlineCard: (segment) => inlineCard(h, segment, options.timeZone),
	taskCard: (part, draw) =>
		taskCard(
			h,
			{
				dialog: (toolCallId) =>
					model.taskSheets[toolCallId] ?? Dialog.init(taskSheetId(toolCallId), "sheet"),
				onDialog: (toolCallId, message) =>
					options.toMessage(Message.GotTaskSheetMessage({ toolCallId, message })),
				richText: draw.richText,
				tool: draw.tool,
				clockMount: Mount.mapMessage(MountRunningClock(), () =>
					options.toMessage(Message.CompletedMountClock()),
				),
			},
			part,
		),
	ownCard: (part) => {
		const diagnosis = part.state === "output-available" ? parseDiagnosisMarker(part.output) : null
		if (diagnosis !== null) return options.diagnosisCard?.(diagnosis.report) ?? null
		return part.state !== "proposed"
			? null
			: approvalCard(h, {
					toolName: part.toolName,
					input: part.input,
					timeZone: options.timeZone,
					resolved: model.resolvedApprovals[part.toolCallId],
					isRawOpen: model.openPanels.includes(`raw:${part.toolCallId}`),
					isDeciding: model.decidingApprovals.includes(part.toolCallId),
					onToggleRaw: options.toMessage(Message.ToggledPanel({ id: `raw:${part.toolCallId}` })),
					onApprove: options.toMessage(
						Message.ClickedApprove({ toolCallId: part.toolCallId, tool: part.toolName }),
					),
					onDeny: options.toMessage(Message.ClickedDeny({ toolCallId: part.toolCallId })),
				})
	},
	markdownOverrides: chatMarkdownOverrides(
		h,
		options.knownServices,
		{
			charts: model.charts,
			theme: model.themeColors,
			isRuntimeReady: model.chartRuntime !== null && isChartRuntimeReady(model.chartRuntime),
			nowMs: options.nowMs,
			timeZone: options.timeZone,
			onChart: (id, message) => options.toMessage(Message.GotChartMessage({ id, message })),
		},
		{
			highlights: model.highlights,
			onCopy: (code) => options.toMessage(Message.ClickedCopyCode({ code })),
			onDownload: (code, language) =>
				options.toMessage(Message.ClickedDownloadCode({ code, language })),
		},
	),
})

/** Reads the chart colours off the page, again on every light/dark flip. */
const themeMount = <M>(toMessage: (message: Message) => M) =>
	Mount.mapMessage(ResolveThemeColors({ tokens: CHART_TOKENS }), (message) =>
		toMessage(Message.ResolvedThemeColors({ colors: message.colors })),
	)

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
			eyebrow(
				h,
				{
					as: "p",
					variant: "label",
					className: "flex items-center gap-1.5 text-muted-foreground/70",
				},
				[h.span([], [title])],
			),
			h.p([h.Class("max-w-sm text-sm text-muted-foreground")], [body]),
		],
	)

/** The history read failed: the thread is unknown, so it offers a retry instead of the empty state. */
const HISTORY_FAILURE: LoadFailure = {
	_tag: "@maple/web/chat/HistoryLoadFailed",
	type: "api_error",
	code: "chat_history_unavailable",
	title: "Couldn't load this conversation",
	message: "The conversation is saved. Try again to load it.",
	retryable: false,
	recovery: "retry",
}

const historyFailure = <M>(h: HtmlBuilder<M>, options: ConversationViewOptions<M>): Html =>
	errorState(h, {
		failure: HISTORY_FAILURE,
		onRetry: options.toMessage(Message.ClickedRetryHistory()),
		// Anchored where the first message would sit (the 3xl column less its padding), not centred.
		className: "h-auto w-full max-w-[46rem] self-start",
	})

const emptyStateOf = <M>(h: HtmlBuilder<M>, model: Model, options: ConversationViewOptions<M>): Html => {
	if (model.historyError !== null) return historyFailure(h, options)
	if (!model.historyReady) return loadingSkeleton(h)
	switch (model.readOnly) {
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
				"The agents' reasoning log appears here as the pass runs: every tool call and what it returned.",
			)
		case null:
			return options.emptyState()
	}
}

const transcriptHostOf = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	options: ConversationViewOptions<M>,
): TranscriptHost<M> => ({
	isOpen: (id) => model.openPanels.includes(id),
	onToggle: (id) => options.toMessage(Message.ToggledPanel({ id })),
	clockMount: Mount.mapMessage(MountRunningClock(), () => options.toMessage(Message.CompletedMountClock())),
	markdown: model.markdown,
	timeZone: options.timeZone,
	isLoading: isLoading(model),
	readOnly: model.readOnly,
	copies: model.copies,
	onCopy: (id, message) => options.toMessage(Message.GotCopyMessage({ id, message })),
	scrollerMount: options.scrollerMount,
	minimap: model.minimap,
	minimapMount: Mount.mapMessage(MountTurnMinimap(), (message) =>
		options.toMessage(Message.GotMinimapMessage({ message })),
	),
	fallback: options.fallback,
	...jumpOf(model, options),
	...cardsOf(h, model, options),
})

/** `diagnosisMessageId`: a thread with a `submit_diagnosis` turn offers the way back to it. */
const jumpOf = <M>(model: Model, options: ConversationViewOptions<M>): Pick<TranscriptHost<M>, "jump"> => {
	const messageId = findDiagnosisMessageId(model.messages)
	return messageId === undefined
		? {}
		: {
				jump: {
					messageId,
					mount: Mount.mapMessage(MountJumpToMessage({ messageId }), () =>
						options.toMessage(Message.CompletedMountJump()),
					),
				},
			}
}

const notices = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	options: ConversationViewOptions<M>,
): ReadonlyArray<Html> => {
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

/** The suggestions as one-line outline pills. */
const suggestionPills = <M>(
	h: HtmlBuilder<M>,
	suggestions: Readonly<{ items: ReadonlyArray<string>; onSelect: (text: string) => M }>,
): Html =>
	h.div(
		[h.Class(cn("flex flex-wrap items-center gap-2", "mb-3"))],
		suggestions.items.map((suggestion) =>
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					className: "max-w-[min(100%,24rem)] cursor-pointer rounded-full px-3.5",
					attributes: [h.Title(suggestion), h.OnClick(suggestions.onSelect(suggestion))],
				},
				[h.span([h.Class("min-w-0 truncate")], [suggestion])],
			),
		),
	)

export const conversationView = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	options: ConversationViewOptions<M>,
): Html => {
	const loading = isLoading(model)
	return h.div(
		[h.Class("flex h-full min-h-0 flex-col")],
		[
			// Chart colours are read once a chart fence appears, from an empty `display: contents`
			// probe that inherits the page's tokens; it is its own element so its Mount runs on insert.
			...(model.chartRuntime === null
				? []
				: [
						h.keyed("span")(
							"chat-theme-probe",
							[h.Class("contents"), h.OnMount(themeMount(options.toMessage))],
							[],
						),
					]),
			transcript(h, transcriptHostOf(h, model, options), model.messages, () =>
				emptyStateOf(h, model, options),
			),
			...(model.readOnly !== null
				? []
				: [
						h.div(
							[
								h.Class(
									"mx-auto w-full max-w-3xl shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
								),
							],
							[
								...(model.historyReady &&
								model.messages.length === 0 &&
								options.suggestions !== undefined
									? [suggestionPills(h, options.suggestions)]
									: []),
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
								}),
							],
						),
					]),
		],
	)
}
