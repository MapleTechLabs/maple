---
name: maple-agent-tracing-mastra
description: "Trace Mastra agents and workflows with Maple: export Mastra's built-in GenAI spans through @mastra/otel-exporter so each conversation is one Maple Agent Session with transcript, tool calls, sub-agent lanes and tokens. Triggers on 'trace my mastra agent', 'add Maple to mastra', 'agent sessions for mastra', 'OpenTelemetry for mastra'."
---

# Maple agent tracing: Mastra

Goal: every conversation = one Maple Agent Session. Each `agent.generate()` / `agent.stream()` / workflow `run.start()` = one turn (one trace) with transcript, `chat <model>` spans with tokens, `execute_tool <tool>` spans with args/results, failed tools marked failed, sub-agents in their own lanes.

Human guide with the reasoning: https://maple.dev/docs/agent-tracing/mastra

Mechanism: Mastra's own tracing (`@mastra/observability`) converted to OTel GenAI semconv v1.38 by `@mastra/otel-exporter`, which runs its own BatchSpanProcessor. No OTel SDK or instrumentation package needed. Maple detects the vendor from resource `telemetry.sdk.name=@mastra/otel-exporter` and reads `gen_ai.conversation.id` as the session key. The exporter writes that key from span `metadata.threadId`, which Mastra sets from `memory.thread`. No thread = no session key.

Mastra 1.71 has three export gaps that a small span processor (Step 2) fixes; it is required in every setup: the `chat` span has no input messages (empty prompt side of the transcript), sub-agents get their own thread id (turn split, wrong session), and step spans carry the raw provider HTTP response (headers with cookies, full reply body) as `mastra.metadata.headers` / `mastra.metadata.body`, which `hideOutput` does not hide.

## Step 0: Detect

1. Versions: read `package.json` / lockfile for `@mastra/core`, `@mastra/observability`, `@mastra/otel-exporter`, `@mastra/memory`.
   - Need `@mastra/core` 1.x (written against 1.71) and Node >= 22.13. Mastra 0.x uses a different telemetry API: tell the user to upgrade; do not work around it.
   - `@mastra/core`, `@mastra/observability`, `@mastra/otel-exporter` must be from the same release train. Update all three together (`@latest`) if you add or bump one.
2. Find the `new Mastra({...})` instance (usually `src/mastra/index.ts`) and its current `observability` value.
   - Already `new Observability({ configs: {...} })` → add the Maple exporter to the existing config's `exporters` and `mapleSpanProcessor` (Step 2) to its `spanOutputProcessors`; keep existing exporters (MastraStorageExporter, MastraPlatformExporter, Langfuse...) and processors. Do not add a second config: only one config is selected per request.
   - `observability: { default: { enabled: true } }` or any plain object → replace with `new Observability(...)` (a plain object silently installs a no-op). Keep `MastraStorageExporter` if the project uses Mastra Studio traces.
   - `@mastra/otel-bridge` already configured with an OTel SDK → do NOT add OtelExporter (double export). Point the existing OTel exporter at Maple instead.
3. Existing OTel NodeSDK / TracerProvider elsewhere in the app: leave it alone. OtelExporter does not use the global provider; Mastra spans become their own traces.
4. Find: every `generate(` / `stream(` / `network(` call and where the chat/thread id lives in the request; every `new Agent(` (need `id` + `name`); every Agent with an `agents:` property (supervisor); every `createWorkflow` / `run.start(` / `createStep` that calls an agent; tools created with `createTool`.
5. Other tracers of the same model calls (OpenLLMetry `Traceloop.init`, OpenInference AI SDK instrumentation, Vercel AI SDK `experimental_telemetry` on the underlying model) → they double-trace. Keep Mastra's; ask before removing the others if they serve something else.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization: Bearer <key>` (passed as a headers object in code; no `%20` encoding).
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention (`.env`, config module, secret manager) if it has one, e.g. `process.env.MAPLE_INGEST_KEY`. Otherwise inline is acceptable: ingest keys are write-only.
- OtelExporter's `custom` provider reads NO env vars (`OTEL_EXPORTER_OTLP_*` are ignored). Endpoint, protocol and headers must be passed in code.

