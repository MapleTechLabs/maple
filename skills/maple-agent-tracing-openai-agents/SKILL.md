---
name: maple-agent-tracing-openai-agents
description: "Trace OpenAI Agents SDK agents with Maple: bridges the SDK's tracing to OpenTelemetry with OpenInference (GenAI attributes on), wraps each run in using_session so each chat is one Maple Agent Session with transcript, tool calls, handoffs, sub-agent lanes and tokens. Triggers on 'trace my openai agents sdk agent', 'add Maple to openai-agents', 'agent sessions for OpenAI Agents SDK', 'OpenTelemetry for openai agents'."
---

# Maple agent tracing for the OpenAI Agents SDK

Goal: every conversation with the app shows up in Maple **Agent Sessions** as exactly one session, one turn per `Runner.run`, with transcript, model calls, tool calls (failures marked), agent lanes for sub-agents and handoffs, and tokens (streamed turns included).

Human guide with the reasoning: https://maple.dev/docs/agent-tracing/openai-agents

Mechanism: the SDK has its own tracing pipeline (not OpenTelemetry) whose default processor uploads to the OpenAI dashboard. `openinference-instrumentation-openai-agents` registers a processor on that pipeline that converts each SDK span into an OTel span; an OTel SDK `TracerProvider` + OTLP/HTTP exporter sends them to Maple. Maple fingerprints the scope `openinference.instrumentation.openai_agents` as "OpenAI Agents SDK" and reads `session.id` for the session.

Python is the primary path. TypeScript: see Step 2e.

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
- Follow the repo's existing secret/env convention (`.env`, settings module, secret manager). If there is none, inline is acceptable because ingest keys are write-only.

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
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <key>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

`OTLPSpanExporter()` appends `/v1/traces` to `OTEL_EXPORTER_OTLP_ENDPOINT`. `OTLPSpanExporter(endpoint=...)` in code does NOT append; give the full `.../v1/traces` URL there.

### 2c. Tracing module

