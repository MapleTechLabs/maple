---
name: maple-agent-tracing-openai-agents
description: "Trace OpenAI Agents SDK agents with Maple: bridges the SDK's tracing to OpenTelemetry with OpenInference (GenAI attributes on), wraps each run in using_session so each chat is one Maple Agent Session with transcript, tool calls, handoffs, sub-agent lanes and tokens. TypeScript (@openai/agents) via the OpenInference JS bridge with gen_ai.conversation.id in context. Triggers on 'trace my openai agents sdk agent', 'add Maple to openai-agents', 'add Maple to @openai/agents', 'agent sessions for OpenAI Agents SDK', 'OpenTelemetry for openai agents'."
---

# Maple agent tracing for the OpenAI Agents SDK

Goal: every conversation with the app shows up in Maple **Agent Sessions** as exactly one session, one turn per `Runner.run`, with transcript, model calls, tool calls (failures marked), agent lanes for sub-agents and handoffs, and tokens (streamed turns included).

Mechanism: the SDK has its own tracing pipeline (not OpenTelemetry) whose default processor uploads to the OpenAI dashboard. `openinference-instrumentation-openai-agents` registers a processor on that pipeline that converts each SDK span into an OTel span; an OTel SDK `TracerProvider` + OTLP/HTTP exporter sends them to Maple.

Python is the primary path. TypeScript (`@openai/agents` in `package.json`): Step 1 applies; then follow Step 2e in place of Steps 0 and 2a-6, and verify with Step 7. The TypeScript bridge exports less (see the end of 2e).

## Step 0: Detect versions and existing setup

1. Find the project file (`pyproject.toml`, `requirements*.txt`, `uv.lock`, `poetry.lock`) and the installed `openai-agents` version. Target `openai-agents>=0.22` (verified 0.22.3) and `openinference-instrumentation-openai-agents>=2.5` (verified 2.5.0; 1.x does not record agent names). Python 3.10 to 3.14.
2. Grep for existing tracing: `TracerProvider(`, `set_tracer_provider`, `OpenAIAgentsInstrumentor`, `set_trace_processors`, `add_trace_processor`, `set_tracing_disabled`, `OPENAI_AGENTS_DISABLE_TRACING`, `tracing_disabled=`, `logfire.configure`, `instrument_openai_agents`, `OpenAIInstrumentor`, `phoenix.otel.register`, `langfuse`, `openlit.init`, `Traceloop.init`.
   - Existing `TracerProvider` of the app's own: reuse it. Add a `BatchSpanProcessor(OTLPSpanExporter(...))` for Maple to it. Do not create a second provider.
   - Existing `OpenAIAgentsInstrumentor().instrument(...)`: edit that call; never call `instrument()` twice.
   - Tracing disabled anywhere (`set_tracing_disabled(True)`, `OPENAI_AGENTS_DISABLE_TRACING=1`, `RunConfig(tracing_disabled=True)`): remove it. It kills the pipeline the bridge reads; zero spans.
   - Any other instrumentation on the same calls (OpenInference `OpenAIInstrumentor`, Logfire `instrument_openai_agents`/`instrument_openai`, Langfuse/Traceloop/OpenLIT Agents or OpenAI instrumentors, `opentelemetry-instrumentation-genai-openai-agents`): remove it or every model call is recorded twice.
