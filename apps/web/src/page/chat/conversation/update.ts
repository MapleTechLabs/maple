import { chartFences } from "@maple/domain/chat-chart-spec"
import { wrapChatContext } from "@maple/domain/chat-preamble"
import type { ChatEvent } from "@maple/domain/chat-session"
import { Array, Result } from "effect"
import { Command, type Update } from "foldkit"
import * as Chart from "../../../charts/chart"
import { ChartRuntime, LoadChartRuntime } from "../../../charts/chart-runtime"
import type { Resources } from "../../../platform/resources"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import { taskSheetId } from "../kit/view-task"
import { applyChatEvent, finalizeStreamingText, taskOf } from "../kit/fold"
import { transcriptMarkdown } from "../kit/rich-text"
import { initMinimap, updateMinimap } from "../kit/turn-minimap"
import { TextPart } from "../kit/ui-message"
import { highlightedFences, highlightKey } from "../kit/code-highlight"
import {
	AbortTurn,
	CopyCode,
	DecideApproval,
	DownloadCode,
	HighlightCode,
	LoadHistory,
	ParseMarkdown,
	PostMessage,
	TrackMessageSent,
} from "./command"
import { Message, OutMessage } from "./message"
import { isLoading, type Model, type ReadOnly } from "./model"

export type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

/** What the host knows when a turn is sent: the first-message context block, if any. */
export interface SendContext {
	/** `buildContextPreamble(context)`; empty when there is nothing to attach. */
	readonly preamble: string
}

const withCommands = (result: Return, commands: Commands): Return => ({
	...result,
	commands: [...(result.commands ?? []), ...commands],
})

type MarkdownEntry = Model["markdown"][string]

/** The longest parsed text an on-screen body extends: a streaming body's previous version. */
const parsedPrefix = (cache: Model["markdown"], text: string): MarkdownEntry | undefined =>
	Object.entries(cache)
		.filter(([key, entry]) => !entry.isStale && key !== text && text.startsWith(key))
		.reduce<[string, MarkdownEntry] | undefined>(
			(best, pair) => (best === undefined || pair[0].length > best[0].length ? pair : best),
			undefined,
		)?.[1]

/**
 * The cache keeps only the bodies on screen (a body still parsing shows its previous version's
 * parse), parses each missing one unless an earlier version is in flight, and colours its fences.
 */
const followMarkdown = (result: Return): Return => {
	const model = result.model
	const wanted = Array.dedupe(transcriptMarkdown(model.messages))
	const markdown = Object.fromEntries(
		wanted.flatMap((text) => {
			const own = model.markdown[text]
			if (own !== undefined && !own.isStale) return [[text, own]]
			const prefix = parsedPrefix(model.markdown, text)
			const shown = prefix === undefined ? own : { document: prefix.document, isStale: true }
			return shown === undefined ? [] : [[text, shown]]
		}),
	)
	const missing = wanted.filter(
		(text) =>
			(markdown[text]?.isStale ?? true) &&
			!model.markdownPending.some((pending) => text.startsWith(pending)),
	)
	const fences = Object.values(markdown).flatMap(({ document }) =>
		document === null ? [] : highlightedFences(document.blocks),
	)
	const keys = new Set(fences.map((fence) => highlightKey(fence.language, fence.code)))
	const highlights = Object.fromEntries(Object.entries(model.highlights).filter(([key]) => keys.has(key)))
	const coloured = requestHighlights(
		{ ...model, markdown, highlights, markdownPending: [...model.markdownPending, ...missing] },
		fences,
	)
	return withCommands({ ...result, model: coloured.model }, [
		...(missing.length === 0 ? [] : [ParseMarkdown({ texts: missing })]),
		...(coloured.commands ?? []),
	])
}

