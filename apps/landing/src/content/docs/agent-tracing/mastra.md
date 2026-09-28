---
title: "Trace Mastra agents and workflows with OpenTelemetry"
description: "Export Mastra's built-in GenAI spans to Maple with @mastra/otel-exporter so each conversation is one Agent Session with its transcript, tool calls, sub-agents and tokens."
group: "AI Agents"
order: 11
navLabel: "Mastra"
icon: "mastra"
---

Mastra traces itself. Every `agent.generate()` or `agent.stream()` produces an `invoke_agent` span, a `chat` span per model call with the prompt, the reply and the token counts, and an `execute_tool` span per tool call with its arguments and result. The `@mastra/otel-exporter` package turns those spans into OpenTelemetry GenAI spans (semantic conventions v1.38) and sends them to any OTLP endpoint, including Maple. You don't need an OpenTelemetry SDK or an instrumentation package.

Two things go wrong by default. The exporter ignores the standard `OTEL_EXPORTER_OTLP_*` variables and falls back to OTLP/JSON, so a setup copied from another guide exports nothing and logs a single warning. And the conversation id Maple groups by is Mastra's memory thread id: an agent called without `memory: { thread, resource }` sends no id at all, so every message becomes its own session.

This guide covers Mastra 1.x on Node.js 22.13 or newer. It was written against `@mastra/core` 1.71, `@mastra/observability` 1.18 and `@mastra/otel-exporter` 1.4.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-mastra](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-mastra) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Mastra in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-mastra -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Export Mastra spans to Maple

Install the observability packages next to `@mastra/core`, plus the OTLP/protobuf trace exporter:

```bash
npm install @mastra/observability@latest @mastra/otel-exporter@latest @opentelemetry/exporter-trace-otlp-proto
```

Keep `@mastra/core`, `@mastra/observability` and `@mastra/otel-exporter` on releases from the same week. The exporter decides which span is the model call from features both packages report, and a stale `@mastra/observability` can leave you with spans but no model calls.

Then configure observability on your `Mastra` instance:

```ts
// src/mastra/index.ts
import { Mastra } from "@mastra/core/mastra"
import { SpanType } from "@mastra/core/observability"
import { Observability } from "@mastra/observability"
import { OtelExporter } from "@mastra/otel-exporter"
import { supportAgent } from "./agents/support"

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
			},
		},
	}),
})
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself, and strips it if you include it, so both forms work.

Three details in this block are load-bearing:

- `observability` must be an `Observability` instance. A plain `{ configs: ... }` object logs a warning and installs a no-op, so nothing is exported.
- `protocol: "http/protobuf"` must be explicit. The `custom` provider defaults to `http/json`, and each protocol loads a different exporter package; if that package is missing, tracing is disabled with one error line at startup.
- The endpoint and key go in code. `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` are not read by this exporter. The `headers` object is sent as is, so there is no `%20` encoding to get wrong.

Only agents and workflows registered on this `Mastra` instance, or called with a `tracingContext` from one, are traced. An `Agent` you construct and call on its own, outside `mastra.getAgent()`, has no observability attached.

### The exporter also sends logs

`OtelExporter` exports two signals by default: traces to `/v1/traces` and Mastra's own log records (warnings and errors, such as a tool that threw) to `/v1/logs`. Maple accepts both. The logs carry the trace and span ids of the run that wrote them. Agent Sessions reads only the spans. To send traces only:

```ts
new OtelExporter({
	provider: { custom: { /* as above */ } },
	signals: { logs: false },
})
```

### An app that already has OpenTelemetry

The exporter runs its own `BatchSpanProcessor` and doesn't touch a global `TracerProvider`, so it coexists with an existing Node SDK setup. The Mastra spans then form their own traces, separate from your HTTP spans. If you want Mastra's spans nested under your request spans, use Mastra's [OpenTelemetry bridge](https://mastra.ai/reference/observability/tracing/bridges/otel) instead of `OtelExporter`, and point your existing exporter at Maple. Use one or the other, not both, or every span arrives twice.

## Group every turn of a conversation into one session

Maple groups traces into sessions by `gen_ai.conversation.id`. Mastra writes it on every span from the memory thread id of the run, and only from there. Each `generate()` or `stream()` call is its own trace, so a chat that sends one request per user message needs the same thread id on every call:

```ts
const agent = mastra.getAgent("supportAgent")

