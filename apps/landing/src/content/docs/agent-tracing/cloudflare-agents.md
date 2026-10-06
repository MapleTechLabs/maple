---
title: "Trace Cloudflare Agents with OpenTelemetry"
description: "Export the AI SDK spans of a Cloudflare Agents SDK agent from its Durable Object to Maple and group each chat into one Agent Session."
group: "AI Agents"
order: 15
navLabel: "Cloudflare Agents"
icon: "cloudflare"
---

Agents built with the Cloudflare Agents SDK (`AIChatAgent` or `Agent`) usually call models through the Vercel AI SDK, which emits the spans Maple reads. This guide sends those spans from the agent's Durable Object to Maple and passes the agent's instance name as the conversation id.

The Workers runtime can't run the Node.js OpenTelemetry SDK, so you create a small tracer provider that exports over `fetch` and flush it at the end of every turn. It works on the Workers Free and Paid plans.

You need `ai` 7.0.106 or newer and the `nodejs_compat` compatibility flag, which Agents SDK projects already have.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-cloudflare-agents](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-cloudflare-agents) skill and follows it.

```text
Set up Maple agent tracing for the Cloudflare Agents SDK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-cloudflare-agents -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the packages

```bash
npm install ai@^7.0.106 @ai-sdk/otel @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/context-async-hooks
```

What each package does:

- `ai` and `@ai-sdk/otel`: record each turn, model call and tool call.
- `@opentelemetry/sdk-trace-base`: collects those records and sends them in batches.
- `@opentelemetry/exporter-trace-otlp-http`: delivers them to Maple.
- `@opentelemetry/resources`: puts your service name on them.
- `@opentelemetry/api` and `@opentelemetry/context-async-hooks`: keep agents that a tool calls in the same conversation.

## Store the ingest key

Save the key as a secret so it isn't in your Wrangler config:

```bash
npx wrangler secret put MAPLE_INGEST_KEY
```

For `wrangler dev`, add `MAPLE_INGEST_KEY=YOUR_INGEST_KEY` to `.dev.vars`.

## Create the tracer provider

Create a `telemetry.ts`. The agent code below imports `tracerProvider` from it, which also registers the AI SDK integration:

```ts
// telemetry.ts
import { OpenTelemetry } from "@ai-sdk/otel"
import { context } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { registerTelemetry } from "ai"
import { env } from "cloudflare:workers"

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

// A missing key disables export; it never stops the Worker.
if (!env.MAPLE_INGEST_KEY) console.warn("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")

export const tracerProvider = new BasicTracerProvider({
	resource: resourceFromAttributes({
		"service.name": "support-agent",
		"deployment.environment.name": "production",
	}),
	spanProcessors: env.MAPLE_INGEST_KEY
		? [
				new BatchSpanProcessor(
					new OTLPTraceExporter({
						url: "https://ingest.maple.dev/v1/traces", // EU: https://ingest.eu.maple.dev/v1/traces
						headers: { authorization: `Bearer ${env.MAPLE_INGEST_KEY}` },
					}),
				),
			]
		: [],
})

registerTelemetry(
	new OpenTelemetry({
		tracer: tracerProvider.getTracer("gen_ai"),
		usage: true,
		runtimeContext: true,
	}),
)
```

The context manager keeps sub-agents called from a tool inside the same trace.

## Pass the conversation id and flush each turn

Each chat is one instance of your agent, so its instance name (`this.name`) is the conversation id. Pass it on every AI SDK call, and flush the tracer provider when the turn ends. A Durable Object can be evicted between messages, and spans still in the buffer are lost with it.

In an `AIChatAgent`, flush in `onChatResponse`, which runs after every turn:

```ts
// server.ts
import { AIChatAgent } from "@cloudflare/ai-chat"
import { convertToModelMessages, streamText } from "ai"
import { tracerProvider } from "./telemetry"

export class ChatAgent extends AIChatAgent<Env> {
	async onChatMessage() {
		const result = streamText({
			model,
			messages: await convertToModelMessages(this.messages),
			tools,
			runtimeContext: { conversationId: this.name },
			telemetry: { functionId: "support_agent", includeRuntimeContext: { conversationId: true } },
		})
		return result.toUIMessageStreamResponse()
	}

	async onChatResponse() {
		await tracerProvider.forceFlush()
	}
}
```

In a plain `Agent`, flush when the method that called the model returns:

```ts
import { Agent } from "agents"
import { generateText } from "ai"
import { tracerProvider } from "./telemetry"

export class TaskAgent extends Agent<Env> {
	async onRequest(request: Request) {
		const { prompt } = await request.json<{ prompt: string }>()
		try {
			const result = await generateText({
				model,
				prompt,
				tools,
				runtimeContext: { conversationId: this.name },
				telemetry: { functionId: "task_agent", includeRuntimeContext: { conversationId: true } },
			})
			return Response.json({ text: result.text })
		} finally {
			this.ctx.waitUntil(tracerProvider.forceFlush())
		}
	}
}
```

If the method returns a `streamText` stream instead, flush once the stream has been read, with `this.ctx.waitUntil(result.consumeStream().then(() => tracerProvider.forceFlush()))` before returning the response.

Give each chat its own instance: on the client, pass a chat id as `name` to `useAgent({ agent: "ChatAgent", name: chatId })`. Without a `name`, every client connects to the `default` instance and all chats land in one session. `functionId` becomes the agent name in Maple, so give each agent a distinct one.

To keep a call's prompts and replies out of Maple, set `recordInputs: false` and `recordOutputs: false` in its `telemetry`.

## Check that it works

Run `wrangler dev`, send two messages in one chat that trigger a tool call, then open **Agent Sessions** in Maple. You should see one session named after the agent instance with framework **Vercel AI SDK**, one turn per message, and a transcript with the prompts, replies and tool calls. A second chat should show up as a second session.

## Troubleshooting

- **No AI spans at all.** Nothing imports `telemetry.ts`, or the `MAPLE_INGEST_KEY` secret isn't set (`npx wrangler secret list`).
- **Turns are missing or arrive late.** The flush isn't running. Check that `onChatResponse` (or your `finally` block) calls `forceFlush()`.
- **All chats are one session.** The client connects without a `name`, so every chat uses the `default` instance.
- **A sub-agent shows up as its own session.** The context manager isn't registered. Keep the `setGlobalContextManager` line in `telemetry.ts`.
- **Every span shows up twice.** `registerTelemetry()` ran twice, for example from two entry points that both set it up.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Vercel AI SDK guide](/docs/agent-tracing/vercel-ai-sdk)
- [Cloudflare Workers instrumentation](/docs/guides/instrumentation-cloudflare-workers) for request and binding spans
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
