---
title: "Trace Mastra agents and workflows with OpenTelemetry"
description: "Export Mastra's built-in spans to Maple with @mastra/otel-exporter and group each conversation into one Agent Session."
group: "AI Agents"
order: 11
navLabel: "Mastra"
icon: "mastra"
---

Mastra traces every agent run, model call and tool call itself, and `@mastra/otel-exporter` sends those spans to Maple as OpenTelemetry GenAI spans. You don't need an OpenTelemetry SDK or an instrumentation package.

The session id is Mastra's memory thread id, so every call of a conversation must pass the same `memory: { thread }`. You also add a short span processor that fills in the prompt Mastra leaves off each model call.

Tested with `@mastra/core` 1.71, `@mastra/observability` 1.18 and `@mastra/otel-exporter` 1.4 on Node.js 22.13 or newer.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-mastra](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-mastra) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Mastra in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-mastra -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**.

## Install the observability packages

```bash
npm install @mastra/observability@latest @mastra/otel-exporter@latest
```

Keep `@mastra/core`, `@mastra/observability` and `@mastra/otel-exporter` on releases from the same week. With mismatched releases, the exporter can pick the wrong span as the model call.

## Add the Maple span processor

This processor fixes three gaps in what Mastra 1.71 exports. It copies each model call's prompt onto its `chat` span, gives sub-agents the conversation's thread id instead of their own, and drops the raw provider response (headers, cookies, full body) from step spans.

```ts
// src/mastra/maple-span-processor.ts
import { SpanType, type SpanOutputProcessor } from "@mastra/core/observability"

export const mapleSpanProcessor: SpanOutputProcessor = {
	name: "maple-span-processor",
	process(span) {
		if (!span) return span
		// One conversation id per trace: sub-agents get their own thread ids otherwise.
		let root = span
		while (root.parent) root = root.parent
		const threadId = root.metadata?.threadId
		if (threadId) span.metadata = { ...span.metadata, threadId }
		// The model call span is created without its prompt: take the step's messages.
		if (span.type === SpanType.MODEL_INFERENCE && span.input === undefined && span.parent?.input !== undefined) {
			span.input = { messages: span.parent.input }
		}
		// Step spans carry the raw provider response (headers, cookies, full body) as metadata.
		if (span.type === SpanType.MODEL_STEP && span.metadata) {
			const { headers: _headers, body: _body, ...metadata } = span.metadata
			span.metadata = metadata
		}
		return span
	},
	async shutdown() {},
}
```

## Configure the exporter

Add observability to your `Mastra` instance:

```ts
// src/mastra/index.ts
import { Mastra } from "@mastra/core/mastra"
import { SpanType } from "@mastra/core/observability"
import { Observability } from "@mastra/observability"
import { OtelExporter } from "@mastra/otel-exporter"
import { supportAgent } from "./agents/support"
import { mapleSpanProcessor } from "./maple-span-processor"

export const mapleExporter = new OtelExporter({
	provider: {
		custom: {
			endpoint: "https://ingest.maple.dev",
			protocol: "http/protobuf",
			headers: { Authorization: `Bearer ${process.env.MAPLE_INGEST_KEY}` },
		},
	},
	resourceAttributes: { "deployment.environment.name": "production" },
})

export const mastra = new Mastra({
	agents: { supportAgent },
	observability: new Observability({
		configs: {
			maple: {
				serviceName: "support-agent",
				exporters: [mapleExporter],
				// One span per streamed chunk adds nothing Maple uses
				excludeSpanTypes: [SpanType.MODEL_CHUNK],
				spanOutputProcessors: [mapleSpanProcessor],
			},
		},
	}),
})
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself.

The endpoint, protocol and key have to be in code. This exporter ignores the `OTEL_EXPORTER_OTLP_*` variables and defaults to `http/json`. `observability` must be an `Observability` instance, since a plain object silently installs a no-op.

Only agents and workflows registered on this `Mastra` instance are traced. Get them with `mastra.getAgent()` or `mastra.getWorkflow()`.

## Pass the thread id on every call

Maple groups traces into sessions by `gen_ai.conversation.id`, which Mastra sets from the memory thread. Pass the same thread on every call of a conversation:

```ts
const agent = mastra.getAgent("supportAgent")

export async function handleMessage(chatId: string, userId: string, text: string) {
	const result = await agent.generate(text, {
		memory: { thread: chatId, resource: userId },
	})
	return result.text
}
```

Use the chat id your app already has. It must stay the same for the whole conversation and differ between conversations. An agent that already uses `Memory` with this option needs nothing more. `agent.stream()` takes the same option; read the stream to the end, since the spans are exported when it finishes.

Workflow runs, and agents called without `memory`, have no thread. Put the id in the root span's metadata instead:

```ts
const run = await mastra.getWorkflow("briefingWorkflow").createRun()
const result = await run.start({
	inputData: { request },
	tracingOptions: { metadata: { threadId: conversationId } },
})
```

Give every `Agent` a distinct `name`, since Maple draws one lane per agent name. When a workflow step calls an agent, pass it the step's `tracingContext` (`agent.generate(prompt, { tracingContext })`) so the agent joins the workflow's trace.

## Flush in scripts and serverless functions

The exporter sends spans every 5 seconds. In a script, call `await mastra.shutdown()` in a `finally` block before exiting. In a serverless handler, call `await mastra.observability.flush()` at the end of each request, after any streamed response has finished.

## Check that it works

Run a conversation with two messages and a tool call, then open **Agent Sessions** in Maple. You should see one session named after your thread id with framework **Mastra**, one turn per `generate()` or `stream()` call, and a transcript with the prompts, replies and tool calls.

Cost shows as unpriced, because Mastra doesn't report it. If nothing arrives, set `logLevel: "debug"` on `OtelExporter` to log each export as `Export completed` or `Export FAILED` with the reason.

## Troubleshooting

- **Nothing arrives and there is no error.** `observability` is a plain object instead of `new Observability(...)`, or the agent isn't registered on the `Mastra` instance.
- **`http/protobuf exporter is not installed` at startup.** The install skipped optional dependencies. Install `@opentelemetry/exporter-trace-otlp-proto`.
- **Every message is its own session.** The call has no `memory: { thread, resource }`, or the thread id changes per request. For workflows, use `tracingOptions.metadata.threadId`.
- **The transcript has replies but no user messages, or a supervisor run lands in a session named `<thread id>-<uuid>`.** `mapleSpanProcessor` is missing from `spanOutputProcessors`.
- **A failed tool shows as successful.** The tool returned an error value. Throw an `Error` instead.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [All agent tracing guides](/docs/agent-tracing)
- [Mastra: OpenTelemetry exporter](https://mastra.ai/docs/observability/tracing/exporters/otel)
- [Mastra: tracing overview](https://mastra.ai/docs/observability/tracing/overview)
- [Trace Vercel AI SDK agents](/docs/agent-tracing/vercel-ai-sdk)
