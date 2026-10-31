import { stripChatContext } from "@maple/domain/chat-preamble"
import { parseDiagnosisMarker } from "./diagnosis-marker"
import { Array } from "effect"
import type { ToolPart, UIMessage, UIMessagePart } from "./ui-message"

// Messages to rows, merging runs of tool-only turns.

export type ToolStatus = "running" | "completed" | "error" | "stopped"

export const deriveToolStatus = (state: string): ToolStatus =>
	state === "output-available"
		? "completed"
		: state === "output-error"
			? "error"
			: state === "output-stopped"
				? "stopped"
				: "running"

export const isToolPart = (part: UIMessagePart): part is ToolPart => part._tag === "dynamic-tool"

/** A diagnosis report or an approval prompt: content with its own card, never in a tool group. */
export const rendersOwnCard = (part: ToolPart): boolean =>
	part.state === "proposed" ||
	(part.state === "output-available" && parseDiagnosisMarker(part.output) !== null)

export const isToolOnlyMessage = (message: UIMessage): boolean =>
	message.role === "assistant" &&
	message.parts.length > 0 &&
	message.parts.every((part) => isToolPart(part) && !rendersOwnCard(part))

export type TranscriptRow =
	| { readonly kind: "message"; readonly id: string; readonly message: UIMessage }
	/** Two or more adjacent tool-only turns, drawn as one tool group. */
	| { readonly kind: "tool-run"; readonly id: string; readonly messages: ReadonlyArray<UIMessage> }

/** Each maximal run of two or more adjacent tool-only assistant turns becomes one row. */
export const buildTranscriptRows = (messages: ReadonlyArray<UIMessage>): ReadonlyArray<TranscriptRow> => {
	const seed: ReadonlyArray<ReadonlyArray<UIMessage>> = []
	const runs = Array.reduce(messages, seed, (acc, message) => {
		const last = acc[acc.length - 1]
		const lastMessage = last?.[last.length - 1]
		return last !== undefined &&
			lastMessage !== undefined &&
			isToolOnlyMessage(lastMessage) &&
			isToolOnlyMessage(message)
			? [...acc.slice(0, -1), [...last, message]]
			: [...acc, [message]]
	})
	return runs.flatMap((run): ReadonlyArray<TranscriptRow> => {
		const first = run[0]
		if (first === undefined) return []
		return run.length === 1
			? [{ kind: "message", id: first.id, message: first }]
			: [{ kind: "tool-run", id: first.id, messages: run }]
	})
}

/** Every tool part in a merged run, in order. */
export const toolPartsOf = (messages: ReadonlyArray<UIMessage>): ReadonlyArray<ToolPart> =>
	messages.flatMap((message) => message.parts.filter(isToolPart))

/** A user turn that is nothing but a context preamble: the server seeded the conversation. */
export const isMachineTurn = (message: UIMessage): boolean =>
	message.role === "user" &&
	message.parts.length > 0 &&
	message.parts.every((part) => part._tag === "text" && stripChatContext(part.text).length === 0)

/** The visible text of a message, tool calls left out (`messageText`). */
export const messageText = (message: UIMessage): string =>
	message.parts
		.flatMap((part) => (part._tag === "text" ? [part.text] : []))
		.join("\n\n")
		.trim()

/** The id of the message carrying a diagnosis report, if the thread produced one. */
export const findDiagnosisMessageId = (messages: ReadonlyArray<UIMessage>): string | undefined =>
	messages.find((message) =>
		message.parts.some(
			(part) =>
				isToolPart(part) &&
				part.state === "output-available" &&
				parseDiagnosisMarker(part.output) !== null,
		),
	)?.id

/**
 * Whether the turn needs its own "Thinking" row: only when nothing else in it is live (before the
 * first token, and between a settled tool burst and the prose after it).
 */
export const showsThinkingRow = (message: UIMessage, isLoading: boolean, isLastMessage: boolean): boolean => {
	if (!isLoading || !isLastMessage || message.role !== "assistant") return false
	const last = message.parts[message.parts.length - 1]
	if (last === undefined) return true
	if (last._tag === "text" && last.state === "streaming") return false
	return !message.parts.some(
		(part) =>
			(part._tag === "task" && part.status === "running") ||
			(isToolPart(part) && part.state !== "proposed" && deriveToolStatus(part.state) === "running"),
	)
}
