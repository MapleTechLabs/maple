/**
 * Gen-AI semconv content for Maple's own agents: the model call, the tool call and the agent pass.
 *
 * Effect AI's providers annotate the model-call span with the requested and served model, the
 * response id, the finish reasons and two token totals. Everything else the convention defines —
 * the provider name, the messages, the system instructions, the tool definitions, the cache and
 * reasoning buckets, the cost the provider billed, time to first chunk — is added here. Agent
 * Sessions reads all of it off the spans, and without it an investigation renders as a list of
 * models with no conversation in between.
 *
 * Message and tool payloads are capped, and a capped value keeps its *shape*: the read side's
 * `json` decoder admits objects and arrays only, so degrading an over-budget value to a string would
 * make the attribute vanish rather than render truncated. Message lists drop whole oldest messages
 * first (counted in `maple_ai.input_messages_dropped`), then truncate oversized part payloads in
 * place; tool values are wrapped and truncated as objects.
 */
import {
	MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR,
	MAPLE_GENAI_MODEL_DURATION_MS_ATTR,
} from "@maple/domain/gen-ai"
import { Clock, Effect, Option, Predicate, Stream } from "effect"
import type { Tracer } from "effect"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Prompt from "effect/unstable/ai/Prompt"
import * as Telemetry from "effect/unstable/ai/Telemetry"
import * as Tool from "effect/unstable/ai/Tool"

/**
 * Per-attribute size budgets, in JSON characters.
 *
 * Input messages replay the whole transcript on every step, so that is the one that meets real
 * pressure. The tool budget is the primary limiter for tool results, not a backstop: upstream bounds
 * them at `MAX_TOOL_OUTPUT_BYTES` (50k, `mcp/tools/tool-output.ts`), six times this cap.
 */
const INPUT_MESSAGES_BUDGET = 20_000
const OUTPUT_MESSAGES_BUDGET = 8_000
const TOOL_JSON_BUDGET = 8_000
const SYSTEM_INSTRUCTIONS_BUDGET = 8_000
const TOOL_DEFINITIONS_BUDGET = 16_000
const AGENT_DESCRIPTION_BUDGET = 1_024

type SerializedPart =
	| { readonly type: "text"; readonly content: string }
	| { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly arguments: unknown }
	| { readonly type: "tool_call_response"; readonly id: string; readonly response: unknown }

interface SerializedMessage {
	readonly role: string
	readonly parts: ReadonlyArray<SerializedPart>
	readonly finish_reason?: string
}

const TRUNCATION_MARKER = "…[truncated]"

const truncated = (text: string, cap: number): string =>
	text.length > cap ? text.slice(0, cap) + TRUNCATION_MARKER : text

/** `JSON.stringify` that reports an unserializable value (a cycle, a bigint) as nothing. */
const stringify = (value: unknown): string | undefined => {
	try {
		return JSON.stringify(value)
	} catch {
		return undefined
	}
}

/**
 * The convention's message part for one prompt part. Media is size and reasoning is
 * provider-hidden thought — neither is the conversation, so both are dropped.
 */
const promptPart = (
	part: Prompt.UserMessagePart | Prompt.AssistantMessagePart | Prompt.ToolMessagePart,
): ReadonlyArray<SerializedPart> => {
	switch (part.type) {
		case "text":
			return part.text === "" ? [] : [{ type: "text", content: part.text }]
		case "tool-call":
			return [{ type: "tool_call", id: part.id, name: part.name, arguments: part.params }]
		case "tool-result":
			return [{ type: "tool_call_response", id: part.id, response: part.result }]
		default:
			return []
	}
}

/** The prompt as `gen_ai.input.messages` documents it. System messages go to their own attribute. */
const inputMessages = (prompt: Prompt.Prompt): Array<SerializedMessage> => {
	const messages: Array<SerializedMessage> = []
	for (const message of prompt.content) {
		if (message.role === "system") continue
		const parts: Array<SerializedPart> = []
		for (const part of message.content) parts.push(...promptPart(part))
		messages.push({ role: message.role, parts })
	}
	return messages
}

