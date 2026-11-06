---
name: maple-agent-tracing-langchain
description: "Trace LangChain and LangGraph agents (Python, and LangChain.js / LangGraph.js in TypeScript) with Maple: export OpenInference LangChain spans with GenAI attributes so each thread is one Maple Agent Session with transcript, tool calls, sub-agent lanes and tokens. Triggers on 'trace my langchain agent', 'trace my langgraph agent', 'add Maple to langchain', 'add Maple to langgraph', 'agent sessions for langchain', 'OpenTelemetry for langgraph', 'trace langchain.js', 'trace langgraph.js', 'createAgent tracing'."
---

# Maple agent tracing: LangChain & LangGraph (Python and TypeScript)

Goal: every conversation = one Maple Agent Session. Each `invoke()`/`stream()` = one turn (one trace) with a readable transcript, chat model spans with tokens, tool spans with names/results, failed tools marked failed, sub-agents in their own lanes.

Mechanism: `openinference-instrumentation-langchain` (scope `openinference.instrumentation.langchain`). Maple groups sessions by the run's `thread_id` and reads transcript, tokens and tool calls from its spans. `TraceConfig(enable_genai_semconv=True)` is recommended: it also emits standard GenAI attributes (`gen_ai.conversation.id` from run metadata `session_id` > `conversation_id` > `thread_id`, `gen_ai.input/output.messages` in `{role, parts}` form).

**TypeScript / JavaScript (LangChain.js, LangGraph.js):** the JS instrumentor has no GenAI dual-write, so the setup adds a small span processor. Do Step 1 below for the key and region, then follow [references/typescript.md](references/typescript.md) instead of Steps 2-7. A repo with both Python and TS agents gets both setups.

## Step 0: Detect

0. Language: `package.json` depending on `langchain`, `@langchain/core` or `@langchain/langgraph` → TypeScript, see [references/typescript.md](references/typescript.md) (after Step 1). Python files importing `langchain`/`langgraph` → continue here.
1. Versions: `python -c "import langchain, langgraph, langchain_core; print(langchain.__version__, langchain_core.__version__)"` and `pip show langgraph` (or read `pyproject.toml` / `uv.lock` / `requirements*.txt`). Tested: langchain 1.4.2, langgraph 1.2.12, langchain-core 1.6.5, langchain-openai 1.6.6, Python 3.12. Python must be >= 3.10.
2. Existing OTel setup. Search for `TracerProvider(`, `set_tracer_provider`, `logfire.configure`, `sentry_sdk.init`, `opentelemetry-instrument`, `Traceloop.init`, `LangChainInstrumentor`, `OpenAIInstrumentor`, `LANGSMITH_OTEL_ENABLED`, `LANGSMITH_TRACING_MODE`.
   - A `TracerProvider` exists → add the processors from Step 2 to it; do NOT create a second provider.
   - `LANGSMITH_OTEL_ENABLED`/`LANGSMITH_TRACING_MODE=otel` set → it duplicates every run. Ask the user; remove it for Maple (plain `LANGSMITH_TRACING=true` to LangSmith cloud is fine to keep).
   - OpenAI/Anthropic OpenInference instrumentors or OpenLLMetry LangChain instrumentor → duplicate model spans. Ask before removing if they serve something else.
3. Find: every `create_agent(`, `create_react_agent(`, `StateGraph(`/`.compile(`, every `.invoke(`/`.ainvoke(`/`.stream(`/`.astream(`/`Command(resume=` call on an agent/graph/chain, where the app's chat/thread id lives, every `ChatOpenAI(` (note `base_url`) and `init_chat_model(` / `"openai:..."` model string, and every tool that invokes another agent.
4. LangGraph Server (`langgraph.json` present): `import tracing` at the top of the module(s) `langgraph.json`'s `graphs` points to (the dir holding `tracing.py` must be in `dependencies`); `OTEL_*` env goes in the server env file/container. Server threads already carry `configurable.thread_id`: one Maple session per thread, no code.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention (`.env`, settings module, secret manager) if it has one. Otherwise inline is acceptable: ingest keys are write-only.
- Building the header in code from an env var: when it is unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally. Never raise, throw or exit over the key, and never send `Bearer None` / `Bearer undefined` (opaque 401) or hit a bare `KeyError` on import. Or inline the key when the repo has no env convention.
- 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust: keys are region-bound, so it usually belongs to the other region. Try the other endpoint.

