---
name: maple-agent-tracing-smolagents
description: "Trace Hugging Face smolagents agents with Maple: OpenInference instrumentor with GenAI dual-write, one Maple Agent Session per conversation with transcript, model and tool calls, tokens, failed tools and managed-agent lanes. Triggers on 'trace my smolagents agent', 'add Maple to smolagents', 'agent sessions for smolagents', 'OpenTelemetry for smolagents'."
---

# Maple agent tracing: smolagents

Goal: every conversation the app runs through a smolagents agent shows up in Maple **Agent Sessions** as ONE session, with the transcript, each model call (model, tokens), each tool call (name, arguments, result, failure) and one lane per managed agent.

All spans come from `openinference-instrumentation-smolagents`.

## Step 0: Detect versions and existing OpenTelemetry

- Read `pyproject.toml` / `requirements*.txt` / `uv.lock` / `poetry.lock`. Need `smolagents>=1.26` and Python >=3.10. If older, upgrade smolagents first.
- Find which model class the app uses (`OpenAIServerModel`/`OpenAIModel`, `LiteLLMModel`, `InferenceClientModel`, `AzureOpenAIModel`, `AmazonBedrockModel`, `TransformersModel`...). Note any custom `Model` subclass that overrides `generate`: it will produce NO model spans.
- Find every `agent.run(...)` call site and how conversations are identified (chat id, thread id, session row).
- Search for an existing `TracerProvider`, `trace.set_tracer_provider`, `opentelemetry-instrument`, `logfire.configure`, `phoenix.otel.register`, `langfuse`, or `SmolagentsInstrumentor` already present. If a provider exists, REUSE it: add Maple's exporter and the processor below to it, pass it to `instrument()`. Never create a second provider. If `SmolagentsInstrumentor().instrument()` already runs, change that call instead of adding another (a second call is a silent no-op).
- Search for `openinference-instrumentation-openai`, `openinference-instrumentation-litellm`, `OpenAIInstrumentor`, `LiteLLMInstrumentor`. If present only to trace smolagents' model calls, remove them (they double every model span).

## Step 1: Ingest key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`. Protocol: http/protobuf.
- Key given in the prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from **Settings → Ingestion**.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's existing secret/env convention (`.env`, settings module, secret manager) if it has one. Otherwise inlining the key is acceptable: ingest keys are write-only.
- App loads `.env` (`load_dotenv()`): call it at the top of `tracing.py`, before the provider is built. Otherwise the exporter silently targets `localhost:4318` with no key.
- Key missing: instrumentation must never crash or block the app. In `tracing.py`, after any `load_dotenv()`, when `OTEL_EXPORTER_OTLP_HEADERS` is unset, log one warning (`logging.getLogger(__name__).warning("OTEL_EXPORTER_OTLP_HEADERS (Maple ingest key) is not set; Maple telemetry export is disabled")`) and skip the provider and exporter setup. Never raise or exit over the key, and never send a header without one (opaque 401).

## Step 2: Install and initialize

```bash
pip install "smolagents[openai]>=1.26" "openinference-instrumentation-smolagents>=0.1.40" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Use the repo's package manager (`uv add`, `poetry add`...). Use `[litellm]` instead of `[openai]` for `LiteLLMModel`. Do NOT use the `smolagents[telemetry]` extra: it installs the Arize Phoenix server.

Environment (in the repo's env mechanism):

```bash
OTEL_SERVICE_NAME=<service name, e.g. the app/package name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
```

Base URL only. `OTLPSpanExporter()` with no args appends `/v1/traces`. If you pass `endpoint=` in code, it must end in `/v1/traces`.

Create `tracing.py` (adapt the module path to the repo layout):

```py
# tracing.py
import json

from openinference.instrumentation import TraceConfig
from openinference.instrumentation.smolagents import SmolagentsInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