/** `gen_ai.system_instructions`: an array of `{type, content}` parts, bounded like the messages. */
const systemInstructionsJson = (prompt: Prompt.Prompt): string | undefined => {
	const parts = prompt.content.flatMap((message) =>
		message.role === "system" && message.content !== ""
			? [{ type: "text", content: message.content }]
			: [],
	)
	if (parts.length === 0) return undefined
	const json = JSON.stringify(parts)
	if (json.length <= SYSTEM_INSTRUCTIONS_BUDGET) return json
	const cap = Math.max(256, Math.floor(SYSTEM_INSTRUCTIONS_BUDGET / parts.length))
	return JSON.stringify(parts.map((part) => ({ ...part, content: truncated(part.content, cap) })))
}

/**
 * The finish reason in the convention's underscore form. Effect AI hyphenates; the read side matches
 * `content_filter` as a refusal and normalises `tool_calls`.
 */
export const semconvFinishReason = (reason: string): string =>
	reason === "tool-calls" ? "tool_calls" : reason === "content-filter" ? "content_filter" : reason

type ResponseParts = Parameters<Telemetry.SpanTransformer>[0]["response"]

/**
 * What the model sent back, folded into one assistant message.
 *
 * A streamed response arrives as deltas, a generated one as whole parts; both are handled because
 * the transformer receives whichever the call produced. The finish part is returned alongside —
 * absent when the stream ended early, which is exactly when the partial message is worth keeping.
 */
const summarizeResponse = (response: ResponseParts) => {
	const parts: Array<SerializedPart> = []
	const open = new Map<string, { readonly type: "text"; content: string }>()
	let finish: Extract<ResponseParts[number], { readonly type: "finish" }> | undefined
	let errored = false
	for (const part of response) {
		switch (part.type) {
			case "text":
				parts.push({ type: "text", content: part.text })
				break
			case "text-delta": {
				const text = open.get(part.id)
				if (text === undefined) {
					const created = { type: "text" as const, content: part.delta }
					open.set(part.id, created)
					parts.push(created)
				} else {
					text.content += part.delta
				}
				break
			}
			case "tool-call":
				parts.push({ type: "tool_call", id: part.id, name: part.name, arguments: part.params })
				break
			case "finish":
				finish = part
				break
			case "error":
				errored = true
				break
		}
	}
	const message: SerializedMessage = {
		role: "assistant",
		parts: parts.filter((part) => part.type !== "text" || part.content !== ""),
		...(finish === undefined ? undefined : { finish_reason: semconvFinishReason(finish.reason) }),
	}
	return { message, finish, failed: errored || finish?.reason === "error" }
}

/** The payload's JSON prefix when it outweighs `cap`, or nothing when it fits unchanged. */
const oversizedPayloadPrefix = (value: unknown, cap: number): string | undefined => {
	const json = stringify(value) ?? String(value)
	return json.length > cap ? json.slice(0, cap) + TRUNCATION_MARKER : undefined
}

const boundPart = (part: SerializedPart, cap: number): SerializedPart => {
	switch (part.type) {
		case "text":
			return part.content.length > cap ? { ...part, content: truncated(part.content, cap) } : part
		case "tool_call": {
			const prefix = oversizedPayloadPrefix(part.arguments, cap)
			return prefix === undefined ? part : { ...part, arguments: prefix }
		}
		case "tool_call_response": {
			const prefix = oversizedPayloadPrefix(part.response, cap)
			return prefix === undefined ? part : { ...part, response: prefix }
		}
	}
}

/** First message the encoded list can start at and still fit — the newest is never dropped. */
const fitFrom = (encoded: ReadonlyArray<string>, budget: number): number => {
	let total = encoded.reduce((sum, json) => sum + json.length + 1, 1)
	let start = 0
	while (total > budget && start < encoded.length - 1) {
		total -= encoded[start]!.length + 1
		start += 1
	}
	return start
}

const encodeMessage = (message: SerializedMessage): string =>
	stringify(message) ??
	JSON.stringify({ ...message, parts: message.parts.map((part) => boundPart(part, 256)) })