Env vars (`OTLPSpanExporter()` with no args reads them and appends `/v1/traces`):

```bash
OTEL_SERVICE_NAME=<service>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
```

If you pass `OTLPSpanExporter(endpoint=...)` in code, it must end in `/v1/traces` (used verbatim).

## Step 2: Install + init

Add with the repo's package manager (uv/poetry/pip):

```bash
pip install "openinference-instrumentation-langchain>=0.1.76" "openinference-instrumentation>=0.1.66" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Pin `openinference-instrumentation>=0.1.66` explicitly (the langchain instrumentor allows 0.1.61, which may lack the GenAI dual-write).

Create `tracing.py`:

```py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.langchain import LangChainInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

# The name= of every create_agent(), and graph nodes that act as agents
AGENT_NAMES = {"assistant"}
# LangGraph's tool node: a step, not a tool call
STEP_NAMES = {"tools"}


class AgentSpans(SpanProcessor):
    """Names your agents' spans for Maple (one lane per agent) and marks STEP_NAMES as steps, so Maple doesn't count them as tool calls by name."""

    def on_start(self, span, parent_context=None):
        """Mark agent and step spans at start; the GenAI dual-write at span end keeps these values."""
        if span.instrumentation_scope.name != "openinference.instrumentation.langchain":
            return
        if span.name in AGENT_NAMES:
            span.set_attribute("gen_ai.operation.name", "invoke_agent")
            span.set_attribute("gen_ai.agent.name", span.name)
        elif span.name in STEP_NAMES:
            span.set_attribute("gen_ai.operation.name", "invoke_workflow")


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(AgentSpans())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

LangChainInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

- Import `tracing` first in the entry point (app module, `main.py`, worker, LangGraph Server graph module). It must run before the first `invoke()`.
- The app loads `.env` (`load_dotenv()`, `--env-file`): call `load_dotenv()` at the top of `tracing.py`, before the provider is built. Otherwise the exporter silently targets `localhost:4318` with no key.
- Fill `AGENT_NAMES` with every agent's `name=` from Step 0.3. Give unnamed `create_agent(...)` calls a `name=` (default graph name is `LangGraph`).
- `STEP_NAMES`: `tools` is the tool node of `create_agent` and the usual `ToolNode` name. Add every other graph node whose name contains `tool` (e.g. `add_node("run_tools", ToolNode(...))`); Maple counts unmarked ones as extra tool calls. Other node names (`call_model`, `route_*`) don't matter. Never add real tool names.
- Existing provider: add `AgentSpans()` and the `BatchSpanProcessor(OTLPSpanExporter())` to it and pass it as `tracer_provider=`.
- Set a real `service.name` (never `unknown_service`).
- Streaming with `ChatOpenAI(base_url=...)` or `OPENAI_BASE_URL` set: add `stream_usage=True` to the `ChatOpenAI(...)` constructor; with `init_chat_model(..., model_provider="openai")` or an `"openai:..."` string, pass `stream_usage=True` as a kwarg (Anthropic/Fireworks chat models accept it too). ChatOpenAI only requests streamed usage from api.openai.com; servers that don't send it unasked (vLLM, many gateways) give streamed calls no tokens. OpenRouter sends it anyway; set it regardless. (Python; JS requests streamed usage by default.)

## Step 3: Session id (required)

Pass the app's conversation id as `thread_id` on EVERY agent/graph call, including streams and HITL resumes:

