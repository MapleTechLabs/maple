# TypeScript: install, init, helper, loop

Tested: Node.js 22+ (ESM), `openai` 7.23.0, `@opentelemetry/api` 1.9.1, `@opentelemetry/sdk-node` 0.222.0, `@opentelemetry/exporter-trace-otlp-proto` 0.222.0.

Why a helper: `@opentelemetry/instrumentation-openai` 0.20 only patches `openai` >=4.19 <7 and writes message content to log events (Maple reads span attributes only). `tracedChat` writes the GenAI attributes Maple reads.

## Install

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto
```

## instrumentation.ts (import first in the entry point)

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { NodeSDK, tracing } from "@opentelemetry/sdk-node"

// The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS.
export const spanProcessor = new tracing.BatchSpanProcessor(new OTLPTraceExporter())

export const sdk = new NodeSDK({ serviceName: "support-agent", spanProcessors: [spanProcessor] })
sdk.start()
```

- The exporter reads `OTEL_*` when it is constructed, and `agent-tracing.ts` reads the capture switch when it is imported. If the app loads `.env` (`dotenv`, `--env-file`), put `import "dotenv/config"` at the top of `instrumentation.ts`; otherwise the exporter silently targets `localhost:4318` with no key.
- No env convention in the repo: pass the values inline, `new OTLPTraceExporter({ url: "https://ingest.maple.dev/v1/traces", headers: { Authorization: "Bearer <key>" } })`. Never build the header from an env var that can be unset (`Bearer undefined` is an opaque 401).
- Flush: `await sdk.shutdown().catch((err) => console.error("telemetry flush failed", err))`; it rejects when an export failed.

Existing `NodeSDK` / `NodeTracerProvider` / `registerOTel` → don't add another; add a `BatchSpanProcessor(new OTLPTraceExporter())` to it (keep a reference for `forceFlush`).

## agent-tracing.ts (copy verbatim, rename the tracer)

```ts
import { type Attributes, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import type OpenAI from "openai"

const tracer = trace.getTracer("support-agent")

const captureContent = ["SPAN_ONLY", "SPAN_AND_EVENT"].includes(
	(process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ?? "").toUpperCase(),
)

/** One agent run. With a conversation id, it's the turn Maple files under that session. */
export function agentSpan<T>(agentName: string, conversationId: string | undefined, fn: () => Promise<T>) {
	const attributes: Attributes = { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": agentName }
	if (conversationId) attributes["gen_ai.conversation.id"] = conversationId
	return withSpan(`invoke_agent ${agentName}`, SpanKind.INTERNAL, attributes, () => fn())
}

/** One tool call. A failing tool returns its error to the model, and the span still says it failed. */
export function runTool(
	callId: string,
	name: string,
	args: string,
	tool: (args: any) => unknown,
): Promise<string> {
	return withSpan(
		`execute_tool ${name}`,
		SpanKind.INTERNAL,
		{
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": name,
			"gen_ai.tool.call.id": callId,
		},
		async (span) => {
			if (captureContent) span.setAttribute("gen_ai.tool.call.arguments", args)
			let result: string
			try {
				result = JSON.stringify((await tool(JSON.parse(args))) ?? null)
			} catch (error) {
				markFailed(span, error)
				result = JSON.stringify({ error: String(error) })
			}
			if (captureContent) span.setAttribute("gen_ai.tool.call.result", result)
			return result
		},
	)
}

type ChatParams = Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, "stream">

/** One model call. Pass `onText` to stream; usage still arrives. */
export function tracedChat(client: OpenAI, params: ChatParams, onText?: (delta: string) => void) {
	return withSpan(
		`chat ${params.model}`,
		SpanKind.CLIENT,
		{
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": "openai",
			"gen_ai.request.model": params.model,
		},
		async (span) => {
			if (captureContent) {
				span.setAttribute("gen_ai.input.messages", JSON.stringify(params.messages.map(toGenAiMessage)))
			}
			let completion: OpenAI.Chat.ChatCompletion
			if (onText) {
				const started = performance.now()
				let firstChunkAt: number | undefined
				const stream = client.chat.completions.stream({
					...params,
					// Without this, a streamed call reports no tokens at all.
					stream_options: { include_usage: true },
				})
				stream.on("content", (delta) => {
					firstChunkAt ??= performance.now()
					onText(delta)
				})
				completion = await stream.finalChatCompletion()
				if (firstChunkAt !== undefined) {
					span.setAttribute("gen_ai.response.time_to_first_chunk", (firstChunkAt - started) / 1000)
				}
			} else {
				completion = await client.chat.completions.create(params)
			}

			span.setAttributes({
				"gen_ai.response.id": completion.id,
				"gen_ai.response.model": completion.model,
				"gen_ai.response.finish_reasons": completion.choices.map((c) => c.finish_reason),
			})
			if (completion.usage) {
				span.setAttributes({
					"gen_ai.usage.input_tokens": completion.usage.prompt_tokens,
					"gen_ai.usage.output_tokens": completion.usage.completion_tokens,
					"gen_ai.usage.cache_read.input_tokens": completion.usage.prompt_tokens_details?.cached_tokens ?? 0,
					"gen_ai.usage.reasoning.output_tokens":
						completion.usage.completion_tokens_details?.reasoning_tokens ?? 0,
				})
				// OpenRouter adds the call's price in USD to usage. Other providers don't send one.
				const cost = (completion.usage as { cost?: number }).cost
				if (cost !== undefined) span.setAttribute("gen_ai.usage.cost", cost)
			}
			if (captureContent) {
				const output = completion.choices.map((c) => ({
					...toGenAiMessage(c.message),
					finish_reason: c.finish_reason,
				}))
				span.setAttribute("gen_ai.output.messages", JSON.stringify(output))
			}
			return completion
		},
	)
}

// OpenAI chat messages -> the {role, parts} shape Maple renders as a transcript. Text and tool calls only.
function toGenAiMessage(message: OpenAI.Chat.ChatCompletionMessageParam | OpenAI.Chat.ChatCompletionMessage) {
	if (message.role === "tool") {
		return {
			role: "tool",
			parts: [{ type: "tool_call_response", id: message.tool_call_id, response: message.content }],
		}
	}
	const parts: object[] = []
	if (typeof message.content === "string" && message.content) {
		parts.push({ type: "text", content: message.content })
	}
	if (message.role === "assistant") {
		for (const call of message.tool_calls ?? []) {
			if (call.type === "function") {
				parts.push({ type: "tool_call", id: call.id, name: call.function.name, arguments: call.function.arguments })
			}
		}
	}
	return { role: message.role, parts }
}

function withSpan<T>(name: string, kind: SpanKind, attributes: Attributes, fn: (span: Span) => Promise<T>) {
	return tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
		try {
			return await fn(span)
		} catch (error) {
			markFailed(span, error)
			throw error
		} finally {
			span.end()
		}
	})
}

function markFailed(span: Span, error: unknown) {
	const err = error instanceof Error ? error : new Error(String(error))
	span.recordException(err)
	span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
	span.setAttribute("error.type", err.name)
}
```

