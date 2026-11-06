---
name: maple-agent-tracing-llamaindex
description: "Trace LlamaIndex agents with Maple: OpenInference LlamaIndex instrumentor with GenAI output, a conversation id per chat, agent names and one span per model call, so each conversation is one Maple Agent Session with transcript, tools and tokens. Triggers on 'trace my llamaindex agent', 'add Maple to llamaindex', 'agent sessions for llamaindex', 'OpenTelemetry for llamaindex', 'llama-index observability'."
---

# Maple agent tracing: LlamaIndex (Python)

Goal: every conversation = one Maple Agent Session. Each `agent.run()` / `workflow.run()` = one turn (one trace) with transcript, one model span per model call with tokens, `FunctionTool.acall` tool spans with results, failed tools marked failed, sub-agents in their own lanes.

Mechanism: `openinference-instrumentation-llama-index` (scope `openinference.instrumentation.llama_index`). Maple reads the session (`session.id` from `using_session`), transcript, tokens and tool calls from its spans. `TraceConfig(enable_genai_semconv=True)` is recommended: it also emits standard GenAI attributes (`gen_ai.*`, incl. `gen_ai.conversation.id`).

## Step 0: Detect

1. Versions: `python -c "import llama_index.core as c; print(c.__version__)"` (or `pyproject.toml` / `uv.lock` / `requirements*.txt`).
   - Need llama-index-core >= 0.14.19 (tested 0.14.25). Older: the instrumentor logs `DependencyConflict` and does nothing. Tell the user to upgrade.
   - Python >= 3.10.
2. Existing tracing. Search for `LlamaIndexOpenTelemetry`, `llama_index.observability.otel`, `LlamaIndexInstrumentor`, `set_global_handler`, `TracerProvider(`, `set_tracer_provider`, `opentelemetry-instrument`, `logfire.configure`, `sentry_sdk.init`, `langfuse`, `phoenix.otel.register`.
   - `LlamaIndexOpenTelemetry` (native `llama-index-observability-otel`) present → replace it with Step 2 (it puts content in span events, loses reply and usage on streamed calls, ignores `OTEL_EXPORTER_OTLP_*`). Never run both: every span doubles. Ask before removing if it also feeds another backend.
   - `LlamaIndexInstrumentor` already used (Phoenix/Langfuse/Arize) → keep it, reuse its provider, add `config=TraceConfig(enable_genai_semconv=True)` and the Maple processor to that provider.
   - Another `TracerProvider` exists → add the Maple processor chain to it; do NOT create a second provider.
3. Other instrumentors on the model client (`openinference-instrumentation-openai`, `-litellm`, OpenLLMetry `Traceloop.init`, `logfire.instrument_openai`) → duplicate model spans with their own usage. Remove for LlamaIndex models (ask if they serve other code).
4. Find: every `agent.run(` / `workflow.run(` / `AgentWorkflow(` call, where the chat/thread id lives in the request, every `FunctionAgent(`/`ReActAgent(`/`CodeActAgent(` construction, every tool that runs another agent, every `ctx.wait_for_event(` (HITL).
5. LLM class: `OpenAILike`/`OpenRouter` need `is_function_calling_model=True` or tools silently never run (no tool spans). Check it's set.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention (`.env`, settings module, secret manager) if it has one. Otherwise inline is acceptable: ingest keys are write-only.
- Building the header in code from an env var: when it is unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally. Never raise or exit over the key, and never send `Bearer None` (opaque 401) or hit a bare `KeyError` on import. Or inline the key when the repo has no env convention.
- 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust: keys are region-bound, so it usually belongs to the other region. Try the other endpoint.

Env vars (`OTLPSpanExporter()` reads them and appends `/v1/traces`):

```bash
OTEL_SERVICE_NAME=support-agent
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

If you pass `OTLPSpanExporter(endpoint=...)` in code, it must end in `/v1/traces` (no auto-append).

## Step 2: Install + init

Add with the repo's package manager (uv/poetry/pip):

```bash
pip install "llama-index-core>=0.14.25" "openinference-instrumentation-llama-index>=4.5.2" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Create `tracing.py` verbatim (adapt nothing except where noted):