/** Exported for tests. */
export const messagesJson = (
	messages: ReadonlyArray<SerializedMessage>,
	budget: number,
): { readonly json: string; readonly dropped: number } => {
	let rendered = messages
	// One serialization per message, so trimming to budget is a prefix-sum walk rather than a
	// re-stringify of the whole array per dropped message.
	let encoded = rendered.map(encodeMessage)
	let start = fitFrom(encoded, budget)
	// A single message can outweigh the whole budget — routinely, since a tool result may run to 50k
	// against the 20k input cap. Bound each surviving part's payload and re-fit. A soft budget: JSON
	// escaping and a message with many parts can overshoot it, bounded, which beats losing the
	// attribute.
	if (encoded.slice(start).reduce((sum, json) => sum + json.length + 1, 1) > budget) {
		const cap = Math.max(256, Math.floor(budget / 8))
		rendered = rendered.map((message, index) =>
			index < start
				? message
				: { ...message, parts: message.parts.map((part) => boundPart(part, cap)) },
		)
		encoded = rendered.map(encodeMessage)
		start = fitFrom(encoded, budget)
	}
	return { json: `[${encoded.slice(start).join(",")}]`, dropped: start }
}

/**
 * The dollar cost OpenRouter reported for the call, or nothing.
 *
 * OpenRouter is the only provider that prices a call in-band: with usage accounting on (see
 * `withPerCallFields` in `./Llm.ts`) the final usage object carries `cost`, and the provider passes
 * the raw usage through on the finish part. Maple never prices tokens itself.
 */
