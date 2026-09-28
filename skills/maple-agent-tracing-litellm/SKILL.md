---
name: maple-agent-tracing-litellm
description: "Trace LiteLLM agents with Maple: export LiteLLM's v2 OpenTelemetry spans (Python SDK or self-hosted LiteLLM Proxy) plus your own agent/tool spans so each conversation is one Maple Agent Session with transcript, tool calls, tokens and optional cost. Triggers on 'trace my litellm agent', 'add Maple to litellm', 'agent sessions for litellm', 'OpenTelemetry for litellm', 'trace the litellm proxy'."
---

# Maple agent tracing: LiteLLM

Goal: every conversation = one Maple Agent Session. Each agent run = one turn (one trace) with transcript, LiteLLM `chat <model>` spans with tokens, `execute_tool` spans with args/results, failed tools marked failed, sub-agents in their own lanes.

Human guide with the reasoning: https://maple.dev/docs/agent-tracing/litellm

Mechanism:
- LiteLLM traces model calls only (scope `litellm`). It has no agent loop, no tool executor, no conversation concept. The app MUST emit `invoke_agent` and `execute_tool` spans itself.
- Use LiteLLM's **v2** OTel logger (`OpenTelemetryV2`). It writes `gen_ai.operation.name=chat`, provider, model, usage, `gen_ai.response.id`, TTFT, `error.type`, and `gen_ai.conversation.id` from `litellm_session_id`. Maple reads `gen_ai.conversation.id` as the session key for LiteLLM.
- The default v1 logger (`litellm.callbacks=["otel"]` without v2) is wrong for Maple: op `acompletion`, no conversation id ever, and under an open parent span it writes onto the (ended) parent and the data is dropped.

## Step 0: Detect

1. Versions: `python -c "import importlib.metadata as m; print(m.version('litellm'), m.version('opentelemetry-api'))"` (or read `pyproject.toml` / lock files).
   - LiteLLM 1.103.x (tested 1.103.0, latest stable on 2026-09-28): OpenTelemetry must be **<= 1.43.0**. On >= 1.44, `from litellm.integrations.otel.logger import OpenTelemetryV2` raises `ModuleNotFoundError: No module named 'opentelemetry._events'`; the `callbacks: ["otel"]` form (proxy) only logs `Error initializing custom logger` and exports nothing. Fixed in LiteLLM 1.104 (1.104.0rc1 verified with OTel 1.45); once 1.104 stable exists, use it and drop the pin.
   - `python -c "from litellm.integrations.otel.logger import OpenTelemetryV2"` must succeed; if the module is missing, upgrade LiteLLM to >= 1.103.
2. Which path:
   - App calls `litellm.acompletion(` / `litellm.completion(` / `Router(` → **SDK path** (Steps 2a-6). `Router.acompletion` is traced like `acompletion` (span name and request model = the router alias, response model = the real model).
   - App calls a LiteLLM Proxy (OpenAI client with `base_url` pointing at the proxy, a `config.yaml` with `model_list`, docker `ghcr.io/berriai/litellm`) → **proxy path** (Step 2b). Only if the user controls the proxy; otherwise tell them and trace in-app with an OpenAI client instrumentor (out of scope here).
3. Sync vs async: grep for `litellm.completion(`, `litellm.text_completion(`, `router.completion(`. The v2 logger traces **async calls only** (`acompletion`, `Router.acompletion`); sync calls produce no span. Convert the agent loop to async where feasible. If the project is sync-only and can't change, use the v1 fallback in Step 2c.
4. Existing OTel: search `TracerProvider(`, `set_tracer_provider`, `opentelemetry-instrument`, `logfire.configure`, `sentry_sdk.init`, `litellm.callbacks`, `success_callback`, `"otel"`, `LITELLM_OTEL_V2`, `OpenAIInstrumentor`, `Traceloop.init`.
   - A `TracerProvider` exists → reuse it (pass it as `tracer_provider=`), add a Maple `BatchSpanProcessor` to it; do NOT create a second one.
   - `"otel"` already in `litellm.callbacks`/`success_callback` → remove it when adding the v2 instance (two loggers = duplicate spans).
   - An OpenAI/LiteLLM client instrumentor (OpenInference `LiteLLMInstrumentor`/`OpenAIInstrumentor`, OpenLLMetry, openai-v2) → duplicates LiteLLM's spans. Keep one; ask before removing.