## Loop (OpenAI Chat Completions)

```ts
import "./instrumentation.ts"
import OpenAI from "openai"
import { agentSpan, runTool, tracedChat } from "./agent-tracing.ts"

const client = new OpenAI()
const model = "gpt-4o-mini"

const tools: Record<string, (args: any) => unknown> = {
	get_weather: ({ city }: { city: string }) => ({ city, temperature_c: 21, condition: "partly cloudy" }),
}
const toolSchemas: OpenAI.Chat.ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "get_weather",
			parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
		},
	},
]

/** One user message in, one reply out. `history` is this conversation's stored messages. */
export function chatTurn(
	conversationId: string,
	history: OpenAI.Chat.ChatCompletionMessageParam[],
	userText: string,
	onText?: (delta: string) => void,
) {
	return agentSpan("support_agent", conversationId, async () => {
		history.push({ role: "user", content: userText })
		while (true) {
			const completion = await tracedChat(client, { model, messages: history, tools: toolSchemas }, onText)
			const message = completion.choices[0].message
			history.push(message)
			if (!message.tool_calls?.length) return message.content ?? ""
			for (const call of message.tool_calls) {
				if (call.type !== "function") continue
				const result = await runTool(call.id, call.function.name, call.function.arguments, tools[call.function.name])
				history.push({ role: "tool", tool_call_id: call.id, content: result })
			}
		}
	})
}
```

- Replace every `client.chat.completions.create(...)` in the agent with `tracedChat(client, params)`. Don't wrap `create` twice.
- Sub-agent inside a tool: `runTool(id, "ask_weather_worker", args, (a) => agentSpan("weather_worker", undefined, () => workerLoop(a)))`.

## Anthropic (`@anthropic-ai/sdk`) or Gemini (`@google/genai`)

Copy `tracedChat` to `tracedAnthropic` / `tracedGemini`, call the SDK, and set these attributes (input includes cache, output includes reasoning):

| Attribute | Anthropic Messages | Gemini `generateContent` |
| --- | --- | --- |
| span name | `chat <model>` | `generate_content <model>` |
| `gen_ai.operation.name` | `chat` | `generate_content` |
| `gen_ai.provider.name` | `anthropic` | `gcp.gemini` (`gcp.vertex_ai` on Vertex) |
| `gen_ai.request.model` | request `model` | request `model` |
| `gen_ai.response.id` / `gen_ai.response.model` | `id` / `model` | `responseId` / `modelVersion` |
| `gen_ai.response.finish_reasons` | `[stop_reason]` | `candidates.map(c => c.finishReason)` |
| `gen_ai.usage.input_tokens` | `usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)` | `usageMetadata.promptTokenCount` |
| `gen_ai.usage.output_tokens` | `usage.output_tokens` | `(usageMetadata.candidatesTokenCount ?? 0) + (usageMetadata.thoughtsTokenCount ?? 0)` |
| `gen_ai.usage.cache_read.input_tokens` | `usage.cache_read_input_tokens ?? 0` | `usageMetadata.cachedContentTokenCount ?? 0` |
| `gen_ai.usage.cache_write.input_tokens` | `usage.cache_creation_input_tokens ?? 0` | (omit) |
| `gen_ai.usage.reasoning.output_tokens` | (omit) | `usageMetadata.thoughtsTokenCount ?? 0` |
| `gen_ai.system_instructions` (content on) | `JSON.stringify([{type:"text",content:system}])` | same, from `config.systemInstruction` |

Messages (content on) as JSON `[{role, parts}]`:
- text block / text part → `{type:"text", content}`
- `tool_use` / `functionCall` → `{type:"tool_call", id, name, arguments}` (`input` / `args`)
- `tool_result` / `functionResponse` → `{type:"tool_call_response", id, response}`
- Gemini role `model` → `assistant`. Output messages also get `finish_reason`.

Streaming: Anthropic `client.messages.stream(...)` → `await stream.finalMessage()` has usage. Gemini `generateContentStream` → take `usageMetadata` from the last chunk.
