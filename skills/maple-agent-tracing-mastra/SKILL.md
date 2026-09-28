---
name: maple-agent-tracing-mastra
description: "Trace Mastra agents and workflows with Maple: export Mastra's built-in GenAI spans through @mastra/otel-exporter so each conversation is one Maple Agent Session with transcript, tool calls, sub-agent lanes and tokens. Triggers on 'trace my mastra agent', 'add Maple to mastra', 'agent sessions for mastra', 'OpenTelemetry for mastra'."
---

# Maple agent tracing: Mastra

Goal: every conversation = one Maple Agent Session. Each `agent.generate()` / `agent.stream()` / workflow `run.start()` = one turn (one trace) with transcript, `chat <model>` spans with tokens, `execute_tool <tool>` spans with args/results, failed tools marked failed, sub-agents in their own lanes.

Human guide with the reasoning: https://maple.dev/docs/agent-tracing/mastra

Mechanism: Mastra's own tracing (`@mastra/observability`) converted to OTel GenAI semconv v1.38 by `@mastra/otel-exporter`, which runs its own BatchSpanProcessor. No OTel SDK or instrumentation package needed. Maple detects the vendor from resource `telemetry.sdk.name=@mastra/otel-exporter` and reads `gen_ai.conversation.id` as the session key. The exporter writes that key from span `metadata.threadId`, which Mastra sets from `memory.thread`. No thread = no session key.

## Step 0: detect

1. Versions: read `package.json` / lockfile for `@mastra/core`, `@mastra/observability`, `@mastra/otel-exporter`, `@mastra/memory`.
   - Need `@mastra/core` 1.x (written against 1.71) and Node >= 22.13. Mastra 0.x uses a different telemetry API: tell the user to upgrade; do not work around it.
   - `@mastra/core`, `@mastra/observability`, `@mastra/otel-exporter` must be from the same release train. Update all three together (`@latest`) if you add or bump one.
2. Find the `new Mastra({...})` instance (usually `src/mastra/index.ts`) and its current `observability` value.
   - Already `new Observability({ configs: {...} })` → add the Maple exporter to the existing config's `exporters`; keep existing exporters (MastraStorageExporter, MastraPlatformExporter, Langfuse...).
   - `observability: { default: { enabled: true } }` or any plain object → replace with `new Observability(...)` (a plain object silently installs a no-op). Keep `MastraStorageExporter` if the project uses Mastra Studio traces.
   - `@mastra/otel-bridge` already configured with an OTel SDK → do NOT add OtelExporter (double export). Point the existing OTel exporter at Maple instead.
3. Existing OTel NodeSDK / TracerProvider elsewhere in the app: leave it alone. OtelExporter does not use the global provider; Mastra spans become their own traces.
4. Find: every `generate(` / `stream(` / `network(` call and where the chat/thread id lives in the request; every `new Agent(` (need `id` + `name`); every Agent with an `agents:` property (supervisor); every `createWorkflow` / `run.start(` / `createStep` that calls an agent; tools created with `createTool`.
5. Other tracers of the same model calls (OpenLLMetry `Traceloop.init`, OpenInference AI SDK instrumentation, Vercel AI SDK `experimental_telemetry` on the underlying model) → they double-trace. Keep Mastra's; ask before removing the others if they serve something else.

## Step 1: key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization: Bearer <key>` (passed as a headers object in code; no `%20` encoding).
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention (`.env`, config module, secret manager) if it has one, e.g. `process.env.MAPLE_INGEST_KEY`. Otherwise inline is acceptable: ingest keys are write-only.
- OtelExporter's `custom` provider reads NO env vars (`OTEL_EXPORTER_OTLP_*` are ignored). Endpoint, protocol and headers must be passed in code.

## Step 2: install + init

```bash
npm install @mastra/observability@latest @mastra/otel-exporter@latest @opentelemetry/exporter-trace-otlp-proto
```

Use the repo's package manager (pnpm/yarn/bun). Bump `@mastra/core` to latest in the same command if it is older than the other two.