```py
# tracing.py
from llama_index.core.instrumentation.dispatcher import active_instrument_tags
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.llama_index import LlamaIndexInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

LLM_METHODS = (".chat", ".achat", ".stream_chat", ".astream_chat",
               ".complete", ".acomplete", ".stream_complete", ".astream_complete")


class LlamaIndexForMaple(SpanProcessor):
    """Sits in front of the exporter: one span per model and tool call, agent names, no false HITL failures."""

    def __init__(self, exporter_processor: SpanProcessor):
        self._next = exporter_processor
        self._open_llm_spans = {}

    def on_start(self, span, parent_context=None):
        # instrument_tags({"gen_ai.agent.name": ...}) becomes an attribute, so sub-agents get lanes
        agent_name = active_instrument_tags.get().get("gen_ai.agent.name")
        if agent_name:
            span.set_attribute("gen_ai.agent.name", agent_name)
        if span.name.endswith((".call_tool", ".aggregate_tool_results")):
            # agent workflow steps around the tool span; by name alone Maple would count them as tool calls
            span.set_attribute("gen_ai.operation.name", "invoke_workflow")
        if span.name.endswith(LLM_METHODS):
            self._open_llm_spans[span.context.span_id] = span
        self._next.on_start(span, parent_context)

    def on_end(self, span):
        self._open_llm_spans.pop(span.context.span_id, None)
        if span.name.endswith("._prepare_chat_with_tools"):
            return  # builds the request; never calls the model
        if (span.status.description or "").startswith("WaitingForEvent"):
            return  # ctx.wait_for_event() suspends the tool and replays it later; not a failure
        outer = self._open_llm_spans.get(span.parent.span_id) if span.parent else None
        if outer is not None and outer.name == span.name:
            outer.set_attributes(span.attributes)  # the inner twin holds the messages and usage
            return
        self._next.on_end(span)

    def shutdown(self):
        self._next.shutdown()

    def force_flush(self, timeout_millis=30000):
        return self._next.force_flush(timeout_millis)


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(LlamaIndexForMaple(BatchSpanProcessor(OTLPSpanExporter())))
trace.set_tracer_provider(provider)

LlamaIndexInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

- Import `tracing` first in the entry point (app module, `main.py`, worker). `instrument()` must run before the first `agent.run()`.
- The app loads `.env` (`load_dotenv()`, `--env-file`): call `load_dotenv()` at the top of `tracing.py`, before the provider is built. Otherwise the exporter silently targets `localhost:4318` with no key.
- Existing provider: skip `TracerProvider()`/`set_tracer_provider`; call `existing.add_span_processor(LlamaIndexForMaple(BatchSpanProcessor(OTLPSpanExporter())))` and pass `tracer_provider=existing`.
- The exporter MUST be added through `LlamaIndexForMaple`, never directly: without it every model call counts 2-3x in Maple (`_prepare_chat_with_tools` + nested same-name `astream_chat`/`achat` spans, all OpenInference kind LLM) and every tool call 3x (`call_tool` / `aggregate_tool_results` step spans are classified as tools by name).
- No `service.name` default is acceptable: set `OTEL_SERVICE_NAME` (never `unknown_service`).

## Step 3: Session id (required)

Nothing in LlamaIndex sets a conversation id; `Context` and `llamaindex.run_id` never reach Maple as one. Wrap every `agent.run(...)` / `workflow.run(...)` CALL in `using_session(<app conversation id>)`; add `instrument_tags` with the agent name in the same `with`:

```py
from llama_index.core.agent.workflow import AgentStream
from llama_index.core.instrumentation.dispatcher import instrument_tags
from llama_index.core.workflow import Context
from openinference.instrumentation import using_session

contexts: dict[str, Context] = {}


async def handle_message(conversation_id: str, text: str):
    if conversation_id not in contexts:
        contexts[conversation_id] = Context(agent)
    ctx = contexts[conversation_id]
    with using_session(conversation_id), instrument_tags({"gen_ai.agent.name": agent.name}):
        handler = agent.run(user_msg=text, ctx=ctx)
    async for event in handler.stream_events():
        if isinstance(event, AgentStream):
            yield event.delta
    await handler