class SmolagentsForMaple(SpanProcessor):
    def on_start(self, span, parent_context=None):
        if span.instrumentation_scope.name != "openinference.instrumentation.smolagents":
            return
        attrs = span.attributes
        if span.name.endswith(".run"):
            # "weather_worker.run" -> gen_ai.agent.name "weather_worker", so sub-agents get lanes
            span.set_attribute("gen_ai.agent.name", span.name.removesuffix(".run"))
        elif "tool.name" in attrs:
            # Every @tool span is named "SimpleTool"; name it after the tool instead
            span.update_name(f"execute_tool {attrs['tool.name']}")
            # The GenAI dual-write copies the tool's input schema here; record the call's arguments
            if attrs.get("input.value", "").startswith("{"):
                call = json.loads(attrs["input.value"])
                span.set_attribute("gen_ai.tool.call.arguments", json.dumps(call["kwargs"] or call["args"]))


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(SmolagentsForMaple())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

SmolagentsInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

- `import tracing` at the top of every entry point (web app module, worker, CLI main) so `instrument()` runs before the first `agent.run()`. Import order relative to `smolagents` does not matter.
- Existing provider: skip the `TracerProvider()`/`set_tracer_provider` lines, add `SmolagentsForMaple()` and the exporter to the existing provider, pass it as `tracer_provider=`.
- `enable_genai_semconv=True`: required (emits the standard GenAI attributes the processor relies on). The env var `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` is equivalent only if set before `TraceConfig` is constructed; prefer the code form.
- Keep `SmolagentsForMaple` exactly: it must run in `on_start` (before the dual-write, which never overwrites existing keys).

## Step 3: One session per conversation

smolagents has no conversation id; each `agent.run()` is its own trace. Maple reads `session.id`, and the instrumentor sets it only inside `using_session`:

```py
from openinference.instrumentation import using_session
from smolagents import OpenAIServerModel, ToolCallingAgent

# One agent per conversation. In a long-running server, evict idle ones or rebuild them from stored history.
agents: dict[str, ToolCallingAgent] = {}


def handle_message(conversation_id: str, text: str) -> str:
    agent = agents.get(conversation_id)
    if agent is None:
        agent = agents[conversation_id] = ToolCallingAgent(
            tools=[get_weather, calculate],
            model=OpenAIServerModel(model_id="gpt-4o-mini"),
            name="assistant",
        )
    with using_session(conversation_id):
        return str(agent.run(text, reset=False))
```

- Wrap EVERY `agent.run()` call site in `with using_session(<conversation id>):`. Use the app's stored conversation/chat/thread id. Never a fresh UUID per request, never a constant.
- If the app already tracks a user, `using_attributes(session_id=..., user_id=...)` also works.
- With `agent.run(..., stream=True)`, iterate the generator INSIDE the `with` block.
- One agent object (or one persisted memory) per conversation. A module-level agent with `reset=False` merges every user's memory and traces into one conversation; fix it if you find it, and tell the user.
- The id is a contextvar, not baggage. Your own spans (plain OTel tracer) don't get it; give them `attributes=dict(get_attributes_from_context())` if you add any.

## Step 4: Content

- On by default: model spans carry the full input message list (system prompt, task, history, tool results) and the reply; tool spans carry arguments and results. Leave it on unless the user or repo says prompts are sensitive.
- To turn off: `TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)` (or `OPENINFERENCE_HIDE_INPUTS=true` / `OPENINFERENCE_HIDE_OUTPUTS=true`). Narrower: `hide_input_text`, `hide_output_text`, `hide_llm_invocation_parameters`.
- The hide switches do NOT mask the run span's `smolagents.task` attribute (holds the previous run's task text). If PII matters, drop it in a Collector (`attributes` processor) and tell the user.
- Payload: default system prompt is ~3.1k chars (`ToolCallingAgent`) / ~8.5k (`CodeAgent`) and with `reset=False` each model span repeats the whole history. Ingest limit is 20 MiB per request; nothing to configure.

## Step 5: Tools, errors, managed agents

- Give every agent (top-level and managed) a distinct `name=`. Unnamed agents become `ToolCallingAgent`/`CodeAgent` and share one lane.
- Tool exceptions are marked failed automatically (tool span status ERROR with the exception message). Do not catch exceptions inside tools just to return an error string: that hides the failure (span stays OK).
- smolagents prompts the model to retry after every tool error until `max_steps`, then asks for an answer without tools (hallucination risk). If a tool can fail permanently, suggest a `step_callbacks` hook that tells the model to stop after the first failure; don't add it unasked.
- Managed agents appear as `<name>.run` spans under the manager's `Step N` span; the processor names their lanes. Parallel tool/agent calls (`max_tool_threads`) keep context; nothing to do.
- `CodeAgent` with `executor_type` other than local (`e2b`, `docker`, `modal`, ...) runs tools outside the process: no tool spans. Tell the user; nothing to fix in tracing.
- Known, not fixable here: no `gen_ai.tool.call.id` on tool spans; a failed tool also marks its `Step N` span ERROR (Maple: toolErrorCount 1, plus an "Other errors" warning for the Step span).