3. Find every `Runner.run(`, `Runner.run_sync(`, `Runner.run_streamed(` and where the conversation/thread id lives in the request. Note `RunConfig(group_id=...)` and `SQLiteSession(...)`/other `Session` ids: reuse that id in Step 3.
4. Find the model setup: default OpenAI (Responses API, `OPENAI_API_KEY`) vs a custom base URL (`AsyncOpenAI(base_url=...)`, `set_default_openai_client`, `OpenAIChatCompletionsModel`, `set_default_openai_api("chat_completions")`, LiteLLM extension).

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`. Protocol `http/protobuf`.
- Key in the user's prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from **Settings → Ingestion**.
- Private `maple_sk_` keys never go in browser code. This runs server-side; a `maple_pk_` ingest key is write-only.
- Follow the repo's existing secret/env convention (`.env`, settings module, secret manager). If there is none, inline is acceptable because ingest keys are write-only: set the `OTEL_*` values from 2b as defaults at the top of the tracing module, before the provider / `NodeSDK` is built (`os.environ.setdefault(...)` / `process.env.X ??= ...`).
- Building the header in code from an env var: when it is unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally. Never raise, throw or exit over the key, and never send `Bearer None` / `Bearer undefined` (opaque 401) or hit a bare `KeyError` on import. Or inline the key when the repo has no env convention.
- 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust: keys are region-bound, so it usually belongs to the other region. Try the other endpoint.

## Step 2: Install and initialize

### 2a. Packages

Add with the project's package manager:

```
openai-agents>=0.22
openinference-instrumentation-openai-agents>=2.5
opentelemetry-sdk>=1.45
opentelemetry-exporter-otlp-proto-http>=1.45
```

### 2b. Environment

```bash
OTEL_SERVICE_NAME=<service name, e.g. support-agent>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev     # EU: https://ingest.eu.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

These are read when the exporter / `NodeSDK` is constructed. If the app loads `.env` (`load_dotenv()`, `dotenv/config`, `--env-file`), load it at the top of the tracing module, before the provider is built; otherwise the exporter silently targets `localhost:4318` with no key.

`OTLPSpanExporter()` appends `/v1/traces` to `OTEL_EXPORTER_OTLP_ENDPOINT`. `OTLPSpanExporter(endpoint=...)` in code does NOT append; give the full `.../v1/traces` URL there.

### 2c. Tracing module

Create `tracing.py` (or add to the app's existing observability module), imported at the top of the entry point before any `Runner.run`:

```py
import re

from agents import set_trace_processors
from agents.tracing import TracingProcessor
from agents.tracing.span_data import GenerationSpanData, HandoffSpanData
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def _chat_message(response: dict) -> dict:
    """The assistant message inside a Responses-shaped dict, as a Chat Completions message."""
    text, calls = "", []
    for item in response.get("output") or []:
        if item.get("type") == "message":
            text += "".join(c.get("text", "") for c in item.get("content") or [] if c.get("type") == "output_text")
        elif item.get("type") == "function_call":
            calls.append({"id": item["call_id"], "type": "function",
                          "function": {"name": item["name"], "arguments": item["arguments"]}})
    return {"role": "assistant", "content": text or None, "tool_calls": calls or None}


class MapleSpanFixes(TracingProcessor):
    """Fills two gaps in what OpenInference exports. Must run before the OpenInference processor."""

    def on_span_end(self, span):
        data = span.span_data
        current = trace.get_current_span()  # the matching OpenTelemetry span, still open here
        if isinstance(data, HandoffSpanData) and data.to_agent:
            # Handoff spans carry no tool name; rebuild the SDK's default one.
            current.set_attribute("gen_ai.tool.name", re.sub(r"[^a-zA-Z0-9_]", "_", f"transfer_to_{data.to_agent}").lower())
        elif isinstance(data, GenerationSpanData) and data.output and data.output[0].get("object") == "response":
            # Streamed Chat Completions calls record a Responses object OpenInference can't read.
            data.output = [_chat_message(data.output[0])]

    def on_trace_start(self, t): pass
    def on_trace_end(self, t): pass
    def on_span_start(self, span): pass
    def shutdown(self): pass
    def force_flush(self): pass


provider = TracerProvider()  # resource from OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

set_trace_processors([MapleSpanFixes()])  # drops the SDK's upload to OpenAI
OpenAIAgentsInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
    exclusive_processor=False,  # append after MapleSpanFixes
)
```

- `enable_genai_semconv=True` is REQUIRED for finish reasons: without it model spans carry none. Env equivalent `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` only works if set before `TraceConfig()` is built.
- `MapleSpanFixes` is required. It runs on each SDK span before the OpenInference processor and fixes two gaps: (1) handoff spans get no tool name, so it sets the SDK's default `transfer_to_<agent>` name, snake-cased (a name set with `tool_name_override` can't be recovered); (2) streamed Chat Completions calls (`run_streamed` on `OpenAIChatCompletionsModel`, LiteLLM, any-llm) record their output as a Responses object that OpenInference can't parse, so the streamed reply is missing from the transcript; it rewrites that output into a Chat Completions message. It must be FIRST in the SDK's processor list, hence `set_trace_processors([...])` + `exclusive_processor=False`. Keep the OpenAI dashboard upload too only if the user asks: `set_trace_processors([MapleSpanFixes(), default_processor()])` (`from agents.tracing.processors import default_processor`; needs a valid OpenAI key).

