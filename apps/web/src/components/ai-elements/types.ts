/**
 * Local message/part types for the chat UI, materialized from Maple's own durable
 * chat transport (`@maple/domain/chat-session`) by `useMapleChat`. A message is a
 * role plus an ordered list of parts; a part is either prose or one tool call's
 * full lifecycle (`input-available` → `output-available`/`output-error`).
 *
 * This used to be Flue's `FlueConversationMessage`/`FlueConversationPart` (hence
 * `UIMessage`/`UIMessagePart` — the alias outlived the type it was aliasing). Kept
 * as the name here because every component in this directory already calls it
 * that, and `ChatStatus`/`FileUIPart`/`SourceDocumentUIPart` are declared locally
 * so the UI doesn't pull in the (removed) Vercel AI SDK.
 */
export type UIMessagePart =
	| { type: "text"; text: string; state: "streaming" | "done" }
	| {
			type: "dynamic-tool"
			toolCallId: string
			toolName: string
			state: "input-available"
			input: unknown
	  }
	/**
	 * An approval-gated mutation the agent proposed and did NOT run. The turn stops here;
	 * `POST /internal/chat/apply` is what actually mutates, on the user's click.
	 *
	 * A distinct state rather than a marker parsed back out of `output`: the server emits a
	 * `tool-call` with `proposed: true` and *no* result, so there is no output to parse. While the
	 * client still looked for the old `{status:"proposed"}` marker in an output that never arrived,
	 * every gated tool rendered as a tool call stuck at `input-available` — a permanent spinner
	 * where the approval card should be.
	 */
	| {
			type: "dynamic-tool"
			toolCallId: string
			toolName: string
			state: "proposed"
			input: unknown
	  }
	| {
			type: "dynamic-tool"
			toolCallId: string
			toolName: string
			state: "output-available"
			input: unknown
			output: unknown
	  }
	| {
			type: "dynamic-tool"
			toolCallId: string
			toolName: string
			state: "output-error"
			input: unknown
			errorText: string
	  }
	/**
	 * A sub-agent run: the question it was given, the answer it came back with, and whatever of its
	 * own transcript reached the parent.
	 *
	 * A part of its own rather than a `dynamic-tool` with a payload, because it renders as a card
	 * rather than a tool row, and because `transcript-rows` must not fold it into a tool group — a
	 * sub-agent is content, not plumbing.
	 *
	 * `messages` is usually empty and that is not a bug: the engine relays a delegation's lifecycle,
	 * not a live replay of it searching, so the run's substance is `prompt` and `answer`. It is
	 * `UIMessage[]` and not recursive by accident — sub-agents cannot spawn sub-agents, so a nested
	 * message never carries another `task` part.
	 */
	| {
			type: "task"
			toolCallId: string
			agent: string
			/** The self-contained question the parent model wrote for it. */
			prompt: string
			status: "running" | "completed" | "error" | "aborted"
			/** The written answer, once the delegation settled. */
			answer?: string
			/** Why the run failed, when it did. */
			errorText?: string
			/** The sub-agent answered from what it had rather than from a finished search. */
			budgetExhausted?: boolean
			messages: UIMessage[]
	  }

export interface UIMessage {
	id: string
	role: "user" | "assistant"
	parts: UIMessagePart[]
	/** Epoch ms the message opened. Absent on transcripts that carry no clock — a
	 *  sub-agent's nested messages, and fixtures. */
	createdAt?: number
}

/** Composer status. Flue's `idle`/`connecting` map to `ready` for the submit button. */
export type ChatStatus = "submitted" | "streaming" | "ready" | "error"

export interface FileUIPart {
	type: "file"
	mediaType: string
	filename?: string
	url: string
}

export interface SourceDocumentUIPart {
	type: "source-document"
	sourceId: string
	mediaType: string
	title: string
	filename?: string
	providerMetadata?: Record<string, unknown>
}
