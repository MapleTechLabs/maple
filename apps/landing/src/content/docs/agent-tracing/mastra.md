---
title: "Trace Mastra agents and workflows with OpenTelemetry"
description: "Export Mastra's built-in spans to Maple with @mastra/otel-exporter and group each conversation into one Agent Session."
group: "AI Agents"
order: 11
navLabel: "Mastra"
icon: "mastra"
---

Mastra traces agent runs, model calls and tool calls itself, and `@mastra/otel-exporter` sends those spans to Maple. You don't need an OpenTelemetry SDK or an instrumentation package.

The session id is Mastra's memory thread id, so every call of a conversation must pass the same `memory: { thread }`.

You need `@mastra/core` 1.x and Node.js 22.13 or newer.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-mastra](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-mastra) skill and follows it.

```text
Set up Maple agent tracing for Mastra in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-mastra -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the observability packages

```bash
npm install @mastra/core@latest @mastra/observability@latest @mastra/otel-exporter@latest
```

Keep `@mastra/core`, `@mastra/observability` and `@mastra/otel-exporter` on releases from the same week, or the exporter can pick the wrong span as the model call.

## Add the Maple span processor

Without this processor the transcript has no user messages, sub-agents land in separate sessions, and raw provider responses (including cookies) are exported.

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

// A missing key disables export; it never stops the app.
const mapleKey = process.env.MAPLE_INGEST_KEY
if (!mapleKey) console.warn("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")

const mapleExporter = mapleKey
	? new OtelExporter({
			provider: {
				custom: {
					endpoint: "https://ingest.maple.dev",
					protocol: "http/protobuf",
					headers: { Authorization: `Bearer ${mapleKey}` },
				},
			},
			resourceAttributes: { "deployment.environment.name": "production" },
		})
	: undefined

export const mastra = new Mastra({
	agents: { supportAgent },
	observability: new Observability({
		configs: {
			maple: {
				serviceName: "support-agent",
				exporters: mapleExporter ? [mapleExporter] : [],
				// One span per streamed chunk adds nothing Maple uses
				excludeSpanTypes: [SpanType.MODEL_CHUNK],
				spanOutputProcessors: [mapleSpanProcessor],
			},
		},
	}),
})
```

Set `MAPLE_INGEST_KEY` to your ingest key from **Settings → Ingestion**. For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself.

Set the endpoint, protocol and key in code, since this exporter ignores the `OTEL_EXPORTER_OTLP_*` variables. `observability` must be an `Observability` instance; a plain object silently traces nothing.

Only agents and workflows registered on this `Mastra` instance are traced. Get them with `mastra.getAgent()` or `mastra.getWorkflow()`.

## Pass the thread id on every call

Pass the same thread on every call of a conversation:

```ts
const agent = mastra.getAgent("supportAgent")

export async function handleMessage(chatId: string, userId: string, text: string) {
	const result = await agent.generate(text, {
		memory: { thread: chatId, resource: userId },
	})
	return result.text
}
```

Use the chat id your app already has. It must stay the same for the whole conversation and differ between conversations. `agent.stream()` takes the same option; read the stream to the end, since the spans are exported when it finishes.

Workflow runs, and agents called without `memory`, have no thread. Put the id in the root span's metadata instead:

```ts
const run = await mastra.getWorkflow("briefingWorkflow").createRun()
const result = await run.start({
	inputData: { request },
	tracingOptions: { metadata: { threadId: conversationId } },
})
```

Give every `Agent` a distinct `name`, or sub-agents share one lane. When a workflow step calls an agent, pass it the step's `tracingContext` (`agent.generate(prompt, { tracingContext })`) so the agent joins the workflow's trace.

## Flush in scripts and serverless functions

A short-lived process can exit before its spans are sent. In a script, call `await mastra.shutdown()` in a `finally` block before exiting. In a serverless handler, call `await mastra.observability.flush()` at the end of each request, after any streamed response has finished.

## Check that it works

Run a conversation with two messages and a tool call, then open **Agent Sessions** in Maple. You should see one session named after your thread id with framework **Mastra**, one turn per `generate()` or `stream()` call, and a transcript with the prompts, replies and tool calls.

Cost shows as unpriced because Mastra doesn't report it. If nothing arrives, set `logLevel: "debug"` on `OtelExporter` to log each export as `Export completed` or `Export FAILED` with the reason.

## Troubleshooting

- **Nothing arrives and there is no error.** `observability` is a plain object instead of `new Observability(...)`, or the agent isn't registered on the `Mastra` instance.
- **`http/protobuf exporter is not installed` at startup.** The install skipped optional dependencies. Install `@opentelemetry/exporter-trace-otlp-proto`.
- **Every message is its own session.** The call has no `memory: { thread, resource }`, or the thread id changes per request. For workflows, use `tracingOptions.metadata.threadId`.
- **The transcript has no user messages, or sub-agents land in a session named `<thread id>-<uuid>`.** Add `mapleSpanProcessor` to `spanOutputProcessors`.
- **A failed tool shows as successful.** The tool returned an error value. Throw an `Error` instead.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Mastra: OpenTelemetry exporter](https://mastra.ai/docs/observability/tracing/exporters/otel)
