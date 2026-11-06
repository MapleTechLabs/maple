# TypeScript reference (Node.js 20+)

Tested pattern: OpenTelemetry JS SDK 2.11 (`@opentelemetry/sdk-trace-node`, `sdk-trace-base`, `resources` 2.11; `exporter-trace-otlp-proto` 0.222; `api` 1.9), `openai` 7.23 against an OpenAI-compatible Chat Completions API (OpenRouter here), Node.js 26, run with `tsx`.

This is a complete loop. If the project already has a loop, keep its structure and copy only the span code: `invoke_agent` around one agent run, `chat` around each model call, `execute_tool` around each tool call, `toSemconv` for messages.

```bash
npm install @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto @opentelemetry/resources
```

Existing provider (`NodeSDK`, `@vercel/otel`, Sentry): do not create `tracing.ts`; add `new BatchSpanProcessor(new OTLPTraceExporter())` to it. The provider must register an async context manager (`provider.register()` / `NodeSDK.start()` do), or child spans become separate traces.

## tracing.ts

```ts
// tracing.ts: import this first in every entry point
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"

export const provider = new NodeTracerProvider({
	resource: resourceFromAttributes({
		"service.name": "support-agent",
		"deployment.environment.name": "production",
	}),
	// Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
	spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
})
// Registers the global provider and the async context manager, so spans nest across awaits
provider.register()
```

- `OTLPTraceExporter` reads `OTEL_*` when it is constructed. If the app loads `.env` (`dotenv`, `--env-file`), put `import "dotenv/config"` at the top of `tracing.ts`; otherwise the exporter silently targets `localhost:4318` with no key.
- No env convention in the repo: pass the values inline, `new OTLPTraceExporter({ url: "https://ingest.maple.dev/v1/traces", headers: { Authorization: "Bearer <key>" } })`. Never build the header from an env var that can be unset (`Bearer undefined` is an opaque 401).

## agent.ts

```ts
// agent.ts
import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import OpenAI from "openai"
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionMessageFunctionToolCall,
	ChatCompletionMessageParam,
	ChatCompletionTool,
} from "openai/resources/chat/completions"

const tracer = trace.getTracer("support-agent")
const client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY })
const PROVIDER = "openrouter" // gen_ai.provider.name: who you send the request to

type Message = ChatCompletionMessageParam
type ToolCall = ChatCompletionMessageFunctionToolCall
type Tool = { definition: ChatCompletionTool; run: (args: Record<string, unknown>) => unknown }
export type Agent = { name: string; model: string; instructions: string; tools: Record<string, Tool> }

const json = (value: unknown) => JSON.stringify(value)

// Model-generated arguments are not always valid JSON; keep the raw text then.
function parseArguments(text: string) {
	try {
		return JSON.parse(text || "{}")
	} catch {
		return text
	}
}

// OpenAI message -> GenAI semconv message: { role, parts: [...] }
function toSemconv(message: Message) {
	if (message.role === "tool") {
		return { role: "tool", parts: [{ type: "tool_call_response", id: message.tool_call_id, response: message.content }] }
	}
	const parts: object[] = typeof message.content === "string" && message.content ? [{ type: "text", content: message.content }] : []
	if (message.role === "assistant") {
		for (const call of message.tool_calls ?? []) {
			if (call.type !== "function") continue
			parts.push({ type: "tool_call", id: call.id, name: call.function.name, arguments: parseArguments(call.function.arguments) })
		}
	}
	return { role: message.role, parts }
}

function markFailed(span: Span, error: unknown) {
	const err = error instanceof Error ? error : new Error(String(error))
	span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
	span.setAttribute("error.type", err.name)
}

// One model call = one `chat` span. Streams, so time to first chunk is recorded too.
async function chat(agent: Agent, messages: Message[], onText?: (delta: string) => void) {
	return tracer.startActiveSpan(
		`chat ${agent.model}`,
		{
			kind: SpanKind.CLIENT,
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.provider.name": PROVIDER,
				"gen_ai.request.model": agent.model,
				"gen_ai.system_instructions": json([{ type: "text", content: agent.instructions }]),
				"gen_ai.input.messages": json(messages.map(toSemconv)),
			},
		},
		async (span) => {
			try {
				const started = performance.now()
				const stream = await client.chat.completions.create({
					model: agent.model,
					messages: [{ role: "system", content: agent.instructions }, ...messages],
					tools: Object.values(agent.tools).map((tool) => tool.definition),
					stream: true,
					stream_options: { include_usage: true }, // without it, streamed calls report no tokens
				})
				let id = ""
				let model = agent.model
				let text = ""
				let finishReason = "stop"
				let usage: (OpenAI.CompletionUsage & { cost?: number }) | undefined
				const calls: ToolCall[] = []
				for await (const chunk of stream) {
					if (!id) span.setAttribute("gen_ai.response.time_to_first_chunk", (performance.now() - started) / 1000)
					id = chunk.id
					model = chunk.model
					if (chunk.usage) usage = chunk.usage
					const choice = chunk.choices[0]
					if (!choice) continue
					if (choice.finish_reason) finishReason = choice.finish_reason
					if (choice.delta.content) {
						text += choice.delta.content
						onText?.(choice.delta.content)
					}
					for (const delta of choice.delta.tool_calls ?? []) {
						const call = (calls[delta.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } })
						if (delta.id) call.id = delta.id
						call.function.name += delta.function?.name ?? ""
						call.function.arguments += delta.function?.arguments ?? ""
					}
				}
				const reply: ChatCompletionAssistantMessageParam = { role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) }
				span.setAttributes({
					"gen_ai.response.id": id,
					"gen_ai.response.model": model,
					"gen_ai.response.finish_reasons": [finishReason],
					"gen_ai.output.messages": json([{ ...toSemconv(reply), finish_reason: finishReason }]),
				})
				if (usage) {
					span.setAttributes({
						"gen_ai.usage.input_tokens": usage.prompt_tokens,
						"gen_ai.usage.output_tokens": usage.completion_tokens,
						"gen_ai.usage.cache_read.input_tokens": usage.prompt_tokens_details?.cached_tokens ?? 0,
						"gen_ai.usage.reasoning.output_tokens": usage.completion_tokens_details?.reasoning_tokens ?? 0,
					})
					if (usage.cost !== undefined) span.setAttribute("gen_ai.usage.cost", usage.cost) // OpenRouter returns USD cost
				}
				return reply
			} catch (error) {
				markFailed(span, error)
				throw error
			} finally {
				span.end()
			}
		},
	)
}

// One tool call = one `execute_tool` span. A failure is marked on the span and returned to the model.
async function runTool(agent: Agent, call: ToolCall) {
	const name = call.function.name
	return tracer.startActiveSpan(
		`execute_tool ${name}`,
		{
			kind: SpanKind.INTERNAL,
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": name,
				"gen_ai.tool.type": "function",
				"gen_ai.tool.call.id": call.id,
				"gen_ai.tool.call.arguments": call.function.arguments || "{}",
			},
		},
		async (span) => {
			try {
				const result = await agent.tools[name]!.run(JSON.parse(call.function.arguments || "{}"))
				const output = typeof result === "string" ? result : json(result ?? null)
				span.setAttribute("gen_ai.tool.call.result", output)
				return output
			} catch (error) {
				markFailed(span, error)
				return json({ error: error instanceof Error ? error.message : String(error) })
			} finally {
				span.end()
			}
		},
	)
}

// One agent run = one `invoke_agent` span. For a user turn it is the root of the trace.
export async function runAgent(
	agent: Agent,
	messages: Message[],
	options: { conversationId?: string; onText?: (delta: string) => void } = {},
): Promise<string> {
	const input = messages.at(-1)
	return tracer.startActiveSpan(
		`invoke_agent ${agent.name}`,
		{
			kind: SpanKind.INTERNAL,
			attributes: {
				"gen_ai.operation.name": "invoke_agent",
				"gen_ai.agent.name": agent.name,
				...(options.conversationId ? { "gen_ai.conversation.id": options.conversationId } : {}),
				...(input ? { "gen_ai.input.messages": json([toSemconv(input)]) } : {}),
			},
		},
		async (span) => {
			try {
				for (let step = 0; step < 10; step++) {
					const reply = await chat(agent, messages, options.onText)
					messages.push(reply)
					if (!reply.tool_calls?.length) {
						span.setAttribute("gen_ai.output.messages", json([toSemconv(reply)]))
						return typeof reply.content === "string" ? reply.content : ""
					}
					for (const call of reply.tool_calls) {
						if (call.type !== "function") continue
						messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(agent, call) })
					}
				}
				throw new Error("agent exceeded 10 steps")
			} catch (error) {
				markFailed(span, error)
				throw error
			} finally {
				span.end()
			}
		},
	)
}
```