export async function handleMessage(chatId: string, userId: string, text: string) {
	const result = await agent.generate(text, {
		memory: { thread: chatId, resource: userId },
	})
	return result.text
}
```

The thread id must be stable for the whole conversation and different between conversations. Use the chat or conversation id your app already has; a per-process constant merges every user into one session.

This is the same `memory` option that makes the agent remember earlier messages, so an agent with `memory: new Memory(...)` that already passes it needs nothing more. If you skip it, each message shows up in **Agent Sessions** as its own one-turn session named after the trace id. Mastra's server routes (`mastra dev`, `@mastra/server`) pass the thread the client sends, or the one your middleware sets as `mastra__threadId` in the request context.

Streaming works the same way. Consume the whole stream: the `invoke_agent` span ends, and gets exported, when the stream finishes.

```ts
const stream = await agent.stream(text, { memory: { thread: chatId, resource: userId } })
for await (const chunk of stream.textStream) {
	res.write(chunk)
}
```

### Workflows and agents without memory

A workflow run has no thread, and neither does an agent you call without `memory`. Put the id in the root span's metadata instead. Mastra copies root metadata to every span in the trace, and the exporter turns `metadata.threadId` into `gen_ai.conversation.id`:

```ts
const run = await mastra.getWorkflow("briefingWorkflow").createRun()
const result = await run.start({
	inputData: { request },
	tracingOptions: { metadata: { threadId: conversationId } },
})
```

The same `tracingOptions` works on `agent.generate()` for an agent that has no memory configured.

## Record prompts, responses and tool calls

Content capture is on by default. Each `chat` span carries `gen_ai.input.messages` and `gen_ai.output.messages` as JSON in the GenAI message format, the `invoke_agent` span carries the agent's instructions as `gen_ai.system_instructions`, and each `execute_tool` span carries `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Maple builds the transcript from those attributes.

Mastra bounds what it serializes into a span. The defaults are 128 KiB per string, 50 items per array, 50 keys per object and 8 levels deep. A cut string ends in `…[truncated]`, which Maple shows as truncated. A message list longer than 50 entries loses the newest messages, so a turn with a long history can be missing its latest user message. Raise the array limit if your agents keep long histories:

```ts
new Observability({
	configs: {
		maple: {
			serviceName: "support-agent",
			exporters: [mapleExporter],
			serializationOptions: { maxArrayLength: 200 },
		},
	},
})
```

To keep content out of Maple for one request, hide it for the whole trace:

```ts
await agent.generate(text, {
	memory: { thread: chatId, resource: userId },
	tracingOptions: { hideInput: true, hideOutput: true },
})
```

Sessions keep their turns, models, tool names, tokens and errors, but the transcript is empty and tool calls have no arguments or results.

Mastra also applies a `SensitiveDataFilter` to every span by default. It redacts values under keys like `password`, `token`, `apiKey`, `authorization` and `secret`, including inside JSON strings, and replaces them with `[REDACTED]`. It matches key names, not free text, so a user who types a password into the chat still sends it to Maple. If you need pattern-based redaction of message text, run it in an OpenTelemetry Collector between your app and Maple.

## Tools, errors and sub-agents

Every tool call is an `execute_tool <tool id>` span with `gen_ai.tool.name`, the model's `gen_ai.tool.call.id`, the tool description, and the arguments and result. Maple matches each call to the model reply that requested it by that id.

A tool that throws is marked failed: status ERROR, `error.type` set to Mastra's error id (`TOOL_EXECUTION_FAILED`), and the exception message as the status message. The agent keeps running and the model sees the error. A tool that returns an error value instead of throwing stays green, and Maple counts the call as a success, so throw for failures you want to see:

```ts
import { createTool } from "@mastra/core/tools"
import { z } from "zod"

export const fetchTransportData = createTool({
	id: "fetch_transport_data",
	description: "Fetch public transport options for a city.",
	inputSchema: z.object({ city: z.string() }),
	execute: async () => {
		throw new Error("transport data service unavailable (503)")
	},
})
```

