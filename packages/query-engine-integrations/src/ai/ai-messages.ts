import { Array as Arr, Record as Rec, String as Str } from "effect"
// BOUNDARY: captured message payloads are vendor JSON, walked as `unknown`.

// Envelope normalisation for the captured message fields, shared by the
// default integration and the vendor overrides: each turns a vendor's wrapper
// into the documented message array every reader walks.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

/**
 * Envelopes a message list arrives in, unwrapped so every reader walks the
 * documented array: OpenRouter Broadcast sends the request as `{ messages }`
 * and the reply as `{ completion, reasoning }`, and OpenInference's
 * `input.value` is often the whole request body around `messages`.
 */
export const unwrapMessages = (value: unknown): unknown =>
	isRecord(value) && Arr.isArray(value.messages) ? value.messages : value

const completionChoices = (value: unknown): readonly unknown[] | undefined =>
	isRecord(value) && Arr.isArray(value.choices) ? value.choices : undefined

export const unwrapOutputMessages = (value: unknown): unknown => {
	// OpenAI `chat.completion` objects, alone or in an array (OpenInference's
	// `output.value`): the reply is each choice's message, and the choice's
	// finish reason goes where the convention keeps it, on the message. Choices
	// carrying no message (a streamed chunk's `delta`, an empty `choices`)
	// leave the capture as it was rather than empty it.
	const choices = Arr.map(Arr.isArray(value) ? value : [value], completionChoices)
	if (choices.length > 0 && Arr.every(choices, (entry) => entry !== undefined)) {
		const messages = Arr.flatMap(choices.flat(), (choice) =>
			isRecord(choice) && isRecord(choice.message)
				? [{ ...choice.message, finish_reason: choice.finish_reason }]
				: [],
		)
		if (messages.length > 0) return messages
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
	Arr.isArray(value) &&
	value.length > 0 &&
	Arr.every(value, (entry) => isRecord(entry) && typeof entry.role === "string")

/** The records under a node's integer keys, in index order. */
const indexed = (value: unknown): readonly Record<string, unknown>[] =>
	isRecord(value)
		? Arr.filter(
				Arr.map(
					Arr.filter(Rec.keys(value), (key) => /^\d+$/.test(key)).sort(
						(a, b) => Number(a) - Number(b),
					),
					(key) => value[key],
				),
				isRecord,
			)
		: []

/**
 * OpenInference's flattened message list, rebuilt as OpenAI chat messages:
 * `<prefix>0.message.role`, `….contents.1.message_content.text`,
 * `….tool_calls.0.tool_call.function.name`, `….tool_call_id`. Every Python
 * instrumentor writes messages only in this form. `undefined` when the span
 * carries none.
 */
const nullPrototypeRecord = (): Record<string, unknown> => {
	const record: Record<string, unknown> = {}
	Reflect.setPrototypeOf(record, null)
	return record
}

export const flattenedMessages = (
	attributes: Record<string, string>,
	prefix: string,
): readonly Record<string, unknown>[] | undefined => {
	// Null-prototype nodes: the path segments come from untrusted keys.
	const root = nullPrototypeRecord()
	for (const [key, value] of Rec.toEntries(attributes)) {
		if (!Str.startsWith(prefix)(key) || value === "") continue
		const path = Str.split(".")(Str.slice(prefix.length)(key))
		let node = root
		for (const segment of path.slice(0, -1)) {
			const next = node[segment]
			if (isRecord(next)) {
				node = next
			} else {
				const created = nullPrototypeRecord()
				node[segment] = created
				node = created
			}
		}
		node[path[path.length - 1] ?? ""] = value
	}
	const messages = Arr.map(indexed(root), (entry) => {
		const { contents, tool_calls: toolCalls, ...message } = isRecord(entry.message) ? entry.message : {}
		// A content part with nothing in it (llamaindex writes `text = ""` beside
		// its tool calls) is no part at all.
		const parts = Arr.filter(
			Arr.map(indexed(contents), (content) => content.message_content),
			(part) => isRecord(part) && Arr.some(Rec.keys(part), (key) => key !== "type"),
		)
		if (parts.length > 0) message.content = parts
		const calls = Arr.map(indexed(toolCalls), (call) => call.tool_call)
		if (calls.length > 0) message.tool_calls = calls
		return message
	})
	return messages.length > 0 ? messages : undefined
}

/** A message field read the OpenInference way: the value when it is a message
 *  list, else the flattened keys, else the value as captured where the span
 *  is a model call. */
export const openInferenceMessages = (
	value: unknown,
	flattened: readonly Record<string, unknown>[] | undefined,
	modelCall: boolean,
): unknown => (isMessageList(value) ? value : (flattened ?? (modelCall ? value : undefined)))