const reportedCost = (metadata: unknown): number | undefined => {
	if (!Predicate.hasProperty(metadata, "openrouter")) return undefined
	const openrouter = metadata.openrouter
	if (!Predicate.hasProperty(openrouter, "usage") || !Predicate.hasProperty(openrouter.usage, "cost")) {
		return undefined
	}
	const cost = openrouter.usage.cost
	return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

export interface ModelCallTelemetry {
	/** `gen_ai.provider.name`. */
	readonly providerName: string
	/** `gen_ai.request.reasoning.level`, when the call asks for one. */
	readonly reasoningLevel?: string
	/** The agent-session identity every model-call span carries — see `agentSessionSpanAttributes`. */
	readonly sessionAttributes: Readonly<Record<string, string>>
}

/** One call's clock, read by the transformer when the stream ends. */
interface CallTiming {
	readonly startedMs: number
	firstChunkMs: number | undefined
	finishedMs: number | undefined
}

const modelCallTransformer =
	(telemetry: ModelCallTelemetry, timing: CallTiming): Telemetry.SpanTransformer =>
	({ span, prompt, responseFormat, response }) => {
		const input = messagesJson(inputMessages(prompt), INPUT_MESSAGES_BUDGET)
		const system = systemInstructionsJson(prompt)
		const { message, finish, failed } = summarizeResponse(response)
		const cost = finish === undefined ? undefined : reportedCost(finish.metadata)
		const attributes = {
			"gen_ai.provider.name": telemetry.providerName,
			"gen_ai.request.stream": true,
			...(telemetry.reasoningLevel === undefined
				? undefined
				: { "gen_ai.request.reasoning.level": telemetry.reasoningLevel }),
			"gen_ai.output.type": responseFormat.type,
			"gen_ai.input.messages": input.json,
			...(input.dropped > 0 ? { [MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR]: input.dropped } : undefined),
			...(system === undefined ? undefined : { "gen_ai.system_instructions": system }),
			...(message.parts.length === 0
				? undefined
				: { "gen_ai.output.messages": messagesJson([message], OUTPUT_MESSAGES_BUDGET).json }),
			...(finish === undefined
				? undefined
				: {
						// The provider already wrote these in Effect AI's hyphenated form; this runs after it.
						"gen_ai.response.finish_reasons": [semconvFinishReason(finish.reason)],
						"gen_ai.usage.input_tokens": finish.usage.inputTokens.total,
						"gen_ai.usage.output_tokens": finish.usage.outputTokens.total,
						"gen_ai.usage.cache_read.input_tokens": finish.usage.inputTokens.cacheRead,
						// The registry spelling; the read side decodes it as an alias of `cache_creation`.
						"gen_ai.usage.cache_write.input_tokens": finish.usage.inputTokens.cacheWrite,
						"gen_ai.usage.reasoning.output_tokens": finish.usage.outputTokens.reasoning,
						...(cost === undefined ? undefined : { "gen_ai.usage.cost": cost }),
					}),
			// A provider failure surfaced as a stream part completes the stream, so the span exit stays
			// green — these are the record of it, and what the session view's failure counting reads.
			...(failed ? { "error.type": "provider_error", "gen_ai.response.status": "failed" } : undefined),
			// Seconds by convention. The span's own clock covers the whole stream lifetime, including
			// the consumer draining it, so these two are the model's honest numbers.
			...(timing.firstChunkMs === undefined
				? undefined
				: { "gen_ai.response.time_to_first_chunk": (timing.firstChunkMs - timing.startedMs) / 1000 }),
			...(timing.finishedMs === undefined
				? undefined
				: { [MAPLE_GENAI_MODEL_DURATION_MS_ATTR]: timing.finishedMs - timing.startedMs }),
			...telemetry.sessionAttributes,
		}
		for (const [key, value] of Object.entries(attributes)) {
			if (value !== undefined) span.attribute(key, value)
		}
	}

/**
 * The language model, with every `streamText` call annotating its own span.
 *
 * The transformer is provided per call rather than once on the layer because two of its numbers are
 * per call: the first chunk and the finish are timed as they pass through, and the transformer reads
 * them when Effect AI applies it — as the stream ends, including when it fails. `streamText` is the
 * only call Maple makes; the other methods pass through unannotated.
 */
export const withModelCallTelemetry = (
	service: LanguageModel.Service,
	telemetry: ModelCallTelemetry,
): LanguageModel.Service => ({
	...service,
	streamText: ((options) =>
		Stream.unwrap(
			Effect.map(Clock.currentTimeMillis, (startedMs) => {
				const timing: CallTiming = { startedMs, firstChunkMs: undefined, finishedMs: undefined }
				return service.streamText(options).pipe(
					Stream.tap((part) =>
						timing.firstChunkMs === undefined || part.type === "finish"
							? Effect.map(Clock.currentTimeMillis, (now) => {
									timing.firstChunkMs ??= now
									if (part.type === "finish") timing.finishedMs = now
								})
							: Effect.void,
					),
					Stream.provideService(
						Telemetry.CurrentSpanTransformer,
						modelCallTransformer(telemetry, timing),
					),
				)
			}),
		)) as LanguageModel.Service["streamText"],
})

/**
 * Bounded JSON for tool arguments and results; always an object or array, because the read side's
 * `json` decoder drops scalars and Maple's own tool results are strings. Exported for tests.
 */
export const toolCallJson = (value: unknown): string => {
	const wrapped = typeof value === "object" && value !== null ? value : { result: value }
	const json = stringify(wrapped)
	if (json === undefined) return JSON.stringify({ result: truncated(String(value), TOOL_JSON_BUDGET) })
	if (json.length <= TOOL_JSON_BUDGET) return json
	let prefix = json.slice(0, TOOL_JSON_BUDGET)
	let out = JSON.stringify({ truncated: true, prefix })
	if (out.length > TOOL_JSON_BUDGET) {
		// Re-encoding escapes quotes and backslashes, expanding the prefix; one corrective re-slice by
		// the measured excess holds the cap, since every removed input character removes at least one
		// output character.
		prefix = prefix.slice(0, Math.max(0, prefix.length - (out.length - TOOL_JSON_BUDGET)))
		out = JSON.stringify({ truncated: true, prefix })
	}
	return out
}

/**
 * `gen_ai.tool.definitions`: `[{type, name, description, parameters}]`. Schemas are the bulk, so over
 * budget they are the first thing dropped — names and the opening of each description are what the
 * session view needs, and 128 characters keeps the chat agent's ~60 MCP tools inside the budget.
 */
const toolDefinitionsJson = (tools: ReadonlyArray<Tool.Any>): string | undefined => {
	if (tools.length === 0) return undefined
	const described = tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: Tool.getDescription(tool) ?? "",
	}))
	let full: string | undefined
	try {
		// A schema that cannot be expressed as JSON Schema throws here; it degrades to the compact form.
		full = JSON.stringify(
			tools.map((tool, index) => ({ ...described[index], parameters: Tool.getJsonSchema(tool) })),
		)
	} catch {
		full = undefined
	}
	if (full !== undefined && full.length <= TOOL_DEFINITIONS_BUDGET) return full
	return JSON.stringify(
		described.map((tool) => ({ ...tool, description: truncated(tool.description, 128) })),
	)
}

