---
name: maple-agent-tracing-vercel-ai-sdk
description: "Trace Vercel AI SDK agents with Maple: register the AI SDK's OpenTelemetry integration, export to Maple, and pass a conversation id so each chat is one Agent Session with transcript, tool calls, sub-agents and tokens. Covers generateText, streamText, ToolLoopAgent, Node.js and Next.js. Triggers on 'trace my vercel ai sdk agent', 'add Maple to vercel ai sdk', 'agent sessions for vercel ai sdk', 'OpenTelemetry for vercel ai sdk', 'trace my ai sdk app'."
---

# Maple agent tracing: Vercel AI SDK

## Goal

One conversation = one Maple Agent Session, one turn per `generate()`/`stream()` call, with the transcript, every model call (model, tokens, TTFT), every tool call (name, args, result, failures), and a lane per sub-agent.

Known gaps (tell the user, don't try to fix): cost shows as "unpriced" (AI SDK emits no cost; Maple never prices tokens); on AI SDK 5/6 the final assistant reply is missing from transcripts. If model calls go through OpenRouter, its Broadcast traces carry per-call cost and Maple matches them to the AI SDK `chat` spans by response id (see the OpenRouter guide).

## Step 0: Detect

- `ai` version in `package.json` / lockfile:
  - `>= 7`: this skill. Upgrade to `^7.0.106` or newer if older (earlier 7.x leave spans open when a stream errors mid-read). Node.js >= 22 required.
  - `5.x` / `6.x`: ask the user whether to upgrade to 7 (recommended; `npx @ai-sdk/codemod v7`). The codemod only renames `experimental_telemetry` to `telemetry`; you still install `@ai-sdk/otel`, call `registerTelemetry()`, and move the id from `metadata` (removed in 7) to `runtimeContext`, then drop any `ConversationIdProcessor`. If not, go to "AI SDK 5/6" at the end.
- Mastra (`@mastra/core`) or another framework built on `ai`: stop, use that framework's skill instead.
- Existing OpenTelemetry: search for `NodeSDK`, `NodeTracerProvider`, `registerOTel`, `@vercel/otel`, `Sentry.init`, `@langfuse/otel`, `LangfuseSpanProcessor`, `braintrust`, `registerTelemetry(`, `experimental_telemetry`, `telemetry:`.
  - An SDK/provider already exists: reuse it. Add one Maple exporting span processor to it. Never start a second SDK.
  - `registerTelemetry(...)` already exists: extend that call's `OpenTelemetry` options; never call it twice (it appends, so every span is emitted twice).
  - `LegacyOpenTelemetry` registered: replace it with `OpenTelemetry` unless the user says another backend depends on the legacy format. Never register both.
- Next.js app (`next` dependency, `instrumentation.ts`): use Step 2b.
- Find every AI SDK call site: `generateText(`, `streamText(`, `new ToolLoopAgent(`, `createAgentUIStreamResponse(`, `pipeAgentUIStreamToResponse(`, `createAgentUIStream(`, `agent.generate(`, `agent.stream(`. Find each one's conversation id (chat id, thread id, `useChat` request body `id`).

## Step 1: Key and region

- US endpoint `https://ingest.maple.dev`, EU endpoint `https://ingest.eu.maple.dev`. Header `Authorization=Bearer <key>`.
- Key in the user's prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Private `maple_sk_` keys never go in browser code. Ingest keys are write-only.
- Follow the repo's existing secret/env convention (e.g. `MAPLE_INGEST_KEY` or `OTEL_EXPORTER_OTLP_*` in `.env`). If there is none, inlining the ingest key is acceptable.
- The app loads `.env` (`dotenv`, `--env-file`): load it at the top of `instrumentation.ts` (`import "dotenv/config"` as its first line) or run with `--env-file`. `NodeSDK()` reads the `OTEL_*` vars when it is constructed; otherwise the exporter silently targets `localhost:4318` with no key.
- Never let an unset variable become `Bearer undefined` (opaque 401). When the key variable is missing, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and leave the Maple exporter out so the app runs normally; never throw over the key. Or inline the key when the repo has no env convention.
- A 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust usually means the key belongs to the other region (keys are region-bound): try the other endpoint.

## Step 2a: Install and init (Node.js)

```bash
npm install ai@^7.0.106 @ai-sdk/otel @opentelemetry/sdk-node
```

Use the repo's package manager (`@opentelemetry/api` arrives as a peer of `sdk-node`; add it explicitly only if the package manager doesn't install peers). Works on Node.js 22+ and Bun. Env (or the repo's equivalent):

```bash
OTEL_SERVICE_NAME=support-agent
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
```

`NodeSDK()` with no span processors builds a batched OTLP http/protobuf exporter from these variables. Create `instrumentation.ts`:

```ts
import { OpenTelemetry } from "@ai-sdk/otel"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { registerTelemetry } from "ai"

export const sdk = new NodeSDK()
sdk.start()

registerTelemetry(
	new OpenTelemetry({
		usage: true,
		runtimeContext: true,
	}),
)
```

Use the explicit span processor variant instead when either applies:

- Serverless handler (Lambda, Cloud Run jobs, queue consumers, cron, Vercel Workflow steps): needs `spanProcessor.forceFlush()` per invocation; `NodeSDK` only has `shutdown()`.
- The repo already starts an OpenTelemetry SDK/provider: add the processor to it, don't create a second `NodeSDK`.
- Inlining the key instead of env: pass `{ url: "https://ingest.maple.dev/v1/traces", headers: { authorization: "Bearer <key>" } }` to `OTLPTraceExporter`.

```bash
npm install @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto
```

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"

export const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter())
export const sdk = new NodeSDK({ spanProcessors: [spanProcessor] })
```

- `import "./instrumentation"` as the FIRST line of every entry point (server, worker, CLI). `registerTelemetry` must run before the first AI SDK call.
- Keep `usage: true` (adds the reasoning-token breakdown, `ai.usage.*`) and `runtimeContext: true` (records the included runtime context keys; Maple reads the conversation id from them).
- Do not pass `tracer:` to `OpenTelemetry` unless reusing a provider requires it; if you must, use `provider.getTracer("gen_ai")`. Other scope names break detection.

## Step 2b: Install and init (Next.js)

`npm install ai@^7.0.106 @ai-sdk/otel @vercel/otel @opentelemetry/api`. In `instrumentation.ts` (root, or `src/` if the app uses `src/`), inside `register()`:

```ts
import { OpenTelemetry } from "@ai-sdk/otel"
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel"
import { registerTelemetry } from "ai"

