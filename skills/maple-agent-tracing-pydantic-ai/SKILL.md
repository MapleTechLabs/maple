---
name: maple-agent-tracing-pydantic-ai
description: "Trace Pydantic AI agents with Maple: export Pydantic AI's built-in OpenTelemetry spans (with or without Logfire) so each conversation is one Maple Agent Session with transcript, tool calls, sub-agent lanes and tokens. Triggers on 'trace my pydantic ai agent', 'add Maple to pydantic ai', 'agent sessions for pydantic ai', 'OpenTelemetry for pydantic ai'."
---

# Maple agent tracing: Pydantic AI

Goal: every conversation = one Maple Agent Session. Each `agent.run()` = one turn (one trace) with transcript, `chat` spans with tokens, `execute_tool` spans with args/results, failed tools marked failed, sub-agents in their own lanes.

Mechanism: Pydantic AI's native OTel instrumentation (scope `pydantic-ai`, GenAI semconv on span attributes). No extra instrumentation package. Maple reads `gen_ai.conversation.id` as the session key for this framework.

## Step 0: Detect

1. Pydantic AI version: `python -c "import pydantic_ai; print(pydantic_ai.__version__)"` (or read `pyproject.toml` / `uv.lock` / `requirements*.txt`).
   - Need 2.x (tested 2.51.0). 1.x has no `conversation_id=`: tell the user to upgrade; do not work around it.
   - `ToolFailed` needs >= 2.16.
2. Existing OTel setup. Search for `TracerProvider(`, `set_tracer_provider`, `logfire.configure`, `opentelemetry-instrument`, `sentry_sdk.init`, `instrument_all`, `Instrumentation(`, `.instrument =`.
   - Logfire already configured → use the Logfire path (Step 2b).
   - Another `TracerProvider` exists → add a `BatchSpanProcessor(OTLPSpanExporter())` to it; do NOT create a second provider.
   - Nothing → Step 2a.
3. Find: every `agent.run(` / `run_sync(` / `run_stream(` / `iter(` call, where the chat/thread id lives in the request, every `Agent(` construction, and every tool that calls another agent's `run()`.
4. Other instrumentors on the same model client (`logfire.instrument_openai`, `OpenAIInstrumentor`, OpenLLMetry `Traceloop.init`, a global `logfire.instrument_httpx()`) → they double-trace model calls. Keep Pydantic AI's; ask before removing the others if they serve something else. `logfire.instrument_httpx(client)` on a non-model client (tool HTTP calls) is fine to keep.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention (`.env`, settings module, secret manager) if it has one. Otherwise inline is acceptable: ingest keys are write-only.
- Key read from a secret env var in code: when it is unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally. Never raise or exit over the key; no bare `KeyError` on import, no header without a key.
- A 401 `ingest_unauthorized` ("Invalid ingest key") with a key you trust usually means the key belongs to the other region (keys are region-bound): try the other endpoint.

Env vars (the exporter reads them when it is built; it appends `/v1/traces`). If the app loads `.env` (`load_dotenv()`), call it at the top of the tracing module, before the exporter or `logfire.configure()`; otherwise the exporter silently targets `localhost:4318` with no key.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

## Step 2a: Install + init (plain OpenTelemetry, default)

Add with the repo's package manager (uv/poetry/pip):

```bash
pip install "pydantic-ai-slim[openai]>=2.51" "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Keep the project's existing pydantic-ai extras; only add the two OTel packages if pydantic-ai is already installed.

Create `tracing.py` (adapt service name / environment to the project):

```py
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from pydantic_ai import Agent, InstrumentationSettings

provider = TracerProvider(
    resource=Resource.create(
        {"service.name": "support-agent", "deployment.environment.name": "production"}
    )
)
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

Agent.instrument_all(
    InstrumentationSettings(
        tracer_provider=provider,
        include_content=True,
        include_binary_content=False,
    )
)
```

- Import it first in the entry point (app module, `main.py`, worker). It must run before the first `agent.run()`; agents constructed earlier are still covered.
- Existing provider: skip creating one; add the processor to it and call `Agent.instrument_all(InstrumentationSettings(include_content=True, include_binary_content=False))` (uses the global provider).
- Do not pass `version=`. Default 5 is the tested format; 2-4 are deprecated.
- Set a real `service.name` (never leave `unknown_service`).

## Step 2b: Logfire path (only if the project already uses Logfire)

Keep the Step 1 env vars; they must be in `os.environ` before `logfire.configure()` runs. Logfire then adds OTLP span, metric and log exporters for this endpoint; pass `metrics=False` to `logfire.configure()` if only traces are wanted.

Do not install the Step 2a OTel packages: `logfire` already depends on the SDK and the OTLP/HTTP exporter, and logfire 5.1.x pins `opentelemetry-sdk<1.45`, so adding `opentelemetry-sdk>=1.45` makes the install unresolvable. Tested with logfire 5.1.1 (OTel SDK 1.44.0).

```py
import logfire

