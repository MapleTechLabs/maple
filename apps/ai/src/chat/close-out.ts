import { ChatMessage } from "@maple/domain/chat-session"

/** How much of one tool's output the close-out turn is shown. */
const CLOSE_OUT_TOOL_OUTPUT_CHARS = 4_000

/**
 * The transcript as the close-out sees it: the same messages, with each assistant message's tool
 * calls and results rendered into its text. `promptFromHistory` replays prose only, and a pass
 * that gathered evidence through tools and wrote nothing would otherwise close out blind.
 */
export const withToolTranscript = (history: ReadonlyArray<ChatMessage>): ReadonlyArray<ChatMessage> =>
	history.map((message) => {
		if (message.role !== "assistant" || message.toolCalls.length === 0) return message
		const calls = message.toolCalls.map((call) => {
			const output = call.output === undefined ? "(no result)" : renderToolValue(call.output)
			return `[${call.name} ${renderToolValue(call.input)}]\n${output}`
		})
		return new ChatMessage({
			...message,
			text: [message.text, "Evidence gathered so far:", ...calls]
				.filter((part) => part !== "")
				.join("\n\n"),
		})
	})

const renderToolValue = (value: unknown): string => {
	const text = typeof value === "string" ? value : JSON.stringify(value)
	return text.length > CLOSE_OUT_TOOL_OUTPUT_CHARS ? `${text.slice(0, CLOSE_OUT_TOOL_OUTPUT_CHARS)}…` : text
}
