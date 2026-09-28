---
title: "Trace Vercel AI SDK agents with OpenTelemetry"
description: "Send the AI SDK's OpenTelemetry spans to Maple so each chat conversation is one Agent Session with its transcript, tool calls, sub-agents and tokens, in Node.js or Next.js."
group: "AI Agents"
order: 10
navLabel: "Vercel AI SDK"
icon: "vercel"
---

The Vercel AI SDK traces itself. Every `generateText`, `streamText` and `ToolLoopAgent` call emits an `invoke_agent` span, a `chat` span per model request with the prompt, the reply and the token counts, and an `execute_tool` span per tool call with its arguments and result. The spans follow the OpenTelemetry GenAI semantic conventions, prompts and replies are recorded by default, and Maple reads all of it without an extra instrumentation package.

Two things go wrong by default. In AI SDK 7, nothing is traced until you call `registerTelemetry()` once at startup: without it the SDK emits zero spans, with no warning. And the AI SDK has no conversation id. Each call is its own trace with nothing linking it to the previous message, so a chat backend that handles one message per request shows up in Maple as one session per message. This guide fixes both.

It covers AI SDK 7 (`ai` 7.0.106 or newer) on Node.js 22 or newer, in a plain Node.js service and in Next.js. It was tested with `ai` 7.0.118, `@ai-sdk/otel` 1.0.118, OpenTelemetry JS 0.222.0 and `@openrouter/ai-sdk-provider` 3.1.0 on Node.js 26. The Next.js setup uses `@vercel/otel` 2.1.3. AI SDK 5 and 6 work too, with less detail in the transcript; see [AI SDK 5 and 6](#ai-sdk-5-and-6).

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-vercel-ai-sdk](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-vercel-ai-sdk) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for the Vercel AI SDK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-vercel-ai-sdk -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Export AI SDK spans to Maple

In AI SDK 7, OpenTelemetry support moved out of the `ai` package into `@ai-sdk/otel`. It creates spans; the OpenTelemetry SDK exports them. Install both:

```bash
npm install ai@^7.0.106 @ai-sdk/otel @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto @opentelemetry/resources
```

Point the exporter at Maple with the standard OpenTelemetry variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself.

Then set up tracing once, when your process starts:

```ts
// instrumentation.ts
import { OpenTelemetry } from "@ai-sdk/otel"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { registerTelemetry } from "ai"

// Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
export const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter())

export const sdk = new NodeSDK({
	resource: resourceFromAttributes({
		"service.name": "support-agent",
		"deployment.environment.name": process.env.NODE_ENV ?? "development",
	}),
	spanProcessors: [spanProcessor],
})
sdk.start()

registerTelemetry(
	new OpenTelemetry({
		usage: true,
		runtimeContext: true,
		// The conversation id, explained in the next section
		enrichSpan: ({ runtimeContext }) =>
			typeof runtimeContext?.conversationId === "string"
				? { "gen_ai.conversation.id": runtimeContext.conversationId }
				: undefined,
	}),
)
```

Import it as the first line of your entry point (`import "./instrumentation"`). The AI SDK doesn't patch any modules, so what matters is that `registerTelemetry()` runs before the first AI SDK call. Call it exactly once: it appends to a global list, and every registered `OpenTelemetry` instance emits its own copy of every span.

`usage: true` and `runtimeContext: true` add a few AI SDK-specific `ai.*` attributes next to the GenAI ones: the uncached and text token counts, and the conversation id you pass in. Maple identifies AI SDK spans by those `ai.*` keys on the `gen_ai` tracer. Without them, the `invoke_agent` and `chat` spans read as generic GenAI spans, the session's framework shows as **Unidentified**, and time to first token isn't picked up.

If your app already starts an OpenTelemetry SDK (auto-instrumentation, Sentry, your own `NodeTracerProvider`), don't start a second one. Add the `BatchSpanProcessor` above to the existing provider and keep the `registerTelemetry()` call. `@ai-sdk/otel` uses the global tracer provider. Don't pass it a `tracer` from another tracer name either: Maple expects the default `gen_ai` scope.

### Next.js