```

- Only the `run()` call must be inside the `with` (tasks start there and inherit the contextvars). Consume the stream / `await handler` outside it; do not `yield` inside the `with` in async generators.
- The id must be stable per conversation and unique across conversations: the app's chat/thread id. No `uuid4()` per request, no constant, no module-level default. No id available → ask the user where the conversation boundary is; for a one-shot script, one uuid per conversation reused across its turns.
- One `Context` per conversation (a shared `Context` shares memory across users).
- HITL: keep `handler.ctx.send_event(HumanResponseEvent(...))` on the same handler; the resumed step stays in the same trace and session.
- Do not use `session.id`/`maple_ai.session.id` attributes of your own; `using_session` already writes `session.id` (and `gen_ai.conversation.id` with `enable_genai_semconv`).

## Step 4: Content

- On by default: `gen_ai.input.messages` (system + history + tool results), `gen_ai.output.messages` (incl. tool_call parts), tool results. Maple's transcript needs them.
- User wants content off → `TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)` (or `hide_input_text`/`hide_output_text` to keep structure). Env equivalents `OPENINFERENCE_HIDE_*`. Tell them the transcript will be empty.
- Pattern redaction (emails, cards): recommend an OTel Collector `redaction` processor.

## Step 5: Tools, errors, sub-agents

1. Give every agent a `name=` and wrap each agent's `run()` in `instrument_tags({"gen_ai.agent.name": agent.name})` (the processor copies it onto every span). No tag = no agent facet, no lanes.
2. Multi-agent via custom `Workflow`: run the whole workflow inside `using_session(...)`; inside steps call sub-agents like this:

```py
async def run_agent(agent: FunctionAgent, message: str) -> str:
    with instrument_tags({"gen_ai.agent.name": agent.name}):
        handler = agent.run(user_msg=message)
    return str(await handler)
