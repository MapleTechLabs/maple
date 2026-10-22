import {
	type ChatEvent,
	type ChatMessage,
	type ChatSubToolCall,
	type ChatTaskRef,
	type ChatToolCall,
	delegatedAgentOf,
} from "@maple/domain/chat-session"
import { Array, Option, Predicate, Schema } from "effect"
import {
	type LeafPart,
	type SubMessage,
	type TaskPart,
	TextPart,
	ToolPart,
	type UIMessage,
	type UIMessagePart,
} from "./ui-message"

// The transcript reducer: durable history to
// `UIMessage`s, and every live `ChatEvent` folded in. Pure; the stream lives in a Subscription.

/** A tool's error output as the text a card renders. */
export const errorTextOf = (output: unknown): string =>
	Predicate.isString(output) ? output : (JSON.stringify(output) ?? String(output))

const PromptFields = Schema.Struct({
	prompt: Schema.optionalKey(Schema.Unknown),
	description: Schema.optionalKey(Schema.Unknown),
})
const AnswerFields = Schema.Struct({
	output: Schema.optionalKey(Schema.Unknown),
	text: Schema.optionalKey(Schema.Unknown),
	budgetExhausted: Schema.optionalKey(Schema.Unknown),
})
const decodePrompt = Schema.decodeUnknownOption(PromptFields)
const decodeAnswer = Schema.decodeUnknownOption(AnswerFields)

const nonBlank = (value: unknown): Option.Option<string> =>
	Predicate.isString(value) && value.trim() !== "" ? Option.some(value) : Option.none()

/** The question a delegation was given (`prompt`, or the older `description`). */
export const taskPromptOf = (input: unknown): string =>
	Option.match(decodePrompt(input), {
		onNone: () => "sub-agent",
		onSome: (fields) =>
			Option.getOrElse(Option.orElse(nonBlank(fields.prompt), () => nonBlank(fields.description)), () => "sub-agent"),
	})

/** The answer a sub-agent returned, out of the delegation tool's result. */
export const taskAnswerOf = (output: unknown): string | undefined => {
	if (Predicate.isString(output)) return output.trim() || undefined
	return Option.getOrUndefined(
		Option.flatMap(decodeAnswer(output), (fields) =>
			nonBlank(Predicate.isString(fields.output) ? fields.output : fields.text),
		),
	)
}

export const taskBudgetExhausted = (output: unknown): boolean =>
	Option.exists(decodeAnswer(output), (fields) => fields.budgetExhausted === true)

const leafToolPart = (call: ChatSubToolCall | ChatToolCall): LeafPart => {
	if (call.stopped === true)
		return ToolPart.make({ toolCallId: call.id, toolName: call.name, state: "output-stopped", input: call.input })
	if (call.output === undefined)
		return ToolPart.make({
			toolCallId: call.id,
			toolName: call.name,
			state: "proposed" in call && call.proposed === true ? "proposed" : "input-available",
			input: call.input,
		})
	if (call.isError === true)
		return ToolPart.make({
			toolCallId: call.id,
			toolName: call.name,
			state: "output-error",
			input: call.input,
			errorText: errorTextOf(call.output),
		})
	return ToolPart.make({
		toolCallId: call.id,
		toolName: call.name,
		state: "output-available",
		input: call.input,
		output: call.output,
	})
}

const taskStatusOf = (call: ChatToolCall): TaskPart["status"] =>
	call.task?.status ??
	(call.isError === true ? "error" : call.stopped === true ? "aborted" : call.output === undefined ? "running" : "completed")

/** `answer` on a settled run, `errorText` on a failed one; neither key otherwise. */
const withAnswer = (call: ChatToolCall): Pick<TaskPart, "answer" | "errorText"> => {
	if (call.isError === true) return { errorText: errorTextOf(call.output) }
	const answer = taskAnswerOf(call.output)
	return answer === undefined ? {} : { answer }
}

const toolCallToPart = (call: ChatToolCall): UIMessagePart => {
	const agent = call.task?.agent ?? delegatedAgentOf(call.name)
	if (agent === undefined) return leafToolPart(call)
	return {
		_tag: "task",
		toolCallId: call.id,
		agent,
		prompt: taskPromptOf(call.input),
		status: taskStatusOf(call),
		...withAnswer(call),
		budgetExhausted: taskBudgetExhausted(call.output),
		messages: (call.task?.messages ?? []).map(
			(message): SubMessage => ({
				id: message.id,
				role: message.role,
				parts: interleave(message.text, message.toolCalls, leafToolPart),
			}),
		),
	}
}