/** A ```chart fence anywhere in the thread loads the plotting runtime, once. */
const followCharts = (result: Return): Return => {
	const model = result.model
	if (model.chartRuntime !== null) return result
	const hasChart = transcriptMarkdown(model.messages).some((text) => chartFences(text).length > 0)
	return hasChart
		? withCommands({ ...result, model: { ...model, chartRuntime: ChartRuntime.Loading() } }, [
				LoadChartRuntime(),
			])
		: result
}

export const init = (tabId: string, sessionId: string, readOnly: ReadOnly = null): Return => ({
	model: {
		tabId,
		sessionId,
		readOnly,
		historyReady: false,
		historyError: null,
		messages: [],
		status: "ready",
		error: null,
		failedSend: null,
		stream: null,
		generation: 1,
		lastSeq: 0,
		draft: "",
		openPanels: [],
		copies: {},
		resolvedApprovals: {},
		decidingApprovals: [],
		charts: {},
		chartRuntime: null,
		themeColors: null,
		highlights: {},
		minimap: initMinimap(),
		taskSheets: {},
		markdown: {},
		markdownPending: [],
	},
	commands: [LoadHistory({ sessionId, generation: 1 })],
})

/** `handleSend`: `chat_message_sent`, the optimistic bubble, `submitted` and the POST; nothing while a turn runs. */
const send = (model: Model, raw: string, context: SendContext): Return => {
	const trimmed = raw.trim()
	if (trimmed === "" || !model.historyReady || isLoading(model) || model.readOnly !== null) return { model }
	const isFirst = model.messages.length === 0
	const outgoing = isFirst && context.preamble !== "" ? wrapChatContext(context.preamble, trimmed) : trimmed
	const generation = model.generation + 1
	const localId = `local-${generation}`
	const sent: Return = {
		model: {
			...model,
			messages: [
				...model.messages,
				{ id: localId, role: "user", parts: [TextPart.make({ text: outgoing, state: "done" })] },
			],
			status: "submitted",
			error: null,
			failedSend: null,
			generation,
		},
		commands: [
			TrackMessageSent({ turn: isFirst ? "first" : "followup" }),
			PostMessage({ sessionId: model.sessionId, generation, localId, text: outgoing, raw: trimmed }),
		],
	}
	return isFirst
		? { ...sent, outMessage: OutMessage.SentFirstMessage({ title: trimmed.slice(0, 40) }) }
		: sent
}

/** Folds one event; a top-level `turn-start`/`turn-end` moves the composer status. */
const foldEvent = (model: Model, event: ChatEvent, nowMs: number): Model => {
	if (event.seq <= model.lastSeq) return model
	const next = { ...model, lastSeq: event.seq, messages: applyChatEvent(model.messages, event, nowMs) }
	if (taskOf(event) !== undefined) return next
	if (event.type === "turn-start") return { ...next, status: "streaming" }
	if (event.type !== "turn-end") return next
	return event.reason === "error"
		? { ...next, status: "error", error: event.error ?? "The chat turn failed.", stream: null }
		: { ...next, status: "ready", stream: null }
}

/** Each fence not coloured yet, marked in flight and handed to Shiki. */
const requestHighlights = (
	model: Model,
	fences: ReadonlyArray<{ readonly language: string; readonly code: string }>,
): Return => {
	const missing = fences.filter((fence, index) => {
		const key = highlightKey(fence.language, fence.code)
		return (
			!(key in model.highlights) &&
			fences.findIndex((other) => highlightKey(other.language, other.code) === key) === index
		)
	})
	return {
		model: {
			...model,
			highlights: {
				...model.highlights,
				...Object.fromEntries(
					missing.map((fence) => [highlightKey(fence.language, fence.code), null]),
				),
			},
		},
		commands: missing.map((fence) =>
			HighlightCode({ key: highlightKey(fence.language, fence.code), ...fence }),
		),
	}
}

const toggle = (ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
	ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]