Next.js calls `register()` in `instrumentation.ts` once per server runtime. Use `@vercel/otel` there, as in the [Next.js guide](/docs/guides/instrumentation-nextjs), and register the AI SDK integration next to it:

```ts
// instrumentation.ts (project root, or src/instrumentation.ts)
import { OpenTelemetry } from "@ai-sdk/otel"
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel"
import { registerTelemetry } from "ai"

export function register() {
	registerOTel({
		serviceName: "support-chat",
		traceExporter: new OTLPHttpProtoTraceExporter({
			url: "https://ingest.maple.dev/v1/traces", // EU: https://ingest.eu.maple.dev/v1/traces
			headers: { authorization: `Bearer ${process.env.MAPLE_INGEST_KEY}` },
		}),
	})

	registerTelemetry(
		new OpenTelemetry({
			usage: true,
			runtimeContext: true,
			enrichSpan: ({ runtimeContext }) =>
				typeof runtimeContext?.conversationId === "string"
					? { "gen_ai.conversation.id": runtimeContext.conversationId }
					: undefined,
		}),
	)
}
```

The AI SDK spans then nest under the request span Next.js creates for the route handler, like `POST /api/chat`.

`@vercel/otel` ends every span of a trace that is still open when the trace's root span ends. AI SDK work that keeps running after the request span has ended, such as a stream read inside `after()`, loses the end of its spans: the reply and the token counts. Read the stream inside the request, for example by returning it as the response with `toUIMessageStreamResponse()` or `createAgentUIStreamResponse()`.

## Group every turn of a conversation into one session

Maple groups traces into sessions by `gen_ai.conversation.id`. The AI SDK never sets it: there is no session or thread concept in `generateText`, and `ToolLoopAgent` doesn't keep one either. What it does have is `runtimeContext`, a per-call object your code passes in. The `enrichSpan` callback above copies `runtimeContext.conversationId` onto every span as `gen_ai.conversation.id`.

Runtime context stays out of telemetry unless you list the key in `telemetry.includeRuntimeContext`, so each call needs both:

```ts
import { streamText } from "ai"

const result = streamText({
	model,
	messages,
	runtimeContext: { conversationId: chatId },
	telemetry: {
		functionId: "support_agent",
		includeRuntimeContext: { conversationId: true },
	},
})
```

Use the chat or thread id your app already stores. It must be stable for the whole conversation and different between conversations. A per-process constant merges every user into one session.

If you skip this, each request shows up in **Agent Sessions** as its own one-turn session named `trace:<trace id>`.

### ToolLoopAgent

`agent.generate()` and `agent.stream()` don't take `runtimeContext` per call. Declare the id as a call option and turn it into runtime context in `prepareCall`:

```ts
// agent.ts
import { openai } from "@ai-sdk/openai"
import { ToolLoopAgent } from "ai"
import { z } from "zod"

export const assistant = new ToolLoopAgent({
	model: openai("gpt-4o-mini"),
	instructions: "You are a helpful assistant.",
	tools: { get_weather: getWeather, fetch_transport_data: fetchTransportData },
	callOptionsSchema: z.object({ conversationId: z.string() }),
	prepareCall: ({ options, ...rest }) => ({
		...rest,
		runtimeContext: { conversationId: options.conversationId },
	}),
	telemetry: {
		functionId: "support_agent",
		includeRuntimeContext: { conversationId: true },
	},
})

const result = await assistant.generate({ messages, options: { conversationId: chatId } })
```

`functionId` becomes `gen_ai.agent.name`. The agent's `id` isn't exported to telemetry, so set `functionId` on every agent you want to see by name.

### Chat routes with useChat

`useChat` already sends a stable chat id with every request, as `id` in the JSON body. Pass it through:

```ts
// app/api/chat/route.ts
import { createAgentUIStreamResponse, type UIMessage } from "ai"
import { assistant } from "@/agent"

export async function POST(req: Request) {
	const { id, messages }: { id: string; messages: UIMessage[] } = await req.json()

	return createAgentUIStreamResponse({
		agent: assistant,
		uiMessages: messages,
		options: { conversationId: id },
	})
}
```