Create `tracing.py` (or add to the app's existing observability module), imported at the top of the entry point before any `Runner.run`:

```py
from agents import set_trace_processors
from agents.tracing import TracingProcessor
from agents.tracing.span_data import FunctionSpanData, GenerationSpanData, HandoffSpanData
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
    """Fills three gaps in what OpenInference exports. Must run before the OpenInference processor."""

    def on_span_end(self, span):
        data = span.span_data
        current = trace.get_current_span()  # the matching OpenTelemetry span, still open here
        if isinstance(data, FunctionSpanData) and data.input and getattr(current, "name", None) == data.name:
            # Real arguments; OpenInference would copy the tool's JSON schema.
            current.set_attribute("gen_ai.tool.call.arguments", data.input)
        elif isinstance(data, HandoffSpanData) and data.to_agent:
            # Handoff spans carry no tool name.
            current.set_attribute("gen_ai.tool.name", f"transfer_to_{data.to_agent}")
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

- `enable_genai_semconv=True` is REQUIRED. It dual-writes `gen_ai.*` (operation name, `{role, parts}` messages, usage, agent name, tool name/description/result, finish reasons, `gen_ai.conversation.id`). Without it Maple's session page has no transcript for this framework. Env equivalent `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` only works if set before `TraceConfig()` is built.
- `MapleSpanFixes` is required. It runs on each SDK span before the OpenInference processor and fixes three gaps: (1) the dual-write fills `gen_ai.tool.call.arguments` from `tool.parameters`, the tool's JSON schema, so it sets the real arguments first (the dual-write never overwrites a set key); (2) handoff spans get no tool name, so it sets `gen_ai.tool.name=transfer_to_<agent>`; (3) streamed Chat Completions calls (`run_streamed` on `OpenAIChatCompletionsModel`, LiteLLM, any-llm) record their output as a Responses object that OpenInference can't parse, so the streamed reply is missing from the transcript; it rewrites that output into a Chat Completions message. It must be FIRST in the SDK's processor list, hence `set_trace_processors([...])` + `exclusive_processor=False`. Keep the OpenAI dashboard upload too only if the user asks: `set_trace_processors([MapleSpanFixes(), default_processor()])` (`from agents.tracing.processors import default_processor`; needs a valid OpenAI key).

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

Verified with `@openai/agents` 0.18.0, `@arizeai/openinference-instrumentation-openai-agents` 0.2.15, `@opentelemetry/sdk-trace-node` 2.11. Use a `NodeTracerProvider({ resource: detectResources({ detectors: [envDetector] }), spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] })` (`@opentelemetry/resources`, `@opentelemetry/exporter-trace-otlp-proto`; the 2.x provider does NOT read `OTEL_SERVICE_NAME` without `envDetector`, you get `unknown_service:node`), `provider.register()`, then `new OpenAIAgentsInstrumentation({ tracerProvider: provider }).manuallyInstrument(agents)`. Session: wrap each run in `context.with(setAttributes(context.active(), { "gen_ai.conversation.id": conversationId }), () => agents.run(agent, text))` (`setAttributes` from `@arizeai/openinference-core`). Tell the user the limits: framework shows as Unidentified, model replies render as the raw API response JSON (inputs render as messages), no tool arguments/results fields, no agent lanes. `await provider.forceFlush()` before a script exits. Maple ignores `session.id`/`setSession` for this scope.

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
- Set `RunConfig(workflow_name=...)` to name the trace root; the default `Agent workflow` is the same for every run. The name must NOT contain `chat`, `completion` or `tool` (any case): the per-run CHAIN span carries it with no operation, and Maple's name fallback then counts every run as an extra LLM call (`chat`, `completion`) or tool call (`tool`). End it in `workflow` or `agent`.
- Multi-agent fan-out with several `Runner.run` calls: wrap them in one `with trace("<name>")` (from `agents`) inside `using_session`, or each run becomes its own trace/turn.
- Do not set `gen_ai.conversation.id` or `maple_ai.session.id` by hand; the dual-write copies `session.id` to `gen_ai.conversation.id` already.

## Step 4: Content

- Content is ON by default (SDK `trace_include_sensitive_data=True`, OpenInference copies it). With Step 2c, messages land in `gen_ai.input.messages` / `gen_ai.output.messages`. Nothing to enable.
- Content is sent three times per model span (flattened `llm.input_messages.*`, `input.value`, `gen_ai.input.messages`). Expected; don't strip the OpenInference keys, the GenAI ones are derived from them.
- User wants no content / PII-sensitive: `OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA=false` (or `RunConfig(trace_include_sensitive_data=False)`). Tell them: empty transcript, tool error details redacted, tokens/tools/failures remain. Alternative at the bridge: `TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)`.

## Step 5: Tools, errors, sub-agents

- Function tools: span named after the tool, `execute_tool`, `gen_ai.tool.name`, description, arguments (via `MapleSpanFixes`), result. A tool that RAISES: the SDK catches it and the span gets status ERROR with message `Error running tool (non-fatal): {...}`; Maple counts it failed. A tool that RETURNS an error string counts as success; point it out, don't change behavior unasked.
- Give every `Agent` a distinct `name=`. Agent spans carry `gen_ai.agent.name`; Maple draws one lane per name.
- Agents as tools (`agent.as_tool(...)`): nested run appears inside the calling tool span. Nothing to add.
- Handoffs: a `handoff to <agent>` span (counted as a tool call named `transfer_to_<agent>` via `MapleSpanFixes`) and the target agent span as a sibling of the source agent's. Nothing to add.
- `needs_approval=True` tools: the paused run records a tool span without a result, and the resumed run records the executed call again, so Maple shows the tool twice for one approved call. Expected; tell the user.
- Known gaps, don't try to fix: no `gen_ai.tool.call.id` on tool spans; no `gen_ai.response.id` on Chat Completions model spans; no cost.

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

Run one real conversation: 2-3 turns with the same conversation id including one tool call and one streamed turn, plus a second conversation with a different id. Flush. Wait ~1 minute. In Maple **Agent Sessions**, filtered by the service name (or via the Maple MCP `list_agent_sessions` + `get_agent_session`), check:

- [ ] Exactly one session per conversation id; none named `trace:<id>` (that means a run was outside `using_session`).
- [ ] The two conversations are two different sessions.
- [ ] Framework shows **OpenAI Agents SDK** (Python). Unidentified = wrong/old bridge or TypeScript.
- [ ] One turn per `Runner.run`; turn labels are the user messages; root span named after `workflow_name`.
- [ ] Transcript shows instructions, user and assistant messages, tool calls, including the streamed turn's reply (missing there = `MapleSpanFixes` absent or not first). Empty transcript with non-zero tokens = `enable_genai_semconv` not active.
- [ ] Model calls (`generation` for Chat Completions, `response` for Responses API) show the model and non-zero input/output tokens, INCLUDING the streamed turn (zero there = Step 2d missing). LLM call count equals real model calls (higher = `chat`/`completion` in `workflow_name`).
- [ ] Each tool call appears once, with its real name and real arguments (not a JSON schema); a raised tool error is marked failed and nothing else is.
- [ ] Multi-agent: one lane per agent name; all sub-agent spans in one trace with the same session.
- [ ] Each model call appears once (no second `ChatCompletion`-style span from another instrumentor).
- [ ] Cost shows "unpriced" (expected; nothing emits cost).
- [ ] No span attribute contains the model provider API key, `Bearer ` or `sk-`.

Raw span check (optional, e.g. an `InMemorySpanExporter` in a scratch run): model spans have `gen_ai.operation.name=chat`, `gen_ai.input.messages`, `gen_ai.usage.input_tokens`, `session.id`; tool spans have `gen_ai.operation.name=execute_tool`, `gen_ai.tool.call.arguments` equal to the call's arguments; agent spans have `gen_ai.agent.name`.

## Do not

- Do not disable the SDK's tracing (`set_tracing_disabled(True)`, `OPENAI_AGENTS_DISABLE_TRACING`, `tracing_disabled=True`) to stop the OpenAI upload; `set_trace_processors` already removes it.
- Do not omit `TraceConfig(enable_genai_semconv=True)`.
- Do not register `MapleSpanFixes` with `add_trace_processor` or after `instrument()`; it must precede the OpenInference processor.
- Do not put `chat`, `completion` or `tool` in `workflow_name`.
- Do not pass OpenRouter-style model strings (`Agent(model="openai/gpt-4o-mini")`): the SDK strips `openai/` and rejects other prefixes (`Unknown prefix: anthropic`). Use `OpenAIChatCompletionsModel(model=..., openai_client=...)`.
- Do not rely on `group_id`, `trace_metadata` or SDK `Session` ids for the Maple session; use `using_session`.
- Do not generate a fresh session id per request or use a constant.
- Do not stack `openinference-instrumentation-openai`, Logfire, Langfuse, Traceloop or the OTel contrib Agents instrumentation on the same process.
- Do not skip `include_usage=True` for streamed non-OpenAI Chat Completions models.
- Do not create a second `TracerProvider` or call `instrument()` twice.
- Do not use `SimpleSpanProcessor` or a console exporter in servers.
- Do not skip the flush in scripts, notebooks, CLIs and serverless.
