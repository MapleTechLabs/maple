import { ChatMessage } from "@maple/domain/chat-session"

/** How much of one tool's output the close-out turn is shown. */
const CLOSE_OUT_TOOL_OUTPUT_CHARS = 20_000

/**
 * All the evidence the close-out is shown, about 60k tokens. The newest message is replayed whole
 * and compaction cannot split it, so an unbounded transcript fails the close-out before its first call.
 */
export const CLOSE_OUT_EVIDENCE_CHARS = 200_000

/**
 * The transcript as the close-out sees it: the same messages, with each assistant message's tool
 * calls and results rendered into its text. `promptFromHistory` replays prose only, and a pass
 * that gathered evidence through tools and wrote nothing would otherwise close out blind.
 *
 * Past the budget the oldest calls are dropped and counted, newest kept: they are where the pass
 * was when it stopped.
 */
export const withToolTranscript = (history: ReadonlyArray<ChatMessage>): ReadonlyArray<ChatMessage> => {
	let budget = CLOSE_OUT_EVIDENCE_CHARS
	let full = false
	const rendered = new Map<number, { readonly calls: ReadonlyArray<string>; readonly omitted: number }>()
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index]!
		if (message.role !== "assistant" || message.toolCalls.length === 0) continue
		const kept: Array<string> = []
		for (let call = message.toolCalls.length - 1; call >= 0; call--) {
			const { name, input, output } = message.toolCalls[call]!
			const text = `[${name} ${renderToolValue(input)}]\n${output === undefined ? "(no result)" : renderToolValue(output)}`
			if (full || text.length > budget) {
				full = true
				break
			}
			budget -= text.length
			kept.unshift(text)
		}
		rendered.set(index, { calls: kept, omitted: message.toolCalls.length - kept.length })
	}
	return history.map((message, index) => {
		const evidence = rendered.get(index)
		if (evidence === undefined) return message
		return new ChatMessage({
			...message,
			text: [
				message.text,
				"Evidence gathered so far:",
				...(evidence.omitted > 0
					? [`(${evidence.omitted} earlier tool calls left out for length.)`]
					: []),
				...evidence.calls,
			]
				.filter((part) => part !== "")
				.join("\n\n"),
		})
	})
}

const renderToolValue = (value: unknown): string => {
	const text = typeof value === "string" ? value : JSON.stringify(value)
	return text.length > CLOSE_OUT_TOOL_OUTPUT_CHARS ? `${text.slice(0, CLOSE_OUT_TOOL_OUTPUT_CHARS)}…` : text
}