```

   Parallel fan-out (several `ctx.send_event` calls to separate steps or to a `@step(num_workers=N)`, joined with `ctx.collect_events`) stays in one trace with the session and agent tags.
3. Agents-as-tools: put the same `instrument_tags` block inside the tool function around the sub-agent's `run()`.
4. `AgentWorkflow` handoffs: one `AgentWorkflow.run` span, no per-agent spans, so no lanes; every span carries the root agent's tag and the handoff is a `handoff` tool call. Tag the call with the root agent's name. If the user needs lanes, suggest running agents via workflow steps or tools (ask first; it changes app behavior).
5. Tool failures: a tool that raises → `FunctionTool.acall` status ERROR with the exception message (Maple counts it). Tools that `return "Error: ..."` look successful: convert to `raise` only where the user agrees.
6. HITL (`ctx.wait_for_event`): the first, suspended `FunctionTool.acall` ends ERROR `WaitingForEvent: ...`; the processor drops it. Nothing to add.
7. Known, unfixable here: no `gen_ai.tool.call.id` on tool spans.

## Step 6: Tokens, cost, streaming

- Tokens come from the provider response on the model span. `FunctionAgent` streams by default; OpenAI-API streams only include usage when asked. For `OpenAI`/`OpenAILike` models not on OpenRouter add:

```py
llm = OpenAI(model="gpt-4o-mini", additional_kwargs={"stream_options": {"include_usage": True}})
```

  (LlamaIndex strips it from non-streaming requests.) OpenRouter sends usage without it.
- Streamed model spans end when the stream is handed back (~1 ms), so their duration is not model latency (Maple's session inference time totals a few ms; `FunctionAgent` streams by default, so this is every call). If the app never streams tokens to users, `FunctionAgent(..., streaming=False)` gives real model-span durations. Ask before changing it.
- Cost: never recorded. Sessions show "unpriced". Do not add pricing code. OpenRouter users can add OpenRouter Broadcast for cost.

## Step 7: Flush

- The provider flushes at normal interpreter exit.
- Scripts/CLIs/one-shot jobs: `provider.shutdown()` in a `finally` at the end.
- Serverless handlers, Celery/RQ tasks, notebooks: `provider.force_flush()` in a `finally` after each run (`from tracing import provider`).
- FastAPI/long-running servers: nothing extra; optionally `provider.shutdown()` in the lifespan shutdown.

## Step 8: Verify

Run one real conversation: 2+ messages with the same id, at least one tool call, a failing tool if one exists, and a sub-agent run if the app delegates. No scriptable entry point (server, REPL, UI only) → write a small driver: one conversation id, 2+ turns, at least one tool call, `provider.shutdown()` before exit. Then check (Maple → Agent Sessions, filter by service name; wait ~30-60 s):

- [ ] Exactly one session per conversation, id = the id you passed. A second conversation is a second session. Not `trace:<id>` sessions.
- [ ] One turn per `run()`; each trace roots at `FunctionAgent.run` / `AgentWorkflow.run` / `<YourWorkflow>.run`.
- [ ] Framework shows "LlamaIndex".
- [ ] Transcript shows user messages, assistant replies and tool calls.
- [ ] LLM call count ≈ real number of model calls (one `<ModelClass>.astream_chat`/`.achat` span per call; no `_prepare_chat_with_tools` spans exported).
- [ ] Every model span has a model and input/output tokens, including streamed calls.
- [ ] Tool call count = real tool calls (only `FunctionTool.acall`; `call_tool`/`aggregate_tool_results` carry `gen_ai.operation.name=invoke_workflow`). Tool spans carry `gen_ai.tool.name` (real tool name) and a result; model and tool spans sit under the turn's agent span in the same trace.
- [ ] A failing tool is failed with its message; successful and HITL-approved tools are not.
- [ ] Sub-agents appear as separate lanes with their names, under the caller's session.
- [ ] Cost shows "unpriced".
- [ ] No attribute contains an API key or `Bearer ` token.

Edge cases:

- Native `llama-index-observability-otel` (0.7.0, `LlamaIndexOpenTelemetry`): model settings/prompt only in `LLMChatStartEvent` span events (Maple ignores events); the end event with reply+usage is dropped on streamed calls; two nested `<Model>.astream_chat` spans per call; ignores `OTEL_EXPORTER_OTLP_*` and defaults to `ConsoleSpanExporter` without `span_exporter=`. If a user insists on keeping it and only wants sessions: `instrument_tags({"gen_ai.conversation.id": conversation_id})` around `agent.run()` groups traces (dotted tag keys become span attributes verbatim).
- Span layout the processor fixes: `BaseWorkflowAgent.run_agent_step` → `<Model>._prepare_chat_with_tools` (kind LLM, ~1 ms) + `<Model>.astream_chat` (OpenAILike override) → `<Model>.astream_chat` (inner, holds messages+usage). Classes implementing the call directly (`OpenAI`) produce two spans. Merge only applies to directly nested identical names, so `CondensePlusContextChatEngine.chat` → `OpenAI.chat` is untouched. Tokens were never doubled (only innermost has usage), only call counts.
- `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` is equivalent to the config flag only if set before `TraceConfig` is built.
- Tool spans: `FunctionTool.acall` (kind TOOL, `execute_tool`), result is LlamaIndex `ToolOutput` JSON with `raw_input`/`raw_output` (real args are in `raw_input`). On failure the `call_tool` step stays OK because `FunctionAgent` hands the error to the model.
- Agents-as-tools: a tool span with one `FunctionAgent.run` child shows as a delegation; tool args/result become the lane's input/output. Maple opens a lane for every agent span whose name differs from its caller's.
- Provider: `OpenRouter` and every `OpenAILike` report `openai`, even for Anthropic models. No response model name or `gen_ai.response.id` recorded.
- OpenRouter Broadcast for cost: because model spans lack `gen_ai.response.id`, nest Broadcast spans under them (https://maple.dev/docs/agent-tracing/openrouter#nest-broadcast-under-your-own-traces) or each call counts twice.
- With a persistent `Context` every model span repeats the whole chat. Maple has no per-attribute limit; ingest accepts requests up to 20 MiB.
- Streaming query engines on llama-index-core 0.14.25: the model call of a `StreamingResponse` runs after the query span ended, so it lands in a separate trace. Fix pending in OpenInference PR #3841 (https://github.com/Arize-ai/openinference/pull/3841); until released, pin `llama-index-core<0.14.25` if the app traces streaming query engines. Agents unaffected.

Without Maple access, both must hold: the run exits with no export errors on stderr (`Failed to export`, 401 lines), AND a temporary `SimpleSpanProcessor(ConsoleSpanExporter())` passed into `LlamaIndexForMaple` shows the agent, model and `FunctionTool.acall` spans with `gen_ai.conversation.id` identical on every span of a conversation and `gen_ai.agent.name` set. Silence alone proves nothing (no spans is silent too). With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.