/**
 * The `invoke_agent` half of a headless agent pass: which agent ran, on what, with which tools.
 *
 * Tool definitions go here rather than on every model call: they are the same for the whole pass,
 * and at up to 16k characters each they would otherwise be repeated on every step.
 */
export const invokeAgentAttributes = (options: {
	readonly agentName: string
	readonly agentDescription: string
	/** The engine's thread id, which its `execute_tool` spans carry as `gen_ai.conversation.id`. */
	readonly conversationId: string
	readonly providerName: string
	readonly model: string
	readonly tools: ReadonlyArray<Tool.Any>
}): Readonly<Record<string, string>> => {
	const definitions = toolDefinitionsJson(options.tools)
	return {
		"gen_ai.operation.name": "invoke_agent",
		"gen_ai.agent.name": options.agentName,
		// Bounded: hypothesis agents put planner-written text there, the one description with no
		// length guarantee.
		...(options.agentDescription === ""
			? undefined
			: { "gen_ai.agent.description": truncated(options.agentDescription, AGENT_DESCRIPTION_BUDGET) }),
		"gen_ai.conversation.id": options.conversationId,
		"gen_ai.provider.name": options.providerName,
		"gen_ai.request.model": options.model,
		...(definitions === undefined ? undefined : { "gen_ai.tool.definitions": definitions }),
	}
}

const EXECUTE_TOOL_SPAN_PREFIX = "execute_tool "

/**
 * The engine's `execute_tool` span, found from inside a tool handler.
 *
 * effect-agent's tool spans are content-free by design, and it runs a handler under a local span it
 * never exports (`AgentRuntime.toolkit.handle`) whose parent is the canonical `execute_tool` one — so
 * an `annotateCurrentSpan` there would land on a span nobody sees. Matched by the convention's span
 * name, not the engine's internal one, so a handler that already runs directly under the tool span
 * works the same.
 */
const executeToolSpan = (span: Tracer.AnySpan): Tracer.Span | undefined => {
	if (span._tag !== "Span") return undefined
	if (span.name.startsWith(EXECUTE_TOOL_SPAN_PREFIX)) return span
	return Option.match(span.parent, {
		onNone: () => undefined,
		onSome: (parent) =>
			parent._tag === "Span" && parent.name.startsWith(EXECUTE_TOOL_SPAN_PREFIX) ? parent : undefined,
	})
}

const annotateExecuteToolSpan = (attributes: Readonly<Record<string, string>>): Effect.Effect<void> =>
	Effect.currentSpan.pipe(
		Effect.map((current) => {
			const span = executeToolSpan(current)
			if (span === undefined) return
			for (const [key, value] of Object.entries(attributes)) span.attribute(key, value)
		}),
		Effect.ignore,
	)

/** Record a tool call's description, arguments and result — or failure — on its `execute_tool` span. */
export const withToolCallContent = <A, E extends { readonly message: string }, R>(
	handler: Effect.Effect<A, E, R>,
	call: { readonly description: string; readonly params: unknown },
): Effect.Effect<A, E, R> =>
	annotateExecuteToolSpan({
		"gen_ai.tool.description": call.description,
		"gen_ai.tool.call.arguments": toolCallJson(call.params),
	}).pipe(
		Effect.andThen(handler),
		Effect.tap((result) => annotateExecuteToolSpan({ "gen_ai.tool.call.result": toolCallJson(result) })),
		Effect.tapError((error) =>
			annotateExecuteToolSpan({ "gen_ai.tool.call.result": toolCallJson(error.message) }),
		),
	)