## Step 2: Install + init

```bash
npm install @mastra/observability@latest @mastra/otel-exporter@latest
```

Use the repo's package manager (pnpm/yarn/bun). Bump `@mastra/core` to latest in the same command if it is older than the other two. The OTLP protobuf exporter (`@opentelemetry/exporter-trace-otlp-proto`) is an optional dependency of `@mastra/otel-exporter` and installs with it; add it explicitly only if the project installs with `--omit=optional` / `--no-optional`.

Create `src/mastra/maple-span-processor.ts` (next to the Mastra instance) with exactly this:

```ts
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

- It must mutate and return the span it receives (Mastra drops a span when a processor returns a copy).
- Mastra appends its `SensitiveDataFilter` after user processors, so the copied prompt is still redacted.

In the file that creates the Mastra instance:

```ts
import { Mastra } from "@mastra/core/mastra"
import { SpanType } from "@mastra/core/observability"
import { Observability } from "@mastra/observability"
import { OtelExporter } from "@mastra/otel-exporter"
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
	// ...existing agents, workflows, storage
	observability: new Observability({
		configs: {
			maple: {
				serviceName: "support-agent",
				exporters: [mapleExporter],
				excludeSpanTypes: [SpanType.MODEL_CHUNK],
				spanOutputProcessors: [mapleSpanProcessor],
			},
		},
	}),
})
```

- `protocol: "http/protobuf"` is mandatory: the custom provider defaults to `http/json`, and a missing protocol package disables tracing with one console error.
- Keep `excludeSpanTypes: [SpanType.MODEL_CHUNK]`: without it every streamed chunk is its own span (~40% of all spans in a supervisor run).
- Endpoint is the base URL; the exporter appends `/v1/traces` and `/v1/logs` (and strips them if present).
- `serviceName` is required; use the project/service name, never leave `mastra-service`. Set `deployment.environment.name` from the app's env (e.g. `process.env.NODE_ENV`).
- Logs: the exporter also sends Mastra log records (warn+) to `/v1/logs` by default. Keep that unless the user wants traces only: `signals: { logs: false }` on OtelExporter.
- Do not set `includeInternalSpans: true` (5x spans, ~25x bytes; Mastra's internal agent-loop workflows).
- Agents and workflows must be registered on this `Mastra` instance and called through it (`mastra.getAgent(...)`, `mastra.getWorkflow(...)`), or called with a `tracingContext` from a traced parent. An `Agent` used standalone has no observability.
- Debugging delivery: `logLevel: "debug"` on OtelExporter prints `Export completed: N spans sent successfully` / `Export FAILED: ...`. Remove it afterwards.

## Step 3: Session id (conversation id)

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

## Step 4: Content

- On by default: `gen_ai.output.messages` on `chat` spans, tool args/results on `execute_tool`. `gen_ai.input.messages` on `chat` spans (with the system prompt as the first message) only exists because of `mapleSpanProcessor`; without it the transcript has replies but no prompts. Tool calls inside earlier history are summarized by Mastra as `[tool: <name>]` text; the full calls are on the `execute_tool` spans.
- `gen_ai.system_instructions` on `invoke_agent` is plain text, which Maple does not decode; the system prompt shows through the system message in the `chat` input instead.
- Opt-out per request: `tracingOptions: { hideInput: true, hideOutput: true }` (whole trace). It hides span input/output only, not metadata; `mapleSpanProcessor` removes the one metadata copy of the reply (`mastra.metadata.body`).
- `SensitiveDataFilter` is auto-applied (redacts values under keys like password/token/apiKey/authorization/secret). Do not disable it (`sensitiveDataFilter: false`) unless the user asks. It matches key names, not free text: a password typed into the chat still reaches Maple. For pattern-based redaction of message text, suggest an OpenTelemetry Collector between the app and Maple.
- Serialization caps: 128 KiB/string, 50 items/array, 50 keys/object, depth 8. If agents keep > ~40 messages of history (`lastMessages` > 40 or custom history), add `serializationOptions: { maxArrayLength: 200 }` to the config, or the newest messages are cut from the transcript.

## Step 5: Tools, errors, sub-agents

- Tools: `createTool({ id, description, inputSchema, execute })`. Span name `execute_tool <id>`, `gen_ai.tool.name` = id. Give tools real ids. The exporter leaves tool calls out of the `chat` span's output messages, so a model reply that only requests tools shows as an empty assistant message in the transcript; the calls show from the `execute_tool` spans. Expected.
- Failures must throw (`throw new Error("...")`). Thrown → span status ERROR with the message as status message, `error.type=unknown`, plus an `exception` event. Returning `{ error }` = counted as success in Maple. If a tool swallows errors into a return value and the user wants failures visible, rethrow.
- Every `new Agent({ id, name, ... })` needs a distinct `name`: it is `gen_ai.agent.name`, which Maple uses for lanes.
- Supervisor agents (`agents: {...}` on an Agent): each delegation is `execute_tool agent-<key>` → `invoke_agent <name>` inside the supervisor's trace, one lane per sub-agent. Mastra gives each delegation a thread id `<supervisorThread>-<uuid>`, which sorts after the real id, so without `mapleSpanProcessor` Maple picks a sub-agent's id as the session and splits the turn. Same for `agent.network()` and workflow steps calling agents with their own `memory`. The processor fixes all of them; do not remove it.
- Maple counts each `execute_tool agent-<key>` delegation as a tool call, next to the sub-agents' own tools. A sub-agent's `chat` input starts with the supervisor's system prompt and the user's original message (Mastra forwards the supervisor's conversation); expected.
- HITL (`requireApproval: true` tools): the model call that requests the tool is exported twice, once without tokens or output when the run suspends and once with its tokens when the run resumes. Maple shows one extra model call with 0 tokens per approval; token totals are right. Expected, not a setup error.

- Workflow runs: the root span is `invoke_workflow <workflow id>`; Maple treats it as the turn. Steps in `.parallel([...])` show as overlapping lanes.
- Workflow steps that call an agent: pass `tracingContext` from the step's `execute` args into `agent.generate(prompt, { tracingContext })`, or the agent starts a separate trace.

## Step 6: Flush

Batch interval is 5 s. Anything that can exit sooner must flush.

- Scripts, CLIs, tests, one-shot jobs: `await mastra.shutdown()` in a `finally` before exit (flushes all exporters). Never `process.exit()` before it.
- Serverless / per-request handlers (Next.js route handlers, Vercel, Lambda, Workers): `await mastra.observability.flush()` in a `finally` at the end of each request; keep the instance. For streamed responses, flush after the stream completes (`after()`, `ctx.waitUntil()`, stream `onFinish`), not when the handler returns.
- Long-running servers: nothing needed; optionally call `mastra.shutdown()` on SIGTERM.

## Step 7: Verify

Run one conversation: 2+ user messages with the same thread id (one streamed), at least one tool call, and a second conversation with a different thread id. If the project has a supervisor or workflow, run it once. Flush. Then check (Maple UI Agent Sessions, or debug log + Maple MCP `list_agent_sessions` filtered by service):

- Startup log has no `[OtelExporter]` errors and no no-op observability warning; with `logLevel: "debug"`, `Export completed` lines appear.
- Framework shows **Mastra** (not Unidentified).
- Exactly one session per conversation, id = the thread id; the second conversation is a separate session; no `trace:<id>` sessions for chat turns.
- One turn per `generate()` / `stream()` / workflow run, labeled with the user message.
- Transcript shows user prompts, assistant replies and tool calls. If it has replies but no prompts, `mapleSpanProcessor` is missing from `spanOutputProcessors`.
- `chat <model>` spans have model, provider, `gen_ai.input.messages` and input/output tokens, including the streamed turn. Exception: with HITL, one `chat` span per approval has no tokens (Step 5).
- No span has `mastra.metadata.headers` or `mastra.metadata.body`.
- `execute_tool <id>` spans have the real tool name, arguments and result; a throwing tool is marked failed with its message; successful tools are not.
- Supervisor/workflow: one session, one turn per run, one lane per sub-agent `name`, all spans in one trace; tool calls include the `agent-<key>` delegations.
- Cost shows as unpriced (expected: Mastra emits no cost attribute). Mastra exports no `gen_ai.response.id`; that's fine, each call's usage is reported once.

## Troubleshooting symptoms

- `Custom configuration requires endpoint. Tracing will be disabled.` → no `endpoint` passed in code (env vars are not read).
- `Traces http/json exporter is not installed` / `http/protobuf exporter is not installed` → protocol package missing (optional deps skipped); set `protocol: "http/protobuf"` and install `@opentelemetry/exporter-trace-otlp-proto`.
- `Export FAILED` with 401/403 in debug output → missing `Authorization` header or wrong key/region. Value is `Bearer ` + ingest key.
- One model call per turn carrying the turn's summed tokens → `@mastra/core` / `@mastra/observability` / `@mastra/otel-exporter` from different releases; exporter fell back to `model_generation` as the model call. Update all three together.
- Dozens of `model_chunk` spans → add `excludeSpanTypes: [SpanType.MODEL_CHUNK]`. Hundreds of `workflow_step` spans → remove `includeInternalSpans: true`.
- A workflow's agents in separate traces → pass `tracingContext` from the step.
- Latest user message missing in long chats → raise `serializationOptions.maxArrayLength`.
- Spans twice → two exporters to Maple (OtelExporter + OTel bridge, or + OpenLLMetry/OpenInference on the AI SDK). Keep OtelExporter only.

## Do not

- Do not pass a plain object as `observability`; use `new Observability(...)`.
- Do not rely on `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_PROTOCOL`; the custom provider ignores them.
- Do not omit `protocol: "http/protobuf"` (defaults to `http/json`, needs a different package).
- Do not add an OTel NodeSDK, `@vercel/otel`, OpenLLMetry or OpenInference just for Mastra; they are unnecessary and double-trace model calls.
- Do not use both OtelExporter and `@mastra/otel-bridge` to reach Maple.
- Do not call `generate()` / `stream()` without a stable `memory.thread` (or `tracingOptions.metadata.threadId`) in a multi-turn chat.
- Do not enable `includeInternalSpans`.
- Do not stamp `maple_ai.session.id` on Mastra spans; it re-vendors them away from Mastra decoding. Use the thread id.
- Do not mix `@mastra/core` / `@mastra/observability` / `@mastra/otel-exporter` versions from different releases (the exporter picks the model-call span from features both packages report).
- Do not leave out `mapleSpanProcessor`, and do not replace it with a processor that returns a copy of the span.
- Do not return error objects from tools you want counted as failures; throw.
- Do not exit a script without `await mastra.shutdown()`.
- Do not promise cost or time-to-first-token in Maple: Mastra emits neither under keys Maple reads. Reasoning tokens are in the output total but not broken out.

## Feedback on this skill

When a step in this skill was wrong, missing or misleading (or something worked noticeably well), send the Maple team feedback once you're done. Show the user what you'll send and send it only with their OK.

Keep it about the skill, never about the user's project:

- Include: `maple-agent-tracing-mastra`, the step that failed, the framework and package versions, what you expected versus what happened, and the fix you used.
- Leave out: keys and tokens of any kind, hostnames, URLs, file paths, repo or service names, code from the project, prompts, model replies, span or log contents, and anything that identifies the user or their customers. Replace a value with a placeholder like `<redacted>` if the error message contains one.

Send it one way:

- **Maple MCP connected:** call `send_maple_feedback` with `kind` (`bug`, `documentation`, `improvement`, `feature_request`, `praise` or `other`), `summary` (one line), `reason` (what you were doing and what got in the way), optional `details`, `related_to: "maple-agent-tracing-mastra"`, `agent_type: "coding_agent"` and your `agent_name` and `model`.
- **No MCP:** `POST https://api.maple.dev/v2/agent_feedback` (EU: `https://api.eu.maple.dev/v2/agent_feedback`) with `Authorization: Bearer <maple_ak_ API key>` and the same fields as JSON, the agent under `"agent": {"type": "coding_agent", "name": ..., "model": ...}`. The ingest key (`maple_pk_`) doesn't work here; ask the user for an API key from **Settings → API Keys**, and never write it to a file.
- **Neither available:** give the user the drafted feedback so they can send it themselves.
