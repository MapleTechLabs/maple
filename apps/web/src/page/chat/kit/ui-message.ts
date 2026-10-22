import { Schema } from "effect"

// `UIMessage` / `UIMessagePart` as Schemas, so a
// transcript can live in a Model. A sub-agent's nested messages never carry another `task` part.

export const TextPart = Schema.TaggedStruct("text", {
	text: Schema.String,
	state: Schema.Literals(["streaming", "done"]),
})

export const ToolState = Schema.Literals(["input-available", "proposed", "output-available", "output-error"])
export type ToolState = typeof ToolState.Type

/** One tool call's lifecycle; `output` once it settled, `errorText` when it failed. */
export const ToolPart = Schema.TaggedStruct("dynamic-tool", {
	toolCallId: Schema.String,
	toolName: Schema.String,
	state: ToolState,
	input: Schema.Unknown,
	output: Schema.optionalKey(Schema.Unknown),
	errorText: Schema.optionalKey(Schema.String),
})
export type ToolPart = typeof ToolPart.Type

export const LeafPart = Schema.Union([TextPart, ToolPart])
export type LeafPart = typeof LeafPart.Type

export const SubMessage = Schema.Struct({
	id: Schema.String,
	role: Schema.Literals(["user", "assistant"]),
	parts: Schema.Array(LeafPart),
	createdAt: Schema.optionalKey(Schema.Number),
})
export type SubMessage = typeof SubMessage.Type

export const TaskStatus = Schema.Literals(["running", "completed", "error", "aborted"])
export type TaskStatus = typeof TaskStatus.Type

/** A sub-agent run: its question, its answer, and whatever of its transcript reached the parent. */
export const TaskPart = Schema.TaggedStruct("task", {
	toolCallId: Schema.String,
	agent: Schema.String,
	prompt: Schema.String,
	status: TaskStatus,
	answer: Schema.optionalKey(Schema.String),
	errorText: Schema.optionalKey(Schema.String),
	budgetExhausted: Schema.optionalKey(Schema.Boolean),
	messages: Schema.Array(SubMessage),
})
export type TaskPart = typeof TaskPart.Type

export const UIMessagePart = Schema.Union([TextPart, ToolPart, TaskPart])
export type UIMessagePart = typeof UIMessagePart.Type

export const UIMessage = Schema.Struct({
	id: Schema.String,
	role: Schema.Literals(["user", "assistant"]),
	parts: Schema.Array(UIMessagePart),
	createdAt: Schema.optionalKey(Schema.Number),
})
export type UIMessage = typeof UIMessage.Type

/** Composer status (`ChatStatus`). */
export const ChatStatus = Schema.Literals(["submitted", "streaming", "ready", "error"])
export type ChatStatus = typeof ChatStatus.Type