### 2d. Non-OpenAI models (OpenRouter, LiteLLM proxy, vLLM, Ollama, Azure-compatible)

If any agent uses a Chat Completions model on a base URL other than `api.openai.com`, set `ModelSettings(include_usage=True)` on those agents (or in `RunConfig(model_settings=...)`):

```py
agent = Agent(
    name="assistant",
    instructions="...",
    model=OpenAIChatCompletionsModel(model="openai/gpt-4o-mini", openai_client=client),
    model_settings=ModelSettings(include_usage=True),
)
```

Without it the SDK sends no `stream_options` for non-OpenAI clients and every `run_streamed` turn has zero tokens. Non-streamed calls are unaffected. Responses API models on OpenAI need nothing.

### 2e. TypeScript (`@openai/agents`) only

Steps 0, 2a-2d and 3-6 are Python. For TypeScript do this section instead, then Step 7. Find every `run(` / `runner.run(` / `Runner` call and where the conversation id lives first.

Verified 2026-09-29: `@openai/agents` 0.18.0, `@arizeai/openinference-instrumentation-openai-agents` 0.2.15, `@arizeai/openinference-core` 2.7.1, `@opentelemetry/sdk-node` 0.222.0, `@opentelemetry/api` 1.9.1, Node 26.

Install (the project's package manager):

```
@openai/agents @arizeai/openinference-instrumentation-openai-agents @arizeai/openinference-core @opentelemetry/api @opentelemetry/sdk-node
```

Env: same `OTEL_*` variables as 2b. `new NodeSDK()` reads all of them (service name, resource attributes, endpoint + `/v1/traces`, headers, protocol; default `http/protobuf`).

`instrumentation.ts`, imported as the FIRST line of the entry point (before anything imports `@openai/agents` and runs an agent): `import "./instrumentation.js"`, or `"./instrumentation.ts"` when the project runs `.ts` directly with `allowImportingTsExtensions`; match the entry file's other relative imports.

```ts
import * as agents from "@openai/agents"
import { OpenAIAgentsInstrumentation } from "@arizeai/openinference-instrumentation-openai-agents"
import { NodeSDK } from "@opentelemetry/sdk-node"

// Reads OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_*
export const sdk = new NodeSDK()
sdk.start()

// Replaces the SDK's default processor, which uploads traces to OpenAI
new OpenAIAgentsInstrumentation().manuallyInstrument(agents)
```

- `manuallyInstrument(agents)` works in ESM and CJS; `NodeSDK({ instrumentations: [...] })` alone only hooks `require()`, so don't rely on it.
- Without `tracerProvider`, the bridge uses the GLOBAL tracer provider. App already starts OpenTelemetry (auto-instrumentations `register`, Sentry, its own `NodeTracerProvider().register()`, `@vercel/otel`): don't add a `NodeSDK`; add a `BatchSpanProcessor(new OTLPTraceExporter())` for Maple to that provider if it doesn't export to Maple already, and keep the `manuallyInstrument` line. A hand-built 2.x `NodeTracerProvider` does NOT read `OTEL_SERVICE_NAME` unless given `resource: detectResources({ detectors: [envDetector] })` (`@opentelemetry/resources`); you get `unknown_service:node`.
- The bridge's default `exclusiveProcessor: true` calls `setTraceProcessors([bridge])`, which drops the OpenAI dashboard upload. Only pass `manuallyInstrument(agents, { exclusiveProcessor: false })` if the user wants to keep that upload (needs a valid OpenAI key).
- Tracing switches: `setTracingDisabled(true)`, `OPENAI_AGENTS_DISABLE_TRACING=1|true` and `tracingDisabled: true` in the run config give zero spans; remove them. `NODE_ENV=test` ALSO disables the SDK's tracing by default (verified: no export); in tests that should export, call `setTracingDisabled(false)` from `@openai/agents` (verified to re-enable).
- Remove other instrumentations of the same calls (`@arizeai/openinference-instrumentation-openai`, `@opentelemetry/instrumentation-openai`, Langfuse/Traceloop/OpenLIT OpenAI instrumentors) or every model call is recorded twice.

Session id: put it in the OpenTelemetry context as `gen_ai.conversation.id` with `setAttributes` from `@arizeai/openinference-core`; the bridge copies context attributes onto every span it starts:

```ts
import { setAttributes } from "@arizeai/openinference-core"
import { run } from "@openai/agents"
import { context } from "@opentelemetry/api"

export async function handleMessage(conversationId: string, text: string) {
	const ctx = setAttributes(context.active(), { "gen_ai.conversation.id": conversationId })
	const result = await context.with(ctx, () => run(agent, text))
	return result.finalOutput
}
```

- App wraps runs in `withTrace(...)`: put `context.with(ctx, ...)` around the `withTrace` call, not the inner `run` (the bridge starts the root span from the context active when the trace starts). The root span is then named after the `withTrace` name, and `workflowName` names the inner span.
- Wrap EVERY `run(...)` / `runner.run(...)` call. Use the id the app already stores the chat under; never a per-request UUID or a constant. If the app passes a `session` (`MemorySession`, `OpenAIConversationsSession`, its own), key it by the same id. `groupId` and SDK session ids don't reach Maple.
- Streaming: call `run(agent, text, { stream: true })` inside the callback; reading the stream (`toTextStream()`, `for await`, `await stream.completed`) may happen after `context.with` returns (verified: every span of the streamed turn carried the id).
- `workflowName` (run config): same rule as Python, keep `tool` out of it. The default `Agent workflow` is fine.

Flush:
- Long-running server: flush on `SIGTERM` only, nothing per request. If the app has no `SIGTERM` handler: `process.on("SIGTERM", () => sdk.shutdown().catch((err) => console.error("telemetry flush failed", err)).finally(() => process.exit(0)))`; otherwise add the `shutdown()` to its handler.
- Script / CLI: `await sdk.shutdown().catch((err) => console.error("telemetry flush failed", err))` in `finally`: `shutdown()` rejects when an export failed, and a Maple outage must not crash the app.
- Serverless: add `@opentelemetry/sdk-trace-base` + `@opentelemetry/exporter-trace-otlp-proto`, build `export const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter())`, pass `new NodeSDK({ spanProcessors: [spanProcessor] })`, and `await spanProcessor.forceFlush()` in `finally` of EVERY invocation (verified: spans arrive with the process exiting right after `forceFlush()`). Never `shutdown()` per invocation. `NodeSDK` has no `forceFlush()` of its own.

What Maple shows for TypeScript (tell the user):
- Works: one session per conversation id, one turn per `run` (root `Agent workflow` AGENT span, turn label = last user message), operation per span from `openinference.span.kind` (LLM -> chat, TOOL -> execute_tool, AGENT -> invoke_agent), model (`llm.model_name`: the configured id on Chat Completions, the dated snapshot OpenAI returns on Responses), provider `openai`, input/output tokens on every model call INCLUDING streamed Chat Completions on non-OpenAI base URLs (the JS SDK always sends `stream_options.include_usage` when streaming; no `include_usage` step needed), cached tokens on Responses, reasoning tokens on Responses and on Chat Completions (when the provider reports them), tool name, tool failures (a throwing tool's span is status ERROR `Error running tool (non-fatal): ...`; a tool that RETURNS an error string counts as success), prompts in the transcript (from `input.value`). Handoffs are TOOL spans `handoff to <agent>` with tool name `handoff_to_<agent>`.
- Agent lanes: one per agent name, read from the agent spans' `graph.node.id`.
- Missing: cost.

## Step 3: Session id (one conversation = one session)

Maple reads `session.id` on this framework's spans. Only OpenInference's `using_session` sets it. `RunConfig(group_id=...)`, `trace_metadata` and SDK `Session` ids are NOT exported.

```py
from openinference.instrumentation import using_session

async def handle_message(conversation_id: str, text: str) -> str:
    with using_session(conversation_id):
        result = await Runner.run(
            agent, text,
            session=SQLiteSession(conversation_id, "chats.db"),  # or the app's existing Session
            run_config=RunConfig(workflow_name="<app name> workflow"),
        )
    return result.final_output
```

- Wrap EVERY `Runner.run` / `run_sync` / `run_streamed` call in `using_session(<conversation id>)`. Use the id the app already stores the chat under (the same one it passes as `group_id` or to its `Session`). Never mint a new id per request; never a constant.
- `run_streamed`: call it inside the `with` block (its background task inherits the context there); consuming `stream_events()` may continue inside or after.
- Human-in-the-loop resumes (`Runner.run(agent, state)` after `state.approve(...)`): wrap in the same `using_session` id. The resume is its own trace (a second turn with the same user message as label) whose root is the workflow-named span, not an `invoke_agent` root.
- Set `RunConfig(workflow_name=...)` to name the trace root; the default `Agent workflow` is the same for every run. If the app already wraps runs in its own `trace()`, the root is named after that and `workflow_name` names the inner CHAIN span. The name must NOT contain `tool` (any case): the per-run CHAIN span carries it with no operation, and Maple's name fallback then counts every run as an extra tool call. End it in `workflow` or `agent`.
- `using_session` stores the id in a contextvar; asyncio tasks inherit it, so concurrent tool calls and agents-as-tools inside the block get it too.
- Multi-agent fan-out with several `Runner.run` calls: wrap them in one `with trace("<name>")` (from `agents`) inside `using_session`, or each run becomes its own trace/turn:

  ```py
  import asyncio

  from agents import trace

  with using_session(conversation_id), trace("amsterdam briefing"):
      weather, budget = await asyncio.gather(
          Runner.run(weather_worker, "Weather in Amsterdam?"),
          Runner.run(budget_worker, "3-day budget for Amsterdam?"),
      )
  ```
- Do not set `gen_ai.conversation.id` or `maple_ai.session.id` by hand; the dual-write copies `session.id` to `gen_ai.conversation.id` already.

## Step 4: Content

- Content is ON by default (SDK `trace_include_sensitive_data=True`, OpenInference copies it). With Step 2c, messages land in `gen_ai.input.messages` / `gen_ai.output.messages`. Nothing to enable.
- Content is sent three times per model span (flattened `llm.input_messages.*`, `input.value`, `gen_ai.input.messages`). Expected; don't strip the OpenInference keys, the GenAI ones are derived from them.
- User wants no content / PII-sensitive: `OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA=false` (or `RunConfig(trace_include_sensitive_data=False)`). Tell them: empty transcript, tool error details redacted (`Tool execution failed. Error details are redacted.`), tokens/tools/failures remain. Alternative at the bridge: `TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)` (or `OPENINFERENCE_HIDE_INPUTS` / `OPENINFERENCE_HIDE_OUTPUTS`); also empties the transcript.
- Partial redaction (e.g. mask emails): drop or rewrite attributes in an OpenTelemetry Collector with the `transform` or `redaction` processor.
- Every model span repeats the conversation so far. Maple has no per-attribute limit and accepts requests up to 20 MiB, so this costs bandwidth, not data.

## Step 5: Tools, errors, sub-agents

- Function tools: span named after the tool, `execute_tool`, `gen_ai.tool.name`, description, arguments, result. A tool that RAISES: the SDK catches it and the span gets status ERROR with message `Error running tool (non-fatal): {...}`; Maple counts it failed. A tool that RETURNS an error string counts as success; point it out, don't change behavior unasked.
- Give every `Agent` a distinct `name=`. Agent spans carry `gen_ai.agent.name`; Maple draws one lane per name.
- Agents as tools (`agent.as_tool(...)`): nested run appears inside the calling tool span. Nothing to add.
- Handoffs: a `handoff to <agent>` span (counted as a tool call named `transfer_to_<agent>`, snake-cased, via `MapleSpanFixes`) and the target agent span as a sibling of the source agent's. Nothing to add.
- `needs_approval=True` tools: the paused run records a tool span without a result, and the resumed run records the executed call again, so Maple shows the tool twice for one approved call. Expected; tell the user.
- Known gaps, don't try to fix: no `gen_ai.tool.call.id` on tool spans; no `gen_ai.response.id` on Chat Completions model spans; no cost.
- Model spans: named `generation` (Chat Completions) or `response` (Responses API). Model on Chat Completions = the configured id (`openai/gpt-4o-mini`); on Responses = the name OpenAI returns, usually a dated snapshot (`gpt-4o-mini-2024-07-18`). Provider is always `openai` (even an Anthropic model behind OpenRouter); cached tokens are inside the input total. Responses API also records cached input tokens and reasoning tokens (`llm.token_count.completion_details.reasoning`).
- Cost via OpenRouter: its Broadcast traces (https://maple.dev/docs/agent-tracing/openrouter) carry per-call cost. Because Chat Completions model spans have no `gen_ai.response.id`, nest the Broadcast spans under them (see "Join Broadcast to your own traces" in that guide) or each call is counted twice.

## Step 6: Flush

- Long-running server: nothing to add; the provider flushes at normal exit.
- Script / CLI / worker:

  ```py
  from tracing import provider
  try:
      asyncio.run(main())
  finally:
      provider.force_flush()
      provider.shutdown()
  ```

- Serverless handler: `provider.force_flush()` before returning from EVERY invocation; never `shutdown()`.
- Notebook: `provider.force_flush()` after the cell that runs the agent.
- `agents.flush_traces()` is not enough: the bridge's `force_flush` is a no-op; spans sit in the OTel batch processor.

## Step 7: Verify

Run one real conversation: 2-3 turns with the same conversation id including one tool call and one streamed turn, plus a second conversation with a different id. Flush. No scriptable entry point (server, REPL, UI only) → write a small driver: one conversation id, 2+ turns, at least one tool call, flush before exit. Wait ~1 minute. In Maple **Agent Sessions**, filtered by the service name (or via the Maple MCP `list_agent_sessions` + `get_agent_session`), check:

- [ ] Exactly one session per conversation id; none named `trace:<id>` (that means a run was outside `using_session`).
- [ ] The two conversations are two different sessions.
- [ ] Framework shows **OpenAI Agents SDK**. Unidentified = wrong/old bridge.
- [ ] TypeScript: every span of a run carries `gen_ai.conversation.id`.
- [ ] One turn per `Runner.run`; turn labels are the user messages; root span named after `workflow_name` (or the app's own `trace()` / `withTrace()` name).
- [ ] Transcript shows instructions, user and assistant messages, tool calls, including the streamed turn's reply (missing there in Python = `MapleSpanFixes` absent or not first).
- [ ] Model calls (`generation` for Chat Completions, `response` for Responses API) show the model and non-zero input/output tokens, INCLUDING the streamed turn (zero there = Step 2d missing). LLM call count equals real model calls.
- [ ] Each tool call appears once, with its real name and real arguments (not a JSON schema); a raised tool error is marked failed (verdict: **Tool availability** failed for it) and nothing else is. Only `needs_approval` tools appear twice (pause + resume).
- [ ] Multi-agent: one lane per agent name; all sub-agent spans in one trace with the same session.
- [ ] Each model call appears once (no second `ChatCompletion`-style span from another instrumentor).
- [ ] Cost shows "unpriced" (expected; nothing emits cost).
- [ ] No span attribute contains the model provider API key, `Bearer ` or `sk-`.

Without Maple access, both must hold: the run exits with no export errors on stderr (`Failed to export`, `OTLPExporterError`, 401 lines), AND a local console/in-memory exporter shows the expected span names with `gen_ai.conversation.id` (TS) / `session.id` (Python) on every span. Silence alone proves nothing (no spans is silent too). With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

Raw span check (optional, e.g. an `InMemorySpanExporter` in a scratch run): model spans have `gen_ai.operation.name=chat`, `gen_ai.input.messages`, `gen_ai.usage.input_tokens`, `session.id`; tool spans have `gen_ai.operation.name=execute_tool`, `gen_ai.tool.call.arguments` equal to the call's arguments; agent spans have `gen_ai.agent.name`.
