---
title: "Trace Vercel AI SDK agents with OpenTelemetry"
description: "Send the Vercel AI SDK's OpenTelemetry spans to Maple and group each chat into one Agent Session."
group: "AI Agents"
order: 10
navLabel: "Vercel AI SDK"
icon: "vercel"
---

The Vercel AI SDK emits OpenTelemetry GenAI spans for every `generateText`, `streamText` and `ToolLoopAgent` call, with the prompts, replies, tool calls and token counts. Maple reads them without an extra instrumentation package.

You have to get two things right. In AI SDK 7 nothing is traced until you call `registerTelemetry()` at startup, and the SDK has no conversation id, so you pass one on every call or each message becomes its own session.

Tested with `ai` 7.0.118, `@ai-sdk/otel` 1.0.118, OpenTelemetry JS 0.222.0 and `@vercel/otel` 2.1.3 on Node.js 26 and Bun 1.3. You need `ai` 7.0.106 or newer and Node.js 22 or newer. On AI SDK 5 or 6, run `npx @ai-sdk/codemod v7` first; the skill has a fallback setup if you can't upgrade.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-vercel-ai-sdk](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-vercel-ai-sdk) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for the Vercel AI SDK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-vercel-ai-sdk -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**.

## Install the packages

```bash
npm install ai@^7.0.106 @ai-sdk/otel @opentelemetry/sdk-node
```

## Point the exporter at Maple

```bash
export OTEL_SERVICE_NAME="support-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself.

## Register the AI SDK integration

Create an `instrumentation.ts` and import it as the first line of your entry point (`import "./instrumentation"`):

```ts
// instrumentation.ts
import { OpenTelemetry } from "@ai-sdk/otel"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { registerTelemetry } from "ai"

// Reads OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_*
export const sdk = new NodeSDK()
sdk.start()

registerTelemetry(
	new OpenTelemetry({
		usage: true,
		runtimeContext: true,
		// The conversation id, explained below
		enrichSpan: ({ runtimeContext }) =>
			typeof runtimeContext?.conversationId === "string"
				? { "gen_ai.conversation.id": runtimeContext.conversationId }
				: undefined,
	}),
)
```

Call `registerTelemetry()` exactly once. Each call adds another integration, and each one emits its own copy of every span. Keep `usage: true` and `runtimeContext: true`: Maple uses the `ai.*` attributes they add to recognize AI SDK spans.

### Serverless, or an app that already uses OpenTelemetry

Two setups need a handle on the span processor: a serverless handler that flushes after every invocation, and an app that already starts its own OpenTelemetry SDK (auto-instrumentation, Sentry, your own `NodeTracerProvider`), where you shouldn't start a second one. Install the exporter packages and create the processor yourself:

```bash
npm install @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto
```

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"

export const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter())
```

Pass it as `new NodeSDK({ spanProcessors: [spanProcessor] })`, or add it to your existing provider instead of creating a `NodeSDK`. Keep the `registerTelemetry()` call either way.

### Next.js

In Next.js, register both in the `register()` function of `instrumentation.ts`, using `@vercel/otel` as in the [Next.js guide](/docs/guides/instrumentation-nextjs):

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

Return AI SDK streams as the response (`toUIMessageStreamResponse()` or `createAgentUIStreamResponse()`). `@vercel/otel` ends all open spans when the request ends, so a stream read later, for example in `after()`, loses its reply and token counts.

## Pass the conversation id on every call

Maple groups traces into sessions by `gen_ai.conversation.id`. The `enrichSpan` callback above copies it from `runtimeContext.conversationId`, which only reaches telemetry if you also list it in `includeRuntimeContext`:

```ts
import { streamText } from "ai"

const result = streamText({
	model,
	messages,
	runtimeContext: { conversationId: chatId },
	telemetry: { functionId: "support_agent", includeRuntimeContext: { conversationId: true } },
})
```

Use the chat or thread id your app already stores. It must stay the same for the whole conversation and differ between conversations. `functionId` becomes the agent name in Maple, so give each agent a distinct one.

`ToolLoopAgent` doesn't take `runtimeContext` per call. Declare the id as a call option and turn it into runtime context in `prepareCall`:

```ts
// agent.ts
import { ToolLoopAgent } from "ai"
import { z } from "zod"

export const assistant = new ToolLoopAgent({
	// ...model, instructions, tools
	callOptionsSchema: z.object({ conversationId: z.string() }),
	prepareCall: ({ options, ...rest }) => ({
		...rest,
		runtimeContext: { conversationId: options.conversationId },
	}),
	telemetry: { functionId: "support_agent", includeRuntimeContext: { conversationId: true } },
})

const result = await assistant.generate({ messages, options: { conversationId: chatId } })
```

With `useChat`, the request body already carries a stable chat id as `id`. Pass it through:

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

Sub-agents called from a tool's `execute` run inside the caller's trace, so they don't need the id. They do need their own `functionId` to get their own lane.

Prompts and replies are recorded by default. To keep them out of Maple for a call or agent, set `recordInputs: false` and `recordOutputs: false` in its `telemetry`.

## Flush in scripts and serverless functions

The SDK exports spans in batches every few seconds, so a short-lived process can exit first. In a script, call `await sdk.shutdown()` in a `finally` block before exiting. In a serverless handler that is reused between invocations, call `await spanProcessor.forceFlush()` in a `finally` instead (see [the variant above](#serverless-or-an-app-that-already-uses-opentelemetry)), so the SDK keeps running.

Read streams to the end (`await result.consumeStream()`) before flushing: a stream's spans only end when it has been read. On Vercel, `@vercel/otel` flushes after each request, but queue consumers and cron jobs need their own `forceFlush()`.

## Check that it works

Run a conversation with two messages and a tool call, then open **Agent Sessions** in Maple. You should see one session named after your conversation id with framework **Vercel AI SDK**, one turn per call, and a transcript with the prompts, replies and tool calls.

Two things look off but are expected. Cost shows as unpriced, because the AI SDK doesn't report it. The session's token total is currently twice what the model calls used; the per-model breakdown on the session page is correct.

## Troubleshooting

- **No AI spans at all.** `registerTelemetry()` never ran. `experimental_telemetry: { isEnabled: true }` alone does nothing in AI SDK 7.
- **Every message is its own session.** Check all three parts: `enrichSpan`, `runtimeContext: { conversationId }` on the call (or `prepareCall`), and `includeRuntimeContext: { conversationId: true }`.
- **Framework shows "Unidentified".** Set `usage: true` and `runtimeContext: true` on `new OpenTelemetry()`.
- **Every span shows up twice.** `registerTelemetry()` ran twice, or a second OpenTelemetry SDK (such as Sentry without `skipOpenTelemetrySetup: true`) exports the same spans.
- **A failed tool shows as successful.** The tool returned an error value. Throw from `execute` instead.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [All agent tracing guides](/docs/agent-tracing)
- [AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
- [Next.js instrumentation](/docs/guides/instrumentation-nextjs)
- [Node.js instrumentation](/docs/guides/instrumentation-nodejs)
- [OpenRouter Broadcast](/docs/agent-tracing/openrouter)