const without = (ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
	ids.filter((other) => other !== id)

const toast = (type: "success" | "error", title: string) => OutMessage.RequestedToast({ type, title })

const step = (model: Model, message: Message, context: SendContext): Return =>
	Message.match<Return>(message, {
		CompletedLoadHistory: ({ generation, result }) => {
			if (generation !== model.generation) return { model }
			return Result.match(result, {
				onSuccess: (history) => {
					const loaded: Model = {
						...model,
						historyReady: true,
						historyError: null,
						messages: history.messages,
					}
					// A turn already running when this device connected: resume its tail.
					return history.running
						? {
								model: {
									...loaded,
									status: "streaming",
									stream: { generation, cursor: history.cursor },
									lastSeq: history.cursor,
								},
							}
						: { model: loaded }
				},
				// Unknown, not empty: sends stay blocked until a retry reads it.
				onFailure: (error) => ({ model: { ...model, historyError: error } }),
			})
		},
		ClickedRetryHistory: () =>
			model.historyReady || model.historyError === null
				? { model }
				: {
						model: { ...model, historyError: null, generation: model.generation + 1 },
						commands: [
							LoadHistory({ sessionId: model.sessionId, generation: model.generation + 1 }),
						],
					},
		CompletedTrackMessageSent: () => ({ model }),
		ChangedDraft: ({ text }) => ({ model: { ...model, draft: text } }),
		// `form.reset()` runs before `onSubmit`, so the composer clears even when nothing is sent.
		// Before the history is read the draft stays: a send then would drop the history.
		SubmittedComposer: () =>
			model.historyReady ? send({ ...model, draft: "" }, model.draft, context) : { model },
		ClickedSuggestion: ({ text }) => send(model, text, context),
		ClickedRetrySend: ({ text }) => send(model, text, context),
		ClickedContinue: () => send(model, "Continue.", context),
		ClickedStop: () =>
			isLoading(model)
				? {
						model: {
							...model,
							stream: null,
							generation: model.generation + 1,
							status: "ready",
							messages: model.messages.map(finalizeStreamingText),
						},
						commands: [AbortTurn({ sessionId: model.sessionId })],
					}
				: { model },
		// A send outlives a Stop (`runStream` after the POST): its bubble still shown, it adopts the
		// cursor under a fresh generation so the server's `turn-end` settles the turn.
		CompletedPostMessage: ({ generation, localId, raw, result }) => {
			if (!model.messages.some((entry) => entry.id === localId)) return { model }
			const tail = generation === model.generation ? generation : model.generation + 1
			return Result.match(result, {
				onSuccess: (sent) => ({
					model: {
						...model,
						messages: model.messages.map((entry) =>
							entry.id === localId ? { ...entry, id: sent.messageId } : entry,
						),
						generation: tail,
						stream: { generation: tail, cursor: sent.cursor },
						lastSeq: sent.cursor,
					},
				}),
				onFailure: (error) => ({
					model: {
						...model,
						status: "ready",
						messages: model.messages.filter((entry) => entry.id !== localId),
						failedSend: { message: raw, error },
					},
				}),
			})
		},
		ReceivedChatEvents: ({ generation, events, nowMs }) =>
			model.stream === null || model.stream.generation !== generation
				? { model }
				: { model: events.reduce((acc, event) => foldEvent(acc, event, nowMs), model) },
		FailedChatStream: ({ generation, message: error }) =>
			model.stream === null || model.stream.generation !== generation
				? { model }
				: { model: { ...model, status: "error", error, stream: null } },
		CompletedAbortTurn: () => ({ model }),
		ToggledPanel: ({ id }) => ({ model: { ...model, openPanels: toggle(model.openPanels, id) } }),
		GotCopyMessage: ({ id, message: child }) => {
			const result = CopyButton.update(model.copies[id] ?? CopyButton.init(), child)
			return {
				model: { ...model, copies: { ...model.copies, [id]: result.model } },
				commands: Command.mapMessages(result.commands ?? [], (inner) =>
					Message.GotCopyMessage({ id, message: inner }),
				),
			}
		},
		CompletedParseMarkdown: ({ parsed }) => ({
			model: {
				...model,
				markdown: {
					...model.markdown,
					...Object.fromEntries(
						parsed.map(({ text, document }) => [text, { document, isStale: false }]),
					),
				},
				markdownPending: model.markdownPending.filter(
					(text) => !parsed.some((entry) => entry.text === text),
				),
			},
		}),
		ClickedCopyCode: ({ code }) => ({ model, commands: [CopyCode({ code })] }),
		ClickedDownloadCode: ({ code, language }) => ({
			model,
			commands: [DownloadCode({ code, language })],
		}),
		CompletedCodeAction: () => ({ model }),
		CompletedMountJump: () => ({ model }),
		CompletedMountClock: () => ({ model }),
		GotTaskSheetMessage: ({ toolCallId, message: child }) => {
			const sheet = Dialog.update(
				model.taskSheets[toolCallId] ?? Dialog.init(taskSheetId(toolCallId), "sheet"),
				child,
			)
			return {
				model: { ...model, taskSheets: { ...model.taskSheets, [toolCallId]: sheet.model } },
				commands: Command.mapMessages(sheet.commands ?? [], (inner) =>
					Message.GotTaskSheetMessage({ toolCallId, message: inner }),
				),
			}
		},
		CompletedHighlightCode: ({ key, highlighted }) => ({
			model: { ...model, highlights: { ...model.highlights, [key]: highlighted } },
		}),
		GotChartMessage: ({ id, message: child }) => {
			const chart = Chart.update(model.charts[id] ?? Chart.init(), child)
			return {
				model: { ...model, charts: { ...model.charts, [id]: chart.model } },
				commands: Command.mapMessages(chart.commands ?? [], (inner) =>
					Message.GotChartMessage({ id, message: inner }),
				),
			}
		},
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: ChartRuntime.Ready() } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: ChartRuntime.Failed({ reason }) },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotMinimapMessage: ({ message: child }) => ({
			model: { ...model, minimap: updateMinimap(model.minimap, child) },
		}),
		ClickedApprove: ({ toolCallId, tool }) => decide(model, toolCallId, tool, "approve"),
		ClickedDeny: ({ toolCallId }) => decide(model, toolCallId, "", "deny"),
		CompletedDecideApproval: ({ toolCallId, tool, decision, result }) => {
			const settled = { ...model, decidingApprovals: without(model.decidingApprovals, toolCallId) }
			const resolve = (outcome: "applied" | "denied") => ({
				...settled,
				resolvedApprovals: { ...settled.resolvedApprovals, [toolCallId]: outcome },
			})
			return Result.match(result, {
				onSuccess: (outcome): Return =>
					decision === "deny"
						? { model: resolve("denied") }
						: outcome.isError
							? {
									model: settled,
									outMessage: toast("error", outcome.content || `Couldn't apply ${tool}`),
								}
							: { model: resolve("applied"), outMessage: toast("success", "Change applied") },
				onFailure: (): Return => ({
					model: settled,
					outMessage: toast(
						"error",
						decision === "deny" ? "Failed to deny this change" : `Failed to apply ${tool}`,
					),
				}),
			})
		},
	})

const decide = (model: Model, toolCallId: string, tool: string, decision: "approve" | "deny"): Return =>
	model.decidingApprovals.includes(toolCallId)
		? { model }
		: {
				model: { ...model, decidingApprovals: [...model.decidingApprovals, toolCallId] },
				commands: [DecideApproval({ sessionId: model.sessionId, toolCallId, tool, decision })],
			}

export const update = (model: Model, message: Message, context: SendContext): Return =>
	followCharts(followMarkdown(step(model, message, context)))

/** A transcript known up front (the lab, a fixture): its parses and chart runtime requested. */
export const withMessages = (result: Return, messages: Model["messages"]): Return =>
	followCharts(followMarkdown({ ...result, model: { ...result.model, messages, historyReady: true } }))