## Known behavior (tell the user when relevant)

- `ToolCallingAgent`: a model reply that calls `final_answer` together with another tool raises `AgentExecutionError`; that step shows as a failed `Step` span although the run continues. It's the framework rejecting the model output, not the user's code.
- A tool failure puts two `exception` events on the enclosing `Step N` span (wrapped `AgentToolExecutionError`).
- `CodeAgent` with `LocalPythonExecutor`: tool calls from generated code produce normal tool spans; positional args are recorded as a JSON array (`["Berlin"]`).
- Tokens: only input/output tokens (`gen_ai.usage.input_tokens`/`output_tokens` + `llm.token_count.*`); cached and reasoning tokens are not recorded. Model = the requested id (`gen_ai.request.model`), not the provider's response model.
- Provider comes from the model class: `OpenAIServerModel` is always `openai`, even for an Anthropic model behind OpenRouter. `OpenAIServerModel` is an alias of `OpenAIModel`, so spans are `OpenAIModel.generate`.
- Streaming (`stream_outputs=True`) → `<ModelClass>.generate_stream` spans; smolagents requests `stream_options={"include_usage": True}` for `OpenAIServerModel`, `LiteLLMModel`, `InferenceClientModel`, so tokens are kept.
- Cost: smolagents records none; sessions show as unpriced.

## Step 6: Flush

- `TracerProvider` flushes on normal interpreter exit (atexit). That covers servers and CLIs that exit normally.
- Serverless handlers (Lambda, Cloud Run jobs, Modal functions...): call `provider.force_flush()` in a `finally` before returning.
- Scripts that may be killed or call `os._exit`, and notebooks: `provider.force_flush()` after each run; `provider.shutdown()` at the very end.

## Step 7: Verify

Run one real conversation (2-3 messages, same conversation id, at least one tool call), and one message in a second conversation. No scriptable entry point (server, UI, REPL only): write a small driver for this run (one conversation id, 2+ turns, one tool call, flush before exit).

Without Maple access (`MAPLE_TEST`, no MCP): the run must exit with no export errors on stderr (`Failed to export`, 401 lines) AND a local exporter (`provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))` in a scratch run) must show `<agent name>.run`, model and `execute_tool <name>` spans carrying `session.id`. Silence alone proves nothing (no spans is silent too). Say so and list what the user should check in Maple. With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

Otherwise check in Maple **Agent Sessions** (`https://app.maple.dev/agent-sessions`, EU `app.eu.maple.dev`), filtered to the service name:

- Exactly one session per conversation id (two here), not one per message. Framework shows **smolagents**.
- The first conversation has one turn per `agent.run()`; each turn's root span is `<agent name>.run`.
- Transcript is non-empty (user text appears after `New task:`; tool results as `tool-response` messages).
- Model calls `OpenAIModel.generate` (or `<ModelClass>.generate[_stream]`) have a model and non-zero input/output tokens, including streamed calls.
- Session token totals equal the sum of the model calls (not 2x, not growing faster each turn).
- Tool calls are `execute_tool <tool name>` with JSON arguments (the actual call's, not a schema) and results. `execute_tool final_answer` at the end of each turn is expected, and Maple's tool-call count includes one per agent run (managed agents too).
- A tool that raised is counted as failed; tools that returned are not.
- Managed agents (if any) each have their own lane named after the agent.
- Cost shows as unpriced (smolagents records no cost). Expected.
- Each model call appears once (no nested duplicate model span).

If sessions are split per message: `using_session` missing or id changing. Nothing arrives: exporter endpoint/header wrong, `.env` loaded after `tracing.py`, or process exited without flushing. 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust: keys are region-bound, so it likely belongs to the other region; try the other endpoint.

## Do not

- Do not use `phoenix.otel.register()` (the smolagents docs' setup) to send to Maple: it skips `SmolagentsForMaple` (no lanes, tools named `SimpleTool`).