export function register() {
	const mapleKey = process.env.MAPLE_INGEST_KEY
	if (!mapleKey) {
		// A missing key disables export; it never stops the app.
		console.warn("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")
		return
	}
	registerOTel({
		serviceName: "support-chat",
		traceExporter: new OTLPHttpProtoTraceExporter({
			url: "https://ingest.maple.dev/v1/traces",
			headers: { authorization: `Bearer ${mapleKey}` },
		}),
	})
	registerTelemetry(
		new OpenTelemetry({
			usage: true,
			runtimeContext: true,
		}),
	)
}
```

- An existing `registerOTel` call: keep it, add the Maple exporter (or `OTEL_EXPORTER_OTLP_*` env vars if it has no `traceExporter`), add `registerTelemetry` next to it.
- Sentry in the same app: it must use `skipOpenTelemetrySetup: true`, or spans duplicate.
- `@vercel/otel` force-ends every still-open span of a trace when its root span ends. Read AI SDK streams inside the request (return them as the response); never consume them in `after()` or other post-response work, or the `chat`/`invoke_agent` spans lose output and tokens.
- Next.js 13.4/14: `experimental: { instrumentationHook: true }` in `next.config`.

## Step 3: Conversation id (session)

Every AI SDK call site that belongs to a conversation must pass `runtimeContext: { conversationId }` AND `telemetry.includeRuntimeContext: { conversationId: true }`. Without the include, the id is not recorded. `sessionId` works as the key too.

generateText / streamText:

```ts
streamText({
	model,
	messages,
	runtimeContext: { conversationId: chatId },
	telemetry: { functionId: "support_agent", includeRuntimeContext: { conversationId: true } },
})
```

If `runtimeContext` already exists, add `conversationId` to it and to `includeRuntimeContext`; keep other keys excluded (they may hold secrets).

ToolLoopAgent (`generate`/`stream` take no per-call `runtimeContext`): add a call option.

```ts
import { z } from "zod"