```py
result = agent.invoke(
    {"messages": [{"role": "user", "content": text}]},
    {"configurable": {"thread_id": conversation_id}},
)
```

```py
agent.invoke(Command(resume={"decisions": [{"type": "approve"}]}), {"configurable": {"thread_id": conversation_id}})
```

- Works with or without a checkpointer (LangGraph copies `configurable.thread_id` into run metadata). If the graph already uses a checkpointer, reuse its existing `thread_id`; don't invent a second id.
- `thread_id` groups turns in Maple; it doesn't give the agent memory. With no checkpointer, pass the prior `result["messages"]` into the next call yourself, or add `InMemorySaver`/`MemorySaver`.
- Plain LangChain chains (`prompt | model`, no graph) do NOT copy `configurable`: pass `{"metadata": {"thread_id": conversation_id}}` instead.
- Nested runs (agents called inside tools or nodes) inherit it; don't pass a different id to them.
- The id must be stable per conversation and unique across conversations: no constants, no `uuid4()` per request. No id in the app → ask where the conversation boundary is; single-shot script → one uuid per conversation, reused.
- Do not set `session.id`/`gen_ai.conversation.id`/`maple_ai.session.id` by hand.

## Step 4: Content

- On by default: `gen_ai.input.messages` / `gen_ai.output.messages` (system prompt included as the first input message) on chat model spans; `gen_ai.tool.call.result` on tool spans. Maple's transcript needs these.
- User wants content off → `TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)` (or `OPENINFERENCE_HIDE_INPUTS=true` / `OPENINFERENCE_HIDE_OUTPUTS=true`). The gen_ai copies are built from masked values, so they're empty too. Tell them the transcript will be empty; turns, tools, tokens and failures remain.
- Narrower: `hide_input_text`, `hide_output_text`. Pattern redaction → OTel Collector `redaction` processor.

## Step 5: Tools, errors, sub-agents

1. Tool exceptions mark the tool span ERROR with the message automatically. `create_agent` re-raises them and aborts the run; if the app should continue, add (ask the user if behaviour changes matter):

```py
from langchain.agents.middleware import wrap_tool_call
from langchain_core.messages import ToolMessage


@wrap_tool_call
def tool_errors_to_model(request, handler):
    try:
        return handler(request)
    except Exception as e:
        return ToolMessage(content=f"Tool error: {e}", tool_call_id=request.tool_call["id"], status="error")
```

   and `middleware=[tool_errors_to_model, ...]` on `create_agent`. For `ToolNode` in a `StateGraph`: `ToolNode(tools, handle_tool_errors=True)`. The tool span stays ERROR either way.
   - Tools that `return "Error: ..."` show as successful calls. Prefer raising, where the user agrees.
2. Interrupts (`interrupt()`, `HumanInTheLoopMiddleware`) end with status OK; the resume is a new trace in the same session (same `thread_id`).
3. Sub-agents: give each a unique `name=` and add it to `AGENT_NAMES`. Agent-as-tool pattern:

```py
weather_worker = create_agent(model, tools=[get_weather], name="weather_worker")


@tool
def ask_weather_worker(city: str) -> str:
    """Ask the weather worker for the current weather in a city."""
    result = weather_worker.invoke({"messages": [{"role": "user", "content": f"Weather in {city}?"}]})
    return result["messages"][-1].content
```

   The nested run inherits the caller's trace and `thread_id`. For `StateGraph` workers as nodes, add the node names to `AGENT_NAMES`.
4. Never put "agent" in a tool name (`ask_weather_agent`): OpenInference then marks the span AGENT, and it stops counting as a tool call.
5. Python 3.10 + async: pass the node's `config` to nested `ainvoke()` calls. Own thread pools: `from langchain_core.runnables.config import ContextThreadPoolExecutor`.

## Step 6: Flush

