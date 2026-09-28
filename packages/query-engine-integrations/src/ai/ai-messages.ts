// BOUNDARY: captured message payloads are vendor JSON, walked as `unknown`.

// Envelope normalisation for the captured message fields, shared by the
// default integration and the vendor overrides: each turns a vendor's wrapper
// into the documented message array every reader walks.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Envelopes a message list arrives in, unwrapped so every reader walks the
 * documented array: OpenRouter Broadcast sends the request as `{ messages }`
 * and the reply as `{ completion, reasoning }`, and OpenInference's
 * `input.value` is often the whole request body around `messages`.
 */
export const unwrapMessages = (value: unknown): unknown =>
	isRecord(value) && Array.isArray(value.messages) ? value.messages : value

const completionChoices = (value: unknown): readonly unknown[] | undefined =>
	isRecord(value) && Array.isArray(value.choices) ? value.choices : undefined

export const unwrapOutputMessages = (value: unknown): unknown => {
	// OpenAI `chat.completion` objects, alone or in an array (OpenInference's
	// `output.value`): the reply is each choice's message, and the choice's
	// finish reason goes where the convention keeps it, on the message.
	const choices = (Array.isArray(value) ? value : [value]).map(completionChoices)
	if (choices.length > 0 && choices.every((entry) => entry !== undefined)) {
		return choices
			.flat()
			.flatMap((choice) =>
				isRecord(choice) && isRecord(choice.message)
					? [{ ...choice.message, finish_reason: choice.finish_reason }]
					: [],
			)
	}
	// One bare message (smolagents' `output.value`) is a one-message reply.
	if (isRecord(value) && typeof value.role === "string") return [value]
	if (!isRecord(value) || typeof value.completion !== "string") return unwrapMessages(value)
	const parts = [
		...(typeof value.reasoning === "string" && value.reasoning !== ""
			? [{ type: "reasoning", content: value.reasoning }]
			: []),
		...(value.completion === "" ? [] : [{ type: "text", content: value.completion }]),
	]
	return [{ role: "assistant", parts }]
}

/** A LangChain `ToolMessage` serialised whole as the tool result
 *  (`{ type: "tool", data: { type: "tool", content, tool_call_id, … } }`):
 *  what the tool returned is `data.content`. */
export const unwrapToolMessage = (value: unknown): unknown =>
	isRecord(value) &&
	value.type === "tool" &&
	isRecord(value.data) &&
	value.data.type === "tool" &&
	value.data.content !== undefined
		? value.data.content
		: value

/** An array of role-carrying messages — what the message fields hold once
 *  unwrapped, as opposed to a function's arbitrary input or output. */
export const isMessageList = (value: unknown): value is readonly Record<string, unknown>[] =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every((entry) => isRecord(entry) && typeof entry.role === "string")