TOOL_CONTENT = {"gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "final_result"}


def keep_tool_content(match: logfire.ScrubMatch):
    if len(match.path) > 1 and match.path[1] in TOOL_CONTENT:
        return match.value


logfire.configure(
    service_name="support-agent",
    environment="production",  # adapt to the project
    send_to_logfire=False,  # keep the project's existing value as is (incl. 'if-token-present'); False only if unset
    scrubbing=logfire.ScrubbingOptions(callback=keep_tool_content),
)
logfire.instrument_pydantic_ai()
```

- Default scrubbing replaces tool args/results containing `session`, `auth`, `password`, `cookie`, `secret`, `api key`... with `[Scrubbed due to '<word>']`. `gen_ai.conversation.id` and message attributes are exempt. If the project already has a scrubbing config, merge the callback into it instead of replacing it.
- Do not also call `Agent.instrument_all(...)` with another provider.

## Step 3: Session id (required)

Pydantic AI resolves `gen_ai.conversation.id` per run as: explicit `conversation_id=` > id on the last message of `message_history` > fresh UUID7. Pass it explicitly on EVERY run call, from the app's chat/thread/conversation id:

```py
result = await agent.run(text, conversation_id=chat_id, message_history=history)
```

```py
async with agent.run_stream(text, conversation_id=chat_id, message_history=history) as run:
    async for delta in run.stream_text(delta=True):
        yield delta
```

- Same for `run_sync(`, `iter(`, `run_stream_events(`, and the resume run that sends `DeferredToolResults`.
- The id must be stable per conversation and unique across conversations. No process-wide constants, no `uuid4()` per request, no module-level default.
- No id available in the app → ask the user where the conversation boundary is; if it's a single-shot script, generate one uuid per conversation (not per run) and reuse it.
- Streaming: keep the `async with` open until the stream is consumed (in FastAPI, inside the generator passed to `StreamingResponse`), or the `invoke_agent` span ends early.

## Step 4: Content

- Content is on by default (`include_content=True`): `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` on `chat` spans; tool args/results on `execute_tool` spans. Maple's transcript needs these.
- Always set `include_binary_content=False` (base64 media repeats in every later `chat` span).
- User wants content off → `include_content=False` globally, or per agent: `Agent(..., capabilities=[Instrumentation(settings=InstrumentationSettings(include_content=False))])` (`from pydantic_ai.capabilities import Instrumentation`; omit `tracer_provider` to use the global one). Tell them the transcript keeps roles but no text.
- Logfire scrubbing does not redact message content. For pattern redaction of prompts, recommend an OTel Collector `redaction`/`transform` processor.

## Step 5: Tools, errors, sub-agents

1. Name every agent: `Agent(..., name="support")`. Unnamed agents become `agent` and share one lane.
2. Tool failures the model should see: `raise ToolFailed("message")` (`from pydantic_ai import ToolFailed`, >= 2.16). Span ERROR, message recorded as `gen_ai.tool.call.result`, run continues, no retry budget used.
   - `ModelRetry` also marks the span ERROR (one failed call per retry): use it only for real retries.
   - Replace `return {"error": ...}` / `return "Error: ..."` in tools with `raise ToolFailed(...)` only where the user agrees; returned errors show as successful calls.
   - Uncaught exceptions mark the tool span and the run ERROR and abort the run.
3. Delegation (a tool that calls another agent): pass the caller's id and usage to EVERY nested run:

```py
@orchestrator.tool
async def research_weather(ctx: RunContext[None], city: str) -> str:
    """Delegate to the weather worker."""
    result = await weather_worker.run(
        f"What is the current weather in {city}?",
        usage=ctx.usage,
        conversation_id=ctx.conversation_id,
    )
    return result.output
```

   Without `conversation_id=ctx.conversation_id` each delegate mints a UUID7, so one trace carries several ids and Maple may file the trace under the wrong session or split the turn.
4. Sequential pipelines of top-level runs (orchestrator run, then summary run): pass the same `conversation_id=` to each; each run is its own trace/turn in the same session.

## Step 6: Flush

- The SDK flushes at normal interpreter exit. Add an explicit flush where that doesn't happen:
  - AWS Lambda / Cloud Functions / Cloud Run jobs: `trace.get_tracer_provider().force_flush()` in a `finally` in the handler.
  - Scripts, CLIs, one-shot jobs: `provider.shutdown()` at the end (`finally`).
  - Celery/RQ/multiprocessing workers, notebooks: `force_flush()` after each task/cell that runs an agent.
  - Logfire: `logfire.force_flush()` / `logfire.shutdown()`.

## Step 7: Verify

Run one real conversation: 2+ messages with the same id, at least one tool call, one streamed message if the app streams, and a sub-agent call if the app delegates. If the app has no scriptable entry point (server, UI only), write a small driver for this run: one conversation id, 2+ turns, a tool call, flush before exit. Then check (Maple → Agent Sessions, filter by the service name; wait ~30 s):

- [ ] Exactly one session per conversation; session id = the id you passed (not a UUID7 you didn't create). A second conversation is a different session.
- [ ] Framework shows as **Pydantic AI**.
- [ ] One turn per `run()`; transcript shows user prompts, assistant replies and tool calls.
- [ ] Spans: `invoke_agent <name>`, `chat <model>`, `execute_tool <tool>`; each `chat`/`execute_tool` is inside its run's `invoke_agent` in the same trace.
- [ ] Every `chat` span has input and output tokens, including the streamed one.
- [ ] Tool calls have their real names, arguments and results.
- [ ] A failing tool is marked failed with its message; successful tools are not.
- [ ] Sub-agents appear as separate lanes with their `name=`, all under the caller's session.
- [ ] Cost shows on sessions whose model Pydantic AI can price; "unpriced" otherwise.
- [ ] No attribute contains an API key or `Bearer ` token.

With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

Quick local cue: Pydantic AI 2.51 prints an `observability: off` banner on the first run when no instrumentation is set; it disappears once `instrument_all()` (or `logfire.instrument_pydantic_ai()`) has run.

Without Maple access (or with `MAPLE_TEST`), both must hold; silence alone proves nothing (no spans is silent too):
- The run exits with no `Failed to export` / 401 lines on stderr.
- A console exporter shows the spans with `gen_ai.conversation.id`, identical across runs of one conversation and on delegate spans. Add it temporarily: plain path `provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))`; Logfire path `logfire.configure(..., additional_span_processors=[SimpleSpanProcessor(ConsoleSpanExporter())])` (both from `opentelemetry.sdk.trace.export`). On the Logfire path its own console prints `<agent> run` / `running tool: <x>`; exported span names are still `invoke_agent` / `execute_tool`.

## Known behavior (tell the user when relevant)

- Tool failure matrix: `ToolFailed` → span ERROR, model sees message, run continues; `ModelRetry` → ERROR, one failed call per retry; other exception → ERROR, run raises, failed turn; `return {"error": ...}` → UNSET, shows as successful call.
- Approval-gated tools (`requires_approval=True`) pause the run with no tool span; the `execute_tool` span appears only in the resumed run (the one sending `DeferredToolResults`). Same `conversation_id=` → paused and resumed runs are two turns of one session, both labeled with the original request.
- Delegation rendering: an `execute_tool <x>` span whose only child is `invoke_agent <worker>` shows as a delegation; the tool's args/result become the lane's input/output. Several delegation tools in one model reply run concurrently, so lanes overlap in time.
- `include_content=False` also drops exception messages (only the exception type is kept).
- Instrumentation `version`: 5 default (tested); 2-4 deprecated with `PydanticAIDeprecationWarning` (version 2 used different span names); 6 is opt-in and sends tool results with `role: "tool"`. Fix the warning by removing `version=`.
- Tokens: `chat` spans carry `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, plus `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_creation.input_tokens` when the provider caches. `invoke_agent` carries run totals under `gen_ai.aggregated_usage.*`, which Maple does not add to the session total. Delegate tokens stay on the delegate's spans.
- Streaming: Pydantic AI requests usage on OpenAI-compatible streams (`stream_options.include_usage`), so streamed calls have tokens. Time-to-first-chunk is recorded under a key Maple doesn't read yet.
- Cost: Pydantic AI writes `operation.cost` on `chat` spans when it can price the model, and Maple shows it. Maple never prices tokens itself; a model Pydantic AI can't price shows as unpriced.
- Logfire with `send_to_logfire=True` (or a Logfire token in env) sends to both Logfire and Maple.
- Provider extras: swap `[openai]` for `anthropic`, `google`, `openrouter`, ...; the full `pydantic-ai` package also works.
- Duplicate spans: another instrumentor on the model client (Logfire `instrument_openai()`, OpenInference, OpenLLMetry) double-traces model calls; keep Pydantic AI's.
- Export 413 / huge `chat` spans: binary content recorded as base64; set `include_binary_content=False`.

## Do not

- Do not keep `event_mode="logs"`: content moves to logs, which Maple doesn't read (empty transcript).
- Do not add `session.id` or `maple_ai.session.id`: Maple reads `gen_ai.conversation.id` here; `maple_ai.session.id` re-vendors the span.