Tools with `requireApproval: true` suspend the run before the tool executes. The resumed run (`approveToolCallGenerate()` or `declineToolCallGenerate()`) continues the same trace; pass the same `memory` to it. A declined call produces no `execute_tool` span.

### Sub-agents: keep one conversation id

Mastra's multi-agent idiom is a supervisor: an agent with an `agents` property calls each sub-agent through a tool named `agent-<key>`. Each delegation runs the sub-agent inside the supervisor's trace, under that tool span. Give every agent a `name`; it becomes `gen_ai.agent.name`, and Maple draws one lane per agent name. An `execute_tool agent-weather_worker` span whose only child is `invoke_agent weather_worker` shows as a delegation, with the tool's arguments and result as the lane's input and output.

The catch is memory. When the supervisor runs with a thread, Mastra gives each delegation its own new thread id, so the sub-agent's spans carry a different `gen_ai.conversation.id` from the conversation they belong to. One trace then has several ids, Maple picks one of them for the whole trace, not necessarily yours, and it can split the turn into one turn per id. Add a span processor that copies the root span's thread id to every span of the trace:

```ts
// src/mastra/conversation-id.ts
import type { SpanOutputProcessor } from "@mastra/core/observability"

export const conversationIdFromRoot: SpanOutputProcessor = {
	name: "conversation-id-from-root",
	process(span) {
		let root = span
		while (root?.parent) root = root.parent
		const threadId = root?.metadata?.threadId
		if (span && threadId) span.metadata = { ...span.metadata, threadId }
		return span
	},
	async shutdown() {},
}
```

```ts
new Observability({
	configs: {
		maple: {
			serviceName: "support-agent",
			exporters: [mapleExporter],
			spanOutputProcessors: [conversationIdFromRoot],
		},
	},
})
```

The processor also covers workflows whose steps call agents with their own `memory`. Pass `tracingContext` from the step's `execute` arguments to `agent.generate()`, so the agent's spans join the workflow's trace instead of starting a new one:

```ts
const weatherStep = createStep({
	id: "weather_worker",
	inputSchema: z.object({ city: z.string() }),
	outputSchema: z.object({ findings: z.string() }),
	execute: async ({ inputData, tracingContext }) => {
		const res = await weatherWorker.generate(`Report the weather in ${inputData.city}.`, { tracingContext })
		return { findings: res.text }
	},
})
```

Steps in `.parallel([...])` run concurrently, and their lanes overlap in time in Maple. A workflow run's root span is `invoke_workflow <workflow id>`; Maple treats it as the turn.

## Tokens and cost

The `chat` span of each model call carries `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens` when the provider reports caching. Only that span carries usage, so the enclosing agent, step and generation spans add nothing to the total.

Reasoning tokens are exported as `gen_ai.usage.reasoning_tokens`, a key Maple doesn't read. They're still inside the output token count, so totals are right; only the reasoning breakdown is missing.

Streamed calls report usage too. Time to first token is exported only as `mastra.completion_start_time`, a timestamp Maple doesn't read, so sessions show no time to first token.

Cost shows as unpriced. Mastra doesn't put a cost attribute on its spans, and Maple never prices tokens itself. Tokens, models and call counts are complete.

## Short-lived processes

The exporter batches spans and sends them every 5 seconds. A script, CLI, test run or serverless function that exits sooner loses the batch. In a script, shut Mastra down before exiting; that flushes every exporter:

```ts
try {
	await main()
} finally {
	await mastra.shutdown()
}
```

In a serverless handler, flush at the end of each request instead, and keep the instance for the next one:

```ts
export async function POST(req: Request) {
	const { chatId, userId, text } = await req.json()
	try {
		const result = await mastra.getAgent("supportAgent").generate(text, {
			memory: { thread: chatId, resource: userId },
		})
		return Response.json({ text: result.text })
	} finally {
		await mastra.observability.flush()
	}
}
```