/**
 * Prose and tool calls back in the order they happened: the text is split at each call's
 * `textOffset`, clamped and forced non-decreasing; a call without one lands after the prose.
 */
/** The fold's state: the parts so far and how much of the text they cover. */
interface Interleaved<Part> {
	readonly parts: Array<Part | ReturnType<typeof TextPart.make>>
	readonly cursor: number
}

const interleave = <Call extends { readonly textOffset?: number }, Part>(
	text: string,
	calls: ReadonlyArray<Call>,
	toPart: (call: Call) => Part,
): Array<Part | ReturnType<typeof TextPart.make>> => {
	const seed: Interleaved<Part> = { parts: [], cursor: 0 }
	const { parts, cursor } = Array.reduce(
		calls,
		seed,
		(acc, call) => {
			const offset = Math.min(Math.max(call.textOffset ?? text.length, acc.cursor), text.length)
			const chunk = text.slice(acc.cursor, offset)
			const prose = chunk === "" ? [] : [TextPart.make({ text: chunk, state: "done" })]
			return { parts: [...acc.parts, ...prose, toPart(call)], cursor: offset }
		},
	)
	const tail = text.slice(cursor)
	return tail === "" ? parts : [...parts, TextPart.make({ text: tail, state: "done" })]
}

export const interleaveParts = (text: string, calls: ReadonlyArray<ChatToolCall>): ReadonlyArray<UIMessagePart> =>
	interleave(text, calls, toolCallToPart)

/** A materialized history message, re-interleaved. */
export const historyMessageToUIMessage = (message: ChatMessage): UIMessage => ({
	id: message.id,
	role: message.role,
	parts: interleaveParts(message.text, message.toolCalls),
	createdAt: message.createdAt,
})

// LIVE EVENTS

type Messages = ReadonlyArray<UIMessage>

const ensureAssistant = (messages: Messages, id: string, nowMs: number): Messages =>
	messages.some((message) => message.id === id)
		? messages
		: [...messages, { id, role: "assistant", parts: [], createdAt: nowMs }]

const updateMessage = (messages: Messages, id: string, change: (message: UIMessage) => UIMessage): Messages =>
	messages.map((message) => (message.id === id ? change(message) : message))

const lastPart = (message: UIMessage): UIMessagePart | undefined => message.parts[message.parts.length - 1]

/** A trailing `streaming` text part absorbs the delta; anything else starts a new one. */
const appendTextDelta = (message: UIMessage, delta: string): UIMessage => {
	const last = lastPart(message)
	return last !== undefined && last._tag === "text" && last.state === "streaming"
		? { ...message, parts: [...message.parts.slice(0, -1), { ...last, text: last.text + delta }] }
		: { ...message, parts: [...message.parts, TextPart.make({ text: delta, state: "streaming" })] }
}

/** Closes a trailing `streaming` text part so the thinking row does not linger. */
export const finalizeStreamingText = (message: UIMessage): UIMessage => {
	const last = lastPart(message)
	return last === undefined || last._tag !== "text" || last.state !== "streaming"
		? message
		: { ...message, parts: [...message.parts.slice(0, -1), { ...last, state: "done" }] }
}

/** A call still unsettled when its turn ends never settles: stopped, and a running sub-agent aborted. */
const stopLeaf = (part: LeafPart): LeafPart =>
	part._tag === "dynamic-tool" && part.state === "input-available" ? { ...part, state: "output-stopped" } : part

const stopUnfinished = (message: UIMessage): UIMessage => ({
	...message,
	parts: message.parts.map((part): UIMessagePart =>
		part._tag !== "task"
			? stopLeaf(part)
			: part.status !== "running"
				? part
				: {
						...part,
						status: "aborted",
						messages: part.messages.map((child) => ({ ...child, parts: child.parts.map(stopLeaf) })),
					},
	),
})

/** Retracts text a failed, retried attempt produced; an emptied part is dropped. */
const retractText = (message: UIMessage, chars: number): UIMessage => {
	const last = lastPart(message)
	if (last === undefined || last._tag !== "text") return message
	const text = last.text.slice(0, Math.max(0, last.text.length - chars))
	return { ...message, parts: [...message.parts.slice(0, -1), ...(text === "" ? [] : [{ ...last, text }])] }
}

type ToolCallEvent = Extract<ChatEvent, { type: "tool-call" }>
type ToolResultEvent = Extract<ChatEvent, { type: "tool-result" }>