5. Find: the agent loop (where `acompletion` results' `tool_calls` are executed), every tool function, where the chat/thread/conversation id lives, and any multi-agent orchestration.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention if it has one. Otherwise inline is acceptable: ingest keys are write-only.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <key>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

The Python OTLP exporter appends `/v1/traces` to the base endpoint. If you pass `endpoint=` to `OTLPSpanExporter(...)` in code instead, pass the full `https://ingest.maple.dev/v1/traces`.

## Step 2a: SDK install + init

```bash
pip install "litellm==1.103.0" "opentelemetry-sdk==1.43.0" "opentelemetry-exporter-otlp-proto-http==1.43.0"
```

(LiteLLM >= 1.104: OTel pin can be lifted.) Use the repo's package manager; keep existing litellm extras.

`tracing.py` (adapt service name / environment):

```py
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

import litellm
from litellm.integrations.otel.logger import OpenTelemetryV2
from litellm.integrations.otel.model.config import OpenTelemetryV2Config

provider = TracerProvider(
    resource=Resource.create(
        {"service.name": "support-agent", "deployment.environment.name": "production"}
    )
)
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

litellm.callbacks = [
    OpenTelemetryV2(
        config=OpenTelemetryV2Config(capture_message_content="span_only"),
        tracer_provider=provider,
    )
]

tracer = trace.get_tracer("support-agent")
```

- Import it first in the entry point, before the first model call.
- Passing the instance: no `LITELLM_OTEL_V2` env needed, LiteLLM builds no provider/exporter of its own.
- If the project appends to `litellm.callbacks` elsewhere (other loggers), append the instance instead of overwriting the list.
- Set a real `service.name`.

## Step 2b: Proxy path (self-hosted LiteLLM Proxy)

Proxy `config.yaml`: add `litellm_settings: { callbacks: ["otel"] }` (merge with existing callbacks). Proxy environment:

```bash
LITELLM_OTEL_V2=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=litellm-proxy
OTEL_ENVIRONMENT_NAME=production
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only
```

- Docker image `ghcr.io/berriai/litellm` ships OTel 1.28 + FastAPI instrumentation: fine. pip-installed proxy on 1.103: `pip install "litellm[proxy]==1.103.0" "opentelemetry-sdk==1.43.0" "opentelemetry-exporter-otlp-proto-http==1.43.0" "opentelemetry-instrumentation-fastapi==0.64b0"`, run `litellm --config config.yaml`. The FastAPI instrumentation is what continues the app's `traceparent`.
- App side: keep Step 3-5 spans (`agent_span`, `run_tool`), do NOT register the LiteLLM logger in the app, and on every request to the proxy send `traceparent` (so proxy spans join the app trace under `invoke_agent`) and `x-litellm-session-id` (becomes `gen_ai.conversation.id`):

```py
import os

from openai import AsyncOpenAI
from opentelemetry import propagate

client = AsyncOpenAI(base_url="http://localhost:4000", api_key=os.environ["LITELLM_API_KEY"])


async def call_model(conversation_id: str, messages: list, tools: list | None):
    headers = {"x-litellm-session-id": conversation_id}
    propagate.inject(headers)  # must run inside the agent span
    return await client.chat.completions.create(
        model="gpt-4o-mini", messages=messages, tools=tools, extra_headers=headers
    )
```

- Alternative session carrier: body `metadata: {"session_id": ...}` (`extra_body={"metadata": {...}}`), verified.
- Resulting tree per request: `invoke_agent` → `POST /chat/completions` (proxy FastAPI server span) → `chat <model>` + `auth /chat/completions`. Known Maple limitation: the `auth /chat/completions` span is counted as an extra LLM call (litellm scope + "chat" in the name), so LLM call counts double on the proxy path in the sessions list; the session detail page also counts the FastAPI `POST /chat/completions` span (it carries `gen_ai.request.model`), so it shows 3x. Tokens, cost, transcript and sessions are correct. Tell the user; nothing to fix app-side.
- Never also instrument the app's OpenAI client when the proxy traces: double LLM calls and tokens. Pick gateway OR in-app.
- Do not set `OTEL_IGNORE_CONTEXT_PROPAGATION=true` on the proxy.

## Step 2c: Sync-only fallback (v1, only if Step 0.3 says so)

`litellm.callbacks = ["otel"]` after `trace.set_tracer_provider(provider)` (v1 reuses the global SDK provider), plus env `USE_OTEL_LITELLM_REQUEST_SPAN=true` and `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`. v1 has no conversation id: set `gen_ai.conversation.id` on each `invoke_agent` span. Consequence: framework shows **Unidentified** in Maple; tell the user. v1 content is on by default.

## Step 3: Agent loop spans + session id (required)

Wrap each agent run in `invoke_agent` and pass `litellm_session_id=` on EVERY `acompletion`: (imports: `asyncio`, `inspect`, `json`, `contextlib.contextmanager`, `opentelemetry.trace.StatusCode`, `tracer` from `tracing.py`):

```py
@contextmanager
def agent_span(name: str):
    with tracer.start_as_current_span(f"invoke_agent {name}") as span:
        span.set_attribute("gen_ai.operation.name", "invoke_agent")
        span.set_attribute("gen_ai.agent.name", name)
        yield span


async def run_agent(agent: Agent, conversation_id: str, messages: list) -> str:
    with agent_span(agent.name):
        while True:
            response = await litellm.acompletion(
                model=agent.model,
                messages=[{"role": "system", "content": agent.instructions}, *messages],
                tools=agent.schemas or None,
                litellm_session_id=conversation_id,
            )
            message = response.choices[0].message
            messages.append(message.model_dump(exclude_none=True))
            if not message.tool_calls:
                return message.content or ""
            results = await asyncio.gather(*(run_tool(agent, call) for call in message.tool_calls))
            for call, output in zip(message.tool_calls, results):
                messages.append({"role": "tool", "tool_call_id": call.id, "content": output})
```

- Adapt to the project's existing loop; don't rewrite it into this shape if it already has one. What matters: one `invoke_agent` span per agent run, all model calls and tool calls inside it, `litellm_session_id=` on every call (`metadata={"session_id": ...}` also works when the project already passes metadata).
- Id: the app's chat/thread/conversation id. Stable per conversation, unique across conversations. No process-wide constants, no `uuid4()` per request. Single-shot script: one uuid per conversation, reused.
- Do NOT put `gen_ai.conversation.id` or `maple_ai.session.id` on your own spans in the v2 setup: Maple labels the session with the vendor of the earliest session-bearing span, so the session would show **Unidentified**. LiteLLM's `chat` spans carrying the id is enough (Maple groups whole traces).
- Streaming: `stream=True, stream_options={"include_usage": True}`, and consume the stream inside `agent_span`; LiteLLM closes its span when the stream ends.

## Step 4: Content

- v2 default is `no_content`. `capture_message_content="span_only"` (or env `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only`) puts `gen_ai.input.messages` / `gen_ai.output.messages` JSON on `chat` spans. Maple's transcript needs them.
- Never `event_only` / `span_and_event` for Maple: events are not read.
- Messages are OpenAI chat format (`{role, content, tool_calls}`). Maple's transcript ignores `tool_calls` inside messages: a call that only requested tools shows an empty reply, and tool calls render only from `execute_tool` spans (Step 5). So the `execute_tool` spans are required for tool calls to appear at all.
- User wants content off → `no_content` + drop the tool args/result attributes in `run_tool`. `litellm.turn_off_message_logging = True` keeps structure but replaces text with `redacted-by-litellm`.

## Step 5: Tools, errors, sub-agents

```py
async def run_tool(agent: Agent, call) -> str:
    name = call.function.name
    with tracer.start_as_current_span(f"execute_tool {name}") as span:
        span.set_attribute("gen_ai.operation.name", "execute_tool")
        span.set_attribute("gen_ai.tool.name", name)
        span.set_attribute("gen_ai.tool.call.id", call.id)
        span.set_attribute("gen_ai.tool.call.arguments", call.function.arguments)
        try:
            result = agent.tools[name](**json.loads(call.function.arguments or "{}"))
            if inspect.isawaitable(result):  # async tools and sub-agents
                result = await result
        except Exception as exc:
            span.set_status(StatusCode.ERROR, str(exc))
            span.set_attribute("error.type", type(exc).__name__)
            result = {"error": str(exc)}
        output = json.dumps(result)
        span.set_attribute("gen_ai.tool.call.result", output)
        return output
```

- Real tool name in `gen_ai.tool.name`, the model's `call.id` in `gen_ai.tool.call.id`. Async tools are awaited inside the span (the `isawaitable` branch).
- Tool failure: ERROR status + `error.type` on the tool span; the model still gets an error payload. Where the existing loop swallows exceptions into strings, add the status/`error.type` there (don't change what the model sees unless asked).
- LiteLLM marks failed model calls ERROR + `error.type` itself.
- Multi-agent: each agent its own `name` (→ `gen_ai.agent.name`, one lane each). Same `conversation_id` to every `run_agent`.
  - Agents as tools (verified): the orchestrator's tool functions are `async def call(task): return await run_agent(worker, conversation_id, [{"role": "user", "content": task}])`. Each renders as `execute_tool <worker>` → `invoke_agent <worker>` (a delegation lane); parallel tool calls run in parallel via the `gather`.
  - Code-driven orchestration: run workers inside an outer `agent_span("orchestrator")` so the whole run is one trace; `asyncio.gather` keeps context.
- Thread pools (`run_in_executor`, `ThreadPoolExecutor`) lose OTel context: wrap with `contextvars.copy_context().run`.

## Step 6: Cost (optional) and flush

Cost: Maple reads `gen_ai.usage.cost` (also `gen_ai.usage.total_cost`, `llm.cost.total`), never `litellm.cost.total`; LiteLLM writes `litellm.cost.total` (v2) / `hidden_params` (v1) → unpriced by default. If the user wants cost, report the TURN total on the OUTERMOST agent span only. Maple subtracts a descendant's reported cost from its nearest cost-reporting ancestor, so cost on every nested `invoke_agent` undercounts the orchestrator. Replace `agent_span`:

```py
from contextvars import ContextVar

turn_costs: ContextVar[list | None] = ContextVar("turn_costs", default=None)


@contextmanager
def agent_span(name: str):
    with tracer.start_as_current_span(f"invoke_agent {name}") as span:
        span.set_attribute("gen_ai.operation.name", "invoke_agent")
        span.set_attribute("gen_ai.agent.name", name)
        if turn_costs.get() is not None:  # a sub-agent: the outermost agent reports the cost
            yield span
            return
        costs: list[float] = []
        token = turn_costs.set(costs)
        try:
            yield span
        finally:
            turn_costs.reset(token)
            span.set_attribute("gen_ai.usage.cost", sum(costs))
```

- After each non-stream `acompletion`: `turn_costs.get().append(response._hidden_params.get("response_cost") or 0.0)`.
- Stream: keep `cost = getattr(chunk.usage, "cost", None) or cost` for chunks whose `usage` is not None, append `cost` once after the loop.
- Session and turn totals are then exact (verified: equals the sum of `litellm.cost.total`); per-model breakdown stays unpriced. Never add token pricing tables.

Flush (required for scripts, CLIs, Lambda/Cloud Run jobs, notebooks, workers; web servers only at shutdown). LiteLLM creates its span after the call via a background queue that drains at interpreter exit, after the provider shut down, so the last call is lost without this:

```py
from litellm.litellm_core_utils.logging_worker import GLOBAL_LOGGING_WORKER


async def flush_tracing() -> None:
    await asyncio.sleep(0)  # LiteLLM queues its log event on the next loop tick
    await GLOBAL_LOGGING_WORKER.flush()
    provider.force_flush()
```

Await it in a `finally` inside the event loop (end of `main()`, end of each handler invocation, FastAPI lifespan shutdown); scripts then call `provider.shutdown()` after `asyncio.run(...)`.

## Step 7: Verify

Run one real conversation: 2+ messages with the same id, one tool call, one streamed reply if the app streams, a failing tool if one exists, a second conversation with a different id, and a multi-agent run if the app has one. Check (Maple → Agent Sessions, filter by service; wait ~30 s):

- [ ] Exactly one session per conversation, session id = the id passed; the second conversation is a separate session; no `trace:<id>` sessions.
- [ ] Framework shows **LiteLLM** (not Unidentified).
- [ ] One turn per top-level `invoke_agent`; transcript shows user prompts, assistant replies and tool calls (tool rows come from `execute_tool` spans; a tool-only model reply shows empty, expected).
- [ ] Spans: `invoke_agent <name>` (app scope), `chat <model>` (scope `litellm`) and `execute_tool <tool>` inside it, same trace. No `litellm_request` / `raw_gen_ai_request` spans (those mean v1).
- [ ] Every `chat` span has input and output tokens, including the streamed one; no call appears twice.
- [ ] Tool spans have real names, arguments, results and call ids.
- [ ] The failing tool is marked failed with its message; successful tools and model calls are not.
- [ ] Sub-agents appear as separate lanes, all in the caller's session.
- [ ] Cost: unpriced, or (Step 6) `gen_ai.usage.cost` only on top-level `invoke_agent` spans, equal to the sum of the turn's `litellm.cost.total`.
- [ ] Last call of a script run present (flush worked).
- [ ] No attribute contains an API key, `Bearer ` or `sk-`.
- [ ] Proxy path: `chat` spans (service `litellm-proxy`) sit in the app's trace under `invoke_agent` → `POST /chat/completions`, carrying the session id. LLM call count shows 2x in the list, 3x on the session page (auth + FastAPI spans, known).

Local check without Maple: temporarily add `SimpleSpanProcessor(ConsoleSpanExporter())` to the provider and confirm `gen_ai.conversation.id` on every `chat` span and the parent ids.

## Do not

- Do not use the v1 logger (`litellm.callbacks=["otel"]` alone) when async is possible: no session key, op `acompletion`, attributes lost under parent spans.
- Do not run LiteLLM 1.103 with OpenTelemetry >= 1.44 (v2 silently disabled).
- Do not register two loggers (v2 instance plus `"otel"` / `LITELLM_OTEL_V2` factory) in one process.
- Do not trace the same call at the proxy and in the app (client instrumentor): double counting.
- Do not rely on sync `litellm.completion()` under v2: no span.
- Do not put `gen_ai.conversation.id` / `maple_ai.session.id` on your own spans in the v2 setup.
- Do not use `event_only` content capture.
- Do not skip the flush in short-lived processes.
- Do not create a second `TracerProvider` when one exists.
- Do not promise cost without the Step 6 recipe; do not add token pricing code; do not put `gen_ai.usage.cost` on nested agent spans.
- Do not print or commit real keys beyond the repo's convention.