new ToolLoopAgent({
	// ...existing settings
	callOptionsSchema: z.object({ conversationId: z.string() }),
	prepareCall: ({ options, ...rest }) => ({
		...rest,
		runtimeContext: { conversationId: options.conversationId },
	}),
	telemetry: { functionId: "support_agent", includeRuntimeContext: { conversationId: true } },
})
await assistant.generate({ messages, options: { conversationId: chatId } })

// streaming: stream() returns a Promise in ai 7
const r = await assistant.stream({ messages, options: { conversationId: chatId } })
for await (const c of r.textStream) process.stdout.write(c)
```

Install `zod` if it is not a direct dependency (it is only a peer of `ai`).

- Agent already has `callOptionsSchema`/`prepareCall`: extend both; keep their existing return values and merge `runtimeContext`.
- `useChat` routes: the request body has `id` (the chat id). Use it: `createAgentUIStreamResponse({ agent, uiMessages: messages, options: { conversationId: id } })` (same `options` key on `pipeAgentUIStreamToResponse`), or `runtimeContext: { conversationId: id }` on `streamText`.
- Id must be stable per conversation and unique across conversations. Never a module constant, never `Date.now()` per call, never a per-process id. If the app has no id for a conversation, create one where the conversation is created and persist it with it.
- Tool approvals (`toolApproval: { <tool>: "user-approval" }` on the call or agent; `needsApproval` on `tool()` is deprecated in 7): the resume after the `tool-approval-response` is a second `generate`/`stream` call and a second trace. Pass the same id. Maple shows it as a second turn.
- Background jobs with no conversation: one id per job run.

## Step 4: Content

- On by default. Do not set `recordInputs`/`recordOutputs` unless the user asks for privacy; if they do, set them per call/agent in `telemetry` and tell them the transcript will be empty for those calls.
- Content is not redacted. For pattern-based redaction, suggest an OpenTelemetry Collector between the app and Maple, or `recordInputs`/`recordOutputs: false` on the sensitive calls. `telemetry: { isEnabled: false }` drops a call's spans entirely.
- Never set `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` / `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT`: they cut the message JSON.
- Calls that send images/PDFs: warn the user they are recorded as base64 on every step; suggest `recordInputs: false` on those calls if payloads are large (exports failing with 413 are the symptom).

## Step 5: Tools, errors, sub-agents

- Set a distinct `telemetry.functionId` on EVERY agent/call (snake_case agent name). It becomes `gen_ai.agent.name`; `ToolLoopAgent.id` is not exported.
- Tool failures must throw from `execute`. If a tool returns `{ error }` / `{ ok: false }` for real failures, change it to throw (ask the user first if the model relies on the payload). An always-throwing `execute` needs an explicit return type (`Promise<string>`) or it infers `never`.
- Sub-agents as tools: `execute: async ({ task }) => (await worker.generate({ prompt: task })).text`. The worker needs its own `functionId`; it does not need the conversation id (one span per trace carries it). Separate top-level calls in a pipeline (e.g. a summary agent after the orchestrator) are separate traces: each needs the conversation id.
- Don't pass `telemetry.integrations` on a call unless it includes the `OpenTelemetry` instance: it replaces the global integrations for that call.

## Step 6: Flush

- Scripts/CLIs: `await sdk.shutdown().catch((err) => console.error("telemetry flush failed", err))` in a `finally` at the end. `shutdown()` rejects when an export failed; the `.catch` keeps a Maple outage from crashing the app.
- Long-running servers: `process.on("SIGTERM", () => sdk.shutdown().catch((err) => console.error("telemetry flush failed", err)))`; nothing per request.
- Serverless handlers (Lambda, Cloud Run jobs, queue consumers, cron, Vercel Workflow steps): `await spanProcessor.forceFlush()` in a `finally` per invocation.
- Next.js on Vercel: `@vercel/otel` flushes per request via `waitUntil`; nothing to add in route handlers. Work outside a request needs an explicit flush.
- Streams: read every stream to the end (`for await (const c of result.textStream)` / `await result.consumeStream()` / return it as the response) before flushing. An unread stream never ends its spans.

## Step 7: Verify

Run one real conversation: 2+ turns with the same id, one streamed, one tool call; plus a second conversation. If the app has no scriptable entry point (server, UI only), write a small driver for this: one conversation id, 2+ turns, at least one tool call, flush before exit. Then check (via Maple MCP `list_agent_sessions` / `get_agent_session`, or the Agent Sessions page, ~30 s after the run):

- One session per conversation (id = your `conversationId`), not `trace:<id>` sessions; the second conversation is a separate session.
- Framework shows **Vercel AI SDK**, not Unidentified.
- Turns = number of `generate`/`stream` calls (an approval pause + resume = 2 turns); each has `invoke_agent <model>`, `step <n>`, `chat <model>`, `execute_tool <tool>` spans in one trace.
- Transcript shows user messages, assistant replies and tool calls; turn labels are the user's messages.
- Every `chat` span has input and output tokens, including the streamed turn; the streamed `chat` span has TTFT (`gen_ai.client.operation.time_to_first_chunk`).
- Tool calls have name, arguments, result; a throwing tool is counted as failed with its message; successful tools are not failed.
- Sub-agents show as their own lanes named after their `functionId`. Span names carry the model id, not the agent name (`invoke_agent <model id>`); two agents on one model have identically named spans, and the name is on `gen_ai.agent.name`.
- No attribute contains the provider API key or `Bearer `.
- Cost shows as unpriced (expected).
- The process exited cleanly and no turn is missing (flush ran).

Without Maple access: the run exits with no export errors on stderr (`OTLPExporterError`, `Failed to export`, 401 lines) AND a local run with `OTEL_TRACES_EXPORTER=console,otlp` (the `NodeSDK()` variant without `spanProcessors`) prints the `invoke_agent`/`chat`/`execute_tool` spans, with `ai.settings.context.conversationId` on the `invoke_agent` spans. Silence alone proves nothing (no spans also looks silent). With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

## AI SDK 5/6 (only if the user won't upgrade)

- Tracing is per call: `experimental_telemetry: { isEnabled: true, functionId: "<agent>", metadata: { conversationId } }` on every call. Spans: `ai.generateText`/`ai.streamText`, `.doGenerate`/`.doStream`, `ai.toolCall`, tracer `ai`. Provider setup as in Step 2a without `registerTelemetry`/`@ai-sdk/otel`.
- Copy the id to `gen_ai.conversation.id` with a span processor placed before the exporting one:

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
// spanProcessors: [new ConversationIdProcessor(), spanProcessor]
```

- Tell the user: final assistant replies won't show in the transcript (recorded only as plain `ai.response.text`); upgrading to 7 fixes it.

## Do not

- Do not use `experimental_telemetry: { isEnabled: true }` as the v7 setup; without `registerTelemetry` there are zero spans.
- Do not add a second AI SDK tracer that also exports to Maple (Langfuse/Braintrust/Sentry AI integrations, OpenLLMetry/OpenInference AI SDK processors): every model call gets recorded twice.