For a streamed response, flush after the stream has finished, for example in Next.js `after()` or Cloudflare's `ctx.waitUntil()`. Flushing when the handler returns the stream is too early: the spans end when the last chunk is sent.

## Check that it works

Run one conversation with at least two messages and a tool call, then open **Agent Sessions** in Maple. Spans take a few seconds to arrive, longer if the process is still running and hasn't hit the 5-second export interval. You should see:

- one session per conversation, with your thread id as the session id, and framework **Mastra**;
- one turn per `generate()` or `stream()` call, labeled with the user's message, and a transcript with the prompts, replies and tool calls;
- `invoke_agent <agent name>` spans for runs, `chat <model>` spans for model calls, and `execute_tool <tool id>` spans for tool calls, with `agent_step` and `model_generation` spans in between;
- `invoke_workflow <workflow id>` as the turn for workflow runs;
- a lane per sub-agent, named after its `name`;
- token counts on every model call, including streamed ones;
- failed tool calls marked as failed, with the thrown message;
- cost shown as unpriced.

To see what the exporter does locally, set `logLevel: "debug"` on `OtelExporter`. It prints every queued span and a line per batch, `Export completed: N spans sent successfully` or `Export FAILED` with the reason.

## Troubleshooting

- **Nothing arrives and there is no error.** `observability` is a plain object instead of `new Observability(...)`, or the agent isn't registered on the `Mastra` instance. Check the startup log for a no-op observability warning.
- **`Traces http/json exporter is not installed` or `http/protobuf exporter is not installed` at startup.** The protocol's exporter package is missing. Set `protocol: "http/protobuf"` and install `@opentelemetry/exporter-trace-otlp-proto`.
- **`Custom configuration requires endpoint. Tracing will be disabled.`** The exporter got no `endpoint`. It doesn't read `OTEL_EXPORTER_OTLP_ENDPOINT`; pass the endpoint in code.
- **`Export FAILED` with 401 or 403 in debug output.** The `Authorization` header is missing or the key is wrong. The header value is `Bearer ` followed by the ingest key.
- **Every message is its own session.** The call has no `memory: { thread, resource }`, or the thread id changes per request. Pass the conversation's id on every call; for workflows, use `tracingOptions.metadata.threadId`.
- **A supervisor run shows several turns, or lands in another session.** Delegations got their own thread ids. Add the `conversationIdFromRoot` processor.
- **Nothing arrives from a script or serverless function.** The process ended before the batch was exported. Call `mastra.shutdown()` in a script, or `mastra.observability.flush()` at the end of each request.
- **Spans arrive, but no model calls, models or tokens.** `@mastra/observability` and `@mastra/otel-exporter` are from different releases. Update `@mastra/core`, `@mastra/observability` and `@mastra/otel-exporter` together.
- **Thousands of tiny `model_chunk` spans per streamed reply.** Add `excludeSpanTypes: [SpanType.MODEL_CHUNK]`.
- **Hundreds of `workflow_step` spans per turn.** `includeInternalSpans: true` is set. Mastra runs its agent loop as internal workflows; the flag exports all of them, around 5 times the spans and 25 times the bytes per turn. Leave it off.
- **A workflow's agents show up as separate traces.** The step called `agent.generate()` without `tracingContext`. Pass it from the step's `execute` arguments.
- **The latest user message is missing from a long conversation's transcript.** The message list hit `maxArrayLength` (50). Raise it in `serializationOptions`.
- **A failed tool shows as successful.** The tool returned an error value instead of throwing. Throw an `Error`.
- **Spans show up twice.** Two exporters send the same spans to Maple, for example `OtelExporter` plus the OpenTelemetry bridge, or `OtelExporter` plus an OpenLLMetry or OpenInference instrumentation of the AI SDK underneath. Keep `OtelExporter` and remove the other.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [All agent tracing guides](/docs/agent-tracing)
- [Mastra: OpenTelemetry exporter](https://mastra.ai/docs/observability/tracing/exporters/otel)
- [Mastra: tracing overview](https://mastra.ai/docs/observability/tracing/overview)
- [Trace Vercel AI SDK agents](/docs/agent-tracing/vercel-ai-sdk)