With `streamText` directly, pass `runtimeContext: { conversationId: id }` as in the first example and return `result.toUIMessageStreamResponse()`.

Tool approvals work the same way. In AI SDK 7 you mark a tool with `toolApproval: { delete_file: "user-approval" }` on the call or the agent (`needsApproval` on the tool is deprecated). The call then ends with a `tool-approval-request`, and resuming after the user answers is a new `generate()` or `stream()` call, so a new trace. Pass the same conversation id to both and they land in the same session as consecutive turns: one approval shows as two turns, the one that asked and the one that ran the tool. The approved `execute_tool` span sits directly under `invoke_agent`, not under a `step`, because the tool runs before the resumed call's first step.

## Record prompts, responses and tool calls

Content capture is on by default. With the setup above:

- `invoke_agent` spans carry the call's `gen_ai.system_instructions`, `gen_ai.input.messages` and `gen_ai.output.messages`;
- each `chat` span carries the messages sent to the model and its reply, plus `gen_ai.tool.definitions`;
- each `execute_tool` span carries `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`.

All of it is JSON in the GenAI message format, which Maple renders as the transcript.

To keep content out of Maple, turn it off per call or per agent:

```ts
telemetry: {
	functionId: "billing_agent",
	recordInputs: false, // no prompts, system instructions, tool definitions or tool arguments
	recordOutputs: false, // no replies or tool results
},
```

Sessions keep their turns, models, tool names, tokens and errors, but the transcript is empty. `telemetry: { isEnabled: false }` drops the call's spans entirely.

Two more things to know:

- **Files and images are recorded inline.** An image or PDF in the messages is written as base64 into the `chat` span, and every later step of the loop repeats the history. Keep attachments out of traced calls or set `recordInputs: false` on them.
- **Content is not redacted.** Anything a user types reaches Maple. For pattern-based redaction, run an OpenTelemetry Collector between your app and Maple, or turn recording off for the calls that handle sensitive data.

`runtimeContext` values are only exported when listed in `includeRuntimeContext`, so user ids, tokens or tenant data you keep there for your tools stay out of the spans.

## Tools, errors and sub-agents

Every tool call is an `execute_tool <tool name>` span with `gen_ai.tool.name`, the model's `gen_ai.tool.call.id`, and the arguments and result. Maple matches each call to the model reply that requested it by that id.

When a tool's `execute` throws, the AI SDK marks the span ERROR with the error message as the status message, records an `exception` event, and passes the error back to the model as a `tool-error` result. The loop continues, and Maple counts the call as failed:

```ts
import { tool } from "ai"
import { z } from "zod"

const fetchTransportData = tool({
	description: "Fetch live public-transport data for a city",
	inputSchema: z.object({ city: z.string() }),
	execute: async ({ city }): Promise<string> => {
		throw new Error(`transport data service unavailable (503) for ${city}`)
	},
})
```

A tool that returns an error value (`return { error: "..." }`) keeps the span green, and Maple counts the call as a success. Throw instead.

The explicit `Promise<string>` return type matters in TypeScript: without it, an `execute` that always throws infers `never` and the tool fails to typecheck.

### Sub-agents

The common multi-agent pattern is agents as tools: the orchestrator has a tool whose `execute` runs another agent. The worker's spans nest under that tool span in the same trace:

```ts
const weatherWorker = new ToolLoopAgent({
	model: openai("gpt-4o-mini"),
	tools: { get_weather: getWeather },
	telemetry: { functionId: "weather_worker" },
})

export const orchestrator = new ToolLoopAgent({
	model: openai("gpt-4o-mini"),
	tools: {
		delegate_weather: tool({
			description: "Ask the weather worker",
			inputSchema: z.object({ task: z.string() }),
			execute: async ({ task }) => (await weatherWorker.generate({ prompt: task })).text,
		}),
	},
	callOptionsSchema: z.object({ conversationId: z.string() }),
	prepareCall: ({ options, ...rest }) => ({
		...rest,
		runtimeContext: { conversationId: options.conversationId },
	}),
	telemetry: { functionId: "orchestrator", includeRuntimeContext: { conversationId: true } },
})
```