- `BatchSpanProcessor` exports every 5 s; the SDK flushes at normal interpreter exit. Long-running servers (incl. LangGraph Server) need nothing.
- AWS Lambda / Cloud Functions / Cloud Run jobs: `provider.force_flush()` in a `finally` in the handler.
- Scripts, CLIs, one-shot jobs: `provider.shutdown()` at the end (`finally`).
- Celery/RQ workers, notebooks: `provider.force_flush()` after each task/cell that runs an agent.

## Step 7: Verify

Run one real conversation: 2+ messages with the same id, at least one tool call, one streamed message if the app streams, a sub-agent call if the app delegates. No scriptable entry point (server, REPL, UI only) → write a small driver: one conversation id, 2+ turns, at least one tool call, `provider.shutdown()` before exit. Then check (Maple → Agent Sessions, filter by service name; wait up to ~1 min):

- [ ] Exactly one session per conversation, id = the `thread_id` you passed. A second conversation is a different session.
- [ ] One turn per `invoke()`; transcript shows each turn's user message, assistant replies, tool calls (not a raw JSON blob).
- [ ] Each turn trace starts at the agent span (`name=`), with `model`/`tools` node spans, `ChatOpenAI` (or other chat model class) spans and tool spans named after the tools, all in one trace.
- [ ] Tool call count = the tools the model actually called (a higher count means a tool node is missing from `STEP_NAMES`).
- [ ] Every chat model span has input and output tokens, including the streamed one.
- [ ] A failing tool is marked failed with its message; successful tools and interrupts are not.
- [ ] Sub-agents appear as separate lanes, all in the caller's session.
- [ ] Cost shows "unpriced" (expected: nothing records cost).
- [ ] No attribute contains an API key or `Bearer ` token.

Known gaps (not setup bugs, don't try to fix): tool spans have no `gen_ai.tool.call.id`; chat model spans have no `gen_ai.response.id`.

More details (edge cases):

- `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` is equivalent to `enable_genai_semconv=True`, only if set before `TraceConfig` is built. The dual-write happens at span end and never overwrites a key already set (so `AgentSpans` values win).
- Why `AgentSpans`: the instrumentor marks a span AGENT only when its name contains "agent" (`name="support_agent"` yes, `name="assistant"` no) and never sets `gen_ai.agent.name`. Spans with no operation are classified by name, so the `tools` node counts as a tool call unless marked `invoke_workflow`.
- Provider comes from the LangChain integration: `ChatOpenAI` reports `openai` even for an Anthropic model behind OpenRouter or another OpenAI-compatible gateway.
- Tool spans lack `gen_ai.tool.call.id`, so Maple matches them to the model's tool calls by name; a reply that calls the same tool twice can mismatch.
- With a checkpointer every model span repeats the whole history. Maple has no per-attribute limit; ingest accepts requests up to 20 MiB.
- HITL: the pause ends the turn's trace; the resume is a new trace, so an approved action shows as two turns in one session (shared `thread_id` is what joins them).
- LangGraph Server verified with `langgraph dev` (langgraph-api 0.10.3).
- LangSmith OTel export (`LANGSMITH_OTEL_ENABLED` + `LANGSMITH_OTEL_ONLY`, tested langsmith 0.14.1): Maple labels it "LangChain" and reads `langsmith.metadata.thread_id`, but prompts/completions arrive as byte attributes (hex, unreadable transcript, no turn labels), interrupts are marked ERROR, agent names only in `langsmith.metadata.lc_agent_name` (unread; LangSmith sets `gen_ai.operation.name` after start so a start-time processor can't fix it), and flush needs `wait_for_all_tracers()` (`langchain_core.tracers.langchain`) then `provider.force_flush()`. Don't recommend it.

Without Maple access, both must hold: the run exits with no export errors on stderr (`Failed to export`, 401 lines), AND a temporary `SimpleSpanProcessor(ConsoleSpanExporter())` shows the agent, chat model and tool spans with `gen_ai.conversation.id` identical on every span of every turn. Silence alone proves nothing (no spans is silent too). With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.