In the file that creates the Mastra instance:

```ts
import { Mastra } from "@mastra/core/mastra"
import { SpanType } from "@mastra/core/observability"
import { Observability } from "@mastra/observability"
import { OtelExporter } from "@mastra/otel-exporter"

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
	// ...existing agents, workflows, storage
	observability: new Observability({
		configs: {
			maple: {
				serviceName: "support-agent",
				exporters: [mapleExporter],
				excludeSpanTypes: [SpanType.MODEL_CHUNK],
				spanOutputProcessors: [conversationIdFromRoot], // only if Step 5 applies
			},
		},
	}),
})
```

- `protocol: "http/protobuf"` is mandatory: the custom provider defaults to `http/json`, and a missing protocol package disables tracing with one console error.
- Endpoint is the base URL; the exporter appends `/v1/traces` and `/v1/logs` (and strips them if present).
- `serviceName` is required; use the project/service name, never leave `mastra-service`. Set `deployment.environment.name` from the app's env (e.g. `process.env.NODE_ENV`).
- Logs: the exporter also sends Mastra log records (warn+) to `/v1/logs` by default. Keep that unless the user wants traces only: `signals: { logs: false }` on OtelExporter.
- Do not set `includeInternalSpans: true` (5x spans, ~25x bytes; Mastra's internal agent-loop workflows).
- Agents and workflows must be registered on this `Mastra` instance and called through it (`mastra.getAgent(...)`, `mastra.getWorkflow(...)`), or called with a `tracingContext` from a traced parent. An `Agent` used standalone has no observability.
- Debugging delivery: `logLevel: "debug"` on OtelExporter prints `Export completed: N spans sent successfully` / `Export FAILED: ...`. Remove it afterwards.

## Step 3: session id (conversation id)

Agents: pass the app's conversation id as the memory thread on EVERY call of a conversation:

```ts
const result = await agent.generate(text, { memory: { thread: chatId, resource: userId } })

const stream = await agent.stream(text, { memory: { thread: chatId, resource: userId } })
for await (const chunk of stream.textStream) res.write(chunk) // consume fully; spans end with the stream
```

- `thread` = stable per conversation, different between conversations. Never a constant, never a fresh UUID per request.
- `resource` = the user/tenant id.
- Works without a `Memory` on the agent (Mastra only logs a warning), but prefer the project's existing memory setup.
- Server routes (`@mastra/server`, `mastra dev`): the client's `threadId` or middleware's `mastra__threadId` request-context key is used; verify the frontend sends a stable thread id.

Workflows, and agents that must not use memory: set the thread in root tracing metadata; Mastra copies root metadata to every span:

```ts
const run = await mastra.getWorkflow("briefingWorkflow").createRun()
await run.start({ inputData, tracingOptions: { metadata: { threadId: conversationId } } })
```

`agent.generate(text, { tracingOptions: { metadata: { threadId: conversationId } } })` works the same for memory-less agents.

HITL resumes (`approveToolCallGenerate` / `declineToolCallGenerate` / `approveToolCall` / `declineToolCall`): pass the same `memory` again.

## Step 4: content

- On by default: `gen_ai.input.messages` / `gen_ai.output.messages` on `chat` spans, `gen_ai.system_instructions` on `invoke_agent`, tool args/results on `execute_tool`. Change nothing to keep it.
- Opt-out per request: `tracingOptions: { hideInput: true, hideOutput: true }` (whole trace).
- `SensitiveDataFilter` is auto-applied (redacts values under keys like password/token/apiKey/authorization/secret). Do not disable it (`sensitiveDataFilter: false`) unless the user asks.
- Serialization caps: 128 KiB/string, 50 items/array, 50 keys/object, depth 8. If agents keep > ~40 messages of history (`lastMessages` > 40 or custom history), add `serializationOptions: { maxArrayLength: 200 }` to the config, or the newest messages are cut from the transcript.

## Step 5: tools, errors, sub-agents

- Tools: `createTool({ id, description, inputSchema, execute })`. Span name `execute_tool <id>`, `gen_ai.tool.name` = id. Give tools real ids.
- Failures must throw (`throw new Error("...")`). Thrown → span ERROR + `error.type=TOOL_EXECUTION_FAILED` + message. Returning `{ error }` = counted as success in Maple. If a tool swallows errors into a return value and the user wants failures visible, rethrow.
- Every `new Agent({ id, name, ... })` needs a distinct `name`: it is `gen_ai.agent.name`, which Maple uses for lanes.
- Supervisor agents (`agents: {...}` on an Agent), `agent.network()`, or workflow steps that call agents which have their own `memory`: sub-agents get their own thread ids, so one trace carries several `gen_ai.conversation.id` values and Maple may pick the wrong one or split the turn. Add this processor and list it in `spanOutputProcessors`:

```ts
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

- Workflow steps that call an agent: pass `tracingContext` from the step's `execute` args into `agent.generate(prompt, { tracingContext })`, or the agent starts a separate trace.

## Step 6: flush

Batch interval is 5 s. Anything that can exit sooner must flush.

- Scripts, CLIs, tests, one-shot jobs: `await mastra.shutdown()` in a `finally` before exit (flushes all exporters). Never `process.exit()` before it.
- Serverless / per-request handlers (Next.js route handlers, Vercel, Lambda, Workers): `await mastra.observability.flush()` in a `finally` at the end of each request; keep the instance. For streamed responses, flush after the stream completes (`after()`, `ctx.waitUntil()`, stream `onFinish`), not when the handler returns.
- Long-running servers: nothing needed; optionally call `mastra.shutdown()` on SIGTERM.

## Step 7: verify

Run one conversation: 2+ user messages with the same thread id (one streamed), at least one tool call, and a second conversation with a different thread id. If the project has a supervisor or workflow, run it once. Flush. Then check (Maple UI Agent Sessions, or debug log + Maple MCP `list_agent_sessions` filtered by service):

- Startup log has no `[OtelExporter]` errors and no no-op observability warning; with `logLevel: "debug"`, `Export completed` lines appear.
- Framework shows **Mastra** (not Unidentified).
- Exactly one session per conversation, id = the thread id; the second conversation is a separate session; no `trace:<id>` sessions for chat turns.
- One turn per `generate()` / `stream()` / workflow run, labeled with the user message.
- Transcript shows user prompts, assistant replies and tool calls.
- `chat <model>` spans have model, provider and input/output tokens, including the streamed turn.
- `execute_tool <id>` spans have the real tool name, arguments and result; a throwing tool is marked failed with its message; successful tools are not.
- Supervisor/workflow: one session, one turn per run, one lane per sub-agent `name`, all spans in one trace.
- Cost shows as unpriced (expected: Mastra emits no cost attribute).

## Do not

- Do not pass a plain object as `observability`; use `new Observability(...)`.
- Do not rely on `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_PROTOCOL`; the custom provider ignores them.
- Do not omit `protocol: "http/protobuf"` (defaults to `http/json`, needs a different package).
- Do not add an OTel NodeSDK, `@vercel/otel`, OpenLLMetry or OpenInference just for Mastra; they are unnecessary and double-trace model calls.
- Do not use both OtelExporter and `@mastra/otel-bridge` to reach Maple.
- Do not call `generate()` / `stream()` without a stable `memory.thread` (or `tracingOptions.metadata.threadId`) in a multi-turn chat.
- Do not enable `includeInternalSpans`.
- Do not stamp `maple_ai.session.id` on Mastra spans; it re-vendors them away from Mastra decoding. Use the thread id.
- Do not mix `@mastra/observability` / `@mastra/otel-exporter` versions from different releases (spans arrive with no model calls or tokens).
- Do not return error objects from tools you want counted as failures; throw.
- Do not exit a script without `await mastra.shutdown()`.
- Do not promise cost or time-to-first-token in Maple: Mastra emits neither under keys Maple reads. Reasoning tokens are in the output total but not broken out.