The worker doesn't need the conversation id: Maple needs it on one span per trace, and the orchestrator's spans have it. It does need its own `functionId`. Maple draws a lane per `gen_ai.agent.name`, and an `execute_tool delegate_weather` span whose only child is `invoke_agent` for `weather_worker` shows as a delegation, with the tool's arguments and result as the lane's input and output. When the model asks for several delegate tools in one reply, the AI SDK runs them concurrently and the lanes overlap in time.

A pipeline of separate top-level calls (an orchestrator, then a summary agent) produces one trace per call. Pass the same conversation id to each, and they land in one session as consecutive turns.

## Tokens and cost

Each `chat` span carries `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens` when the provider reports caching. With `usage: true`, reasoning tokens are added as `ai.usage.outputTokenDetails.reasoningTokens`. Maple reads all of them.

The `invoke_agent` span repeats the call's total. Maple counts each model call once: a span's usage is netted against the usage its descendants already reported, so the total isn't doubled, and a sub-agent's tokens stay on the sub-agent's spans.

Streaming needs nothing extra. The AI SDK normalizes provider usage, so `streamText` and `agent.stream()` calls have token counts too, and the streamed `chat` span records time to first chunk, which Maple shows as TTFT.

Cost shows as unpriced. The AI SDK doesn't price calls, and Maple never prices tokens itself. Tokens, models and call counts are complete. If your model calls go through OpenRouter, its [Broadcast traces](/docs/agent-tracing/openrouter) carry the cost of each call, and Maple matches them to the AI SDK's `chat` spans by response id.

## Short-lived processes

`BatchSpanProcessor` exports every few seconds. A script, a CLI or a serverless function can end before that. Flush before exiting:

```ts
import { sdk } from "./instrumentation"

try {
	await runConversation()
} finally {
	await sdk.shutdown() // flushes, then stops the SDK
}
```

In a serverless handler that is reused between invocations, flush without stopping the SDK:

```ts
import { spanProcessor } from "./instrumentation"

export async function handler(event: { chatId: string; text: string }) {
	try {
		return await turn(event.chatId, event.text)
	} finally {
		await spanProcessor.forceFlush()
	}
}
```

Streaming matters here. The `invoke_agent` span ends when the stream is fully read, not when `streamText` returns. In a script, read the stream to the end (`for await (const chunk of result.textStream)` or `await result.consumeStream()`) before flushing. A stream nobody reads never ends its spans, and they are never exported.

On Vercel, `@vercel/otel` flushes at the end of each request through `waitUntil`. Work that runs outside a request, such as a queue consumer, a cron job or a workflow step, doesn't get that flush. Call `forceFlush()` on your span processor at the end of each unit of work there.

## AI SDK 5 and 6

Before AI SDK 7, OpenTelemetry was built into the `ai` package and off by default. Turn it on per call with `experimental_telemetry`, and pass the conversation id as metadata:

```ts
const result = await generateText({
	model,
	messages,
	experimental_telemetry: {
		isEnabled: true,
		functionId: "support_agent",
		metadata: { conversationId: chatId },
	},
})
```

Those versions emit the older span format: `ai.generateText` or `ai.streamText` for the call, `ai.generateText.doGenerate` or `ai.streamText.doStream` for each model request, and `ai.toolCall` for each tool call. The metadata lands as `ai.telemetry.metadata.conversationId`, which Maple doesn't read, so copy it to `gen_ai.conversation.id` with a span processor:

```ts
import type { Context } from "@opentelemetry/api"
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base"

export class ConversationIdProcessor implements SpanProcessor {
	onStart(span: Span, _parentContext: Context) {
		const id = span.attributes["ai.telemetry.metadata.conversationId"]
		if (typeof id === "string") span.setAttribute("gen_ai.conversation.id", id)
	}
	onEnd(_span: ReadableSpan) {}
	forceFlush() {
		return Promise.resolve()
	}
	shutdown() {
		return Promise.resolve()
	}
}
```

Add it before the exporting processor: `spanProcessors: [new ConversationIdProcessor(), spanProcessor]`.