## main.ts (chat backend entry point)

```ts
// main.ts
import { provider } from "./tracing" // first import: sets up the provider
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { type Agent, runAgent } from "./agent"

const assistant: Agent = {
	name: "support",
	model: "openai/gpt-4o-mini",
	instructions: "You are a concise assistant.",
	tools: {
		get_weather: {
			definition: {
				type: "function",
				function: {
					name: "get_weather",
					description: "Current weather for a city",
					parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
				},
			},
			run: ({ city }) => ({ city, temperature_c: 21, condition: "partly cloudy" }),
		},
	},
}

// One history per conversation. Store it in your database in a real backend.
const histories = new Map<string, ChatCompletionMessageParam[]>()

export async function handleMessage(chatId: string, text: string, onText?: (delta: string) => void) {
	const history = histories.get(chatId) ?? []
	histories.set(chatId, history)
	history.push({ role: "user", content: text })
	return runAgent(assistant, history, { conversationId: chatId, onText })
}

// In a script: two messages of one conversation, then flush
try {
	await handleMessage("chat_42", "Hi! Briefly introduce yourself.")
	await handleMessage("chat_42", "What's the weather in Berlin?", (delta) => process.stdout.write(delta))
} finally {
	// Rejects when an export failed; never let a Maple outage crash the app
	await provider.shutdown().catch((err) => console.error("telemetry flush failed", err))
}
```

Long-running server: no per-request flush; `process.on("SIGTERM", () => provider.shutdown().catch((err) => console.error("telemetry flush failed", err)))`.

ESM (`"type": "module"`) for top-level `await`. Run with `npx tsx main.ts` or the project's bundler/tsc; plain `node main.ts` fails on the extensionless `./tracing` import.

## Sub-agent (delegation through a tool)

```ts
// weatherWorker is an Agent like `assistant` in main.ts, with get_weather
const orchestrator: Agent = {
	name: "orchestrator",
	model: "openai/gpt-4o-mini",
	instructions: "Delegate weather questions to the weather worker.",
	tools: {
		ask_weather_worker: {
			definition: {
				type: "function",
				function: {
					name: "ask_weather_worker",
					description: "Ask the weather worker a question",
					parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
				},
			},
			// No conversationId: the sub-agent's spans are in this trace, so it inherits the session
			run: ({ question }) => runAgent(weatherWorker, [{ role: "user", content: String(question) }]),
		},
	},
}
```

## Serverless flush

```ts
// after the handler's work, before returning (inside waitUntil/after() where the platform has one)
await provider.forceFlush().catch((err) => console.error("telemetry flush failed", err))
```