const addToolCall = (message: UIMessage, event: ToolCallEvent): UIMessage => {
	const finalized = finalizeStreamingText(message)
	const agent = delegatedAgentOf(event.name)
	const part: UIMessagePart =
		agent === undefined
			? ToolPart.make({
					toolCallId: event.callId,
					toolName: event.name,
					state: event.proposed === true ? "proposed" : "input-available",
					input: event.input,
				})
			: {
					_tag: "task",
					toolCallId: event.callId,
					agent,
					prompt: taskPromptOf(event.input),
					status: "running",
					messages: [],
				}
	return { ...finalized, parts: [...finalized.parts, part] }
}

const settleToolCall = (message: UIMessage, event: ToolResultEvent): UIMessage => ({
	...message,
	parts: message.parts.map((part): UIMessagePart => {
		if (part._tag !== "dynamic-tool" || part.toolCallId !== event.callId) return part
		return event.isError === true
			? ToolPart.make({
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					state: "output-error",
					input: part.input,
					errorText: errorTextOf(event.output),
				})
			: ToolPart.make({
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					state: "output-available",
					input: part.input,
					output: event.output,
				})
	}),
})

/** The delegation's result is the sub-agent's written answer: the card renders it. */
const settleTaskResult = (messages: Messages, event: ToolResultEvent): Messages =>
	updateMessage(messages, event.messageId, (message) => ({
		...message,
		parts: message.parts.map((part): UIMessagePart => {
			if (part._tag !== "task" || part.toolCallId !== event.callId) return part
			if (event.isError === true) return { ...part, status: "error", errorText: errorTextOf(event.output) }
			const answer = taskAnswerOf(event.output)
			const settled: TaskPart = { ...part, budgetExhausted: taskBudgetExhausted(event.output) }
			return answer === undefined ? settled : { ...settled, answer }
		}),
	}))

const isLeafPart = (part: UIMessagePart): part is LeafPart => part._tag !== "task"

const taskStatusAfter = (event: ChatEvent, status: TaskPart["status"]): TaskPart["status"] =>
	event.type !== "turn-end"
		? status
		: event.reason === "stop"
			? "completed"
			: event.reason === "error"
				? "error"
				: "aborted"

type SubAgentEvent = Exclude<ChatEvent, { readonly type: "user-message" }>

/** A sub-agent's event as its own transcript sees it. */
const ownEvent = (event: SubAgentEvent): ChatEvent => {
	const { task: _task, ...own } = event
	return own
}

/** A sub-agent's event folds into its `task` part through the same reducer; a missing parent drops it. */
const applyTaskEvent = (messages: Messages, event: SubAgentEvent, task: ChatTaskRef, nowMs: number): Messages =>
	updateMessage(messages, task.parentMessageId, (message) => ({
		...message,
		parts: message.parts.map((part): UIMessagePart => {
			if (part._tag !== "task" || part.toolCallId !== task.id) return part
			// Untagged: still tagged, the inner fold routed it back to the parent and dropped it, so a
			// card stayed empty until a reload.
			const nested = applyChatEvent(part.messages, ownEvent(event), nowMs)
			return {
				...part,
				status: taskStatusAfter(event, part.status),
				messages: nested.map((child) => ({ ...child, parts: child.parts.filter(isLeafPart) })),
			}
		}),
	}))

/** The sub-agent task an event belongs to; `user-message` never carries one. */
export const taskOf = (event: ChatEvent): ChatTaskRef | undefined =>
	event.type === "user-message" ? undefined : event.task

/** Folds one live event. `user-message` is a no-op: the optimistic send already rendered it. */
export const applyChatEvent = (messages: Messages, event: ChatEvent, nowMs: number): Messages => {
	if (event.type === "user-message") return messages
	const task = event.task
	if (task !== undefined) return applyTaskEvent(messages, event, task, nowMs)
	switch (event.type) {
		case "turn-start":
			return ensureAssistant(messages, event.messageId, nowMs)
		case "text-delta":
			return updateMessage(ensureAssistant(messages, event.messageId, nowMs), event.messageId, (message) =>
				appendTextDelta(message, event.text),
			)
		case "tool-call":
			return updateMessage(ensureAssistant(messages, event.messageId, nowMs), event.messageId, (message) =>
				addToolCall(message, event),
			)
		case "tool-result":
			return updateMessage(settleTaskResult(messages, event), event.messageId, (message) =>
				settleToolCall(message, event),
			)
		case "turn-retry":
			return updateMessage(messages, event.messageId, (message) => retractText(message, event.retractChars))
		case "turn-end":
			return updateMessage(messages, event.messageId, (message) => finalizeStreamingText(stopUnfinished(message)))
	}
}