Maple reads the old format's models, tokens, prompts and tool calls. The assistant's reply is only recorded as plain text (`ai.response.text`), which Maple doesn't render, so transcripts show the user and tool messages without the final answer. Upgrading to AI SDK 7 fixes that. The `npx @ai-sdk/codemod v7` migration renames `experimental_telemetry` to `telemetry`, but you still need to install `@ai-sdk/otel`, call `registerTelemetry()`, and move the id from `metadata` (gone in AI SDK 7) to `runtimeContext` yourself. Drop the span processor once you have.

## Check that it works

Run one conversation with at least two messages and a tool call, then open **Agent Sessions** in Maple. Spans take a few seconds to arrive. You should see:

- one session per conversation, with the id you passed as `conversationId`, and framework **Vercel AI SDK**;
- one turn per `generate()` or `stream()` call, each labeled with the user's message, and a transcript with the prompts, replies and tool calls;
- per turn, an `invoke_agent <model id>` span, a `step <n>` span per loop iteration, a `chat <model id>` span per model request and an `execute_tool <tool name>` span per tool call;
- the agent name from `functionId` in the agent filter, and a lane per sub-agent;
- token counts on every model call, including streamed ones, and TTFT on streamed calls;
- failed tool calls marked as failed, with the error message;
- cost shown as unpriced.

Span names carry the model id, not the agent name, so two agents on the same model have identically named `invoke_agent` spans. The agent name is on the span as `gen_ai.agent.name`.

## Troubleshooting

- **No AI spans at all.** `registerTelemetry()` was never called, or ran in a module that isn't loaded. AI SDK 7 emits nothing without it, and `experimental_telemetry: { isEnabled: true }` alone does nothing. Import `@ai-sdk/otel` and register `new OpenTelemetry()` at startup.
- **Every message is its own session.** No `gen_ai.conversation.id` on the spans. Check all three parts: `enrichSpan` on the integration, `runtimeContext: { conversationId }` on the call (or `prepareCall` for an agent), and `includeRuntimeContext: { conversationId: true }`. Without the last one, `enrichSpan` receives an empty object.
- **Sessions show framework "Unidentified".** The spans carry no `ai.*` attributes. Set `usage: true` and `runtimeContext: true` on `new OpenTelemetry()`, and don't pass a custom `tracer` with another name.
- **Every span shows up twice.** `registerTelemetry()` ran twice, both `OpenTelemetry` and `LegacyOpenTelemetry` are registered, or a second OpenTelemetry SDK exports the same spans (Sentry without `skipOpenTelemetrySetup: true` next to `@vercel/otel`, for example). Register one integration and one exporter.
- **One call has no spans while others do.** It passes `telemetry.integrations`, which replaces the globally registered integrations for that call. Add the `OpenTelemetry` instance to that list, or remove the option.
- **Nothing arrives from a script or function.** The process ended before the batch was exported. Call `sdk.shutdown()` or `spanProcessor.forceFlush()` in a `finally`.
- **A streamed turn is missing, or its spans have no tokens.** The stream was never read to the end, so its spans never ended. Consume the stream before flushing. Before `ai` 7.0.106, a provider error in the middle of a stream also left the spans open; upgrade.
- **Sub-agents share one lane, or have none.** The worker agents have no `functionId`. Set a distinct one on each.
- **A failed tool shows as successful.** The tool returned an error value. Throw from `execute`.
- **Spans arrive with no prompts or replies.** `recordInputs: false` or `recordOutputs: false` is set on that call or agent.
- **Exports fail with 413.** Images or documents in the messages are recorded as base64 on every step. Keep them out of traced calls or set `recordInputs: false` there.
- **Transcripts end at the tool results, with no final answer.** You are on AI SDK 5 or 6, which records the reply as plain text. Upgrade to AI SDK 7.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [All agent tracing guides](/docs/agent-tracing)
- [AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
- [Next.js instrumentation](/docs/guides/instrumentation-nextjs)
- [Node.js instrumentation](/docs/guides/instrumentation-nodejs)
- [OpenRouter Broadcast](/docs/agent-tracing/openrouter)
