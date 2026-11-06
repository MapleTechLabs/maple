---
name: maple-agent-tracing-dspy
description: "Trace DSPy programs and ReAct agents with Maple: OpenInference DSPy instrumentor with GenAI dual-write, a DSPy callback for tokens, cost, tool names and agent spans, using_session for one session per conversation, and thread context for dspy.Parallel. Triggers on 'trace my dspy agent', 'add Maple to dspy', 'agent sessions for dspy', 'OpenTelemetry for dspy'."
---

# Maple agent tracing: DSPy

Goal: every conversation with the user's DSPy program shows up in Maple **Agent Sessions** as one session, with one turn per call to the program, a transcript, model calls with tokens and cost, tool calls with arguments, results and failures, and one lane per worker module.

Spans come from `openinference-instrumentation-dspy`. It records no tokens, no tool names, no agent spans and no session id; the steps below add all four. Do not skip any step.

## Step 0: Detect versions and existing setup

- Read `pyproject.toml` / `requirements*.txt` / `uv.lock`. Require `dspy>=3.4`. On 3.3 or older, tell the user this skill targets 3.4 and ask before upgrading.
- Find how LMs are built: `dspy.LM("provider/model", ...)`. Note any `engine=`, `cache=`, `callbacks=`, `disable_history`, `max_history_size`.
- Search for an existing OpenTelemetry setup: `TracerProvider(`, `set_tracer_provider`, `opentelemetry-instrument`, `logfire.configure`, `mlflow.dspy.autolog`, `phoenix.otel.register`, `LiteLLMInstrumentor`, `OpenAIInstrumentor`.
  - An existing `TracerProvider`: reuse it. Add the OTLP exporter to it and pass it to `instrument()`. Never create a second provider.
  - `LiteLLMInstrumentor` / `OpenAIInstrumentor` from OpenInference: remove them (they double-count model calls on the LiteLLM engine and record nothing on the native one).
  - `mlflow.dspy.autolog()`: leave it if the user wants MLflow too, but it is not the Maple path.
- Find where the program is called per user message (HTTP handler, CLI loop, worker). That is where the session id goes.
- Find `dspy.Parallel`, `dspy.Evaluate`, `ThreadPoolExecutor`, `threading.Thread` around module calls.
- Find `dspy.streamify(...)` calls and where they run relative to `dspy.configure` (see Streaming in Step 3).
- Check for a `dspy.Module` subclass with an attribute named `history` (see "Do not").

## Step 1: Ingest key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key in the user's prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with a key from **Settings → Ingestion**.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's existing secret/env convention (`.env`, settings module, secret manager). If there is none, inline is acceptable: ingest keys are write-only.
- App loads `.env` (`load_dotenv()`): call it at the top of `tracing.py`, before the provider is built. Otherwise the exporter silently targets `localhost:4318` with no key.
- Key missing: instrumentation must never crash or block the app. In `tracing.py`, after any `load_dotenv()`, when `OTEL_EXPORTER_OTLP_HEADERS` is unset, log one warning (`logging.getLogger(__name__).warning("OTEL_EXPORTER_OTLP_HEADERS (Maple ingest key) is not set; Maple telemetry export is disabled")`) and skip the provider and exporter setup. Never raise or exit over the key, and never send a header without one (opaque 401).

## Step 2: Install and initialize

```bash
pip install "dspy>=3.4" "openinference-instrumentation-dspy>=0.1.45" "openinference-instrumentation>=0.1.66" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45" \
  "opentelemetry-instrumentation-threading>=0.66b0"
```

Use the repo's package manager (`uv add`, `poetry add`, requirements file).

Environment (base URL, no `/v1/traces`; the exporter appends it):

```bash
OTEL_SERVICE_NAME=<service name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Create `tracing.py`:

```py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.dspy import DSPyInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.threading import ThreadingInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

DSPyInstrumentor().instrument(tracer_provider=provider, config=TraceConfig(enable_genai_semconv=True))
ThreadingInstrumentor().instrument()
```

- `enable_genai_semconv=True` is required.
- `ThreadingInstrumentor` is required whenever modules run in threads (`dspy.Parallel`, `Evaluate`, executors). Without it every worker is an orphan trace with no session.
- Import `tracing` as the first import of every entry point (web app, CLI, worker), before the DSPy program modules.

Create `maple_dspy.py` exactly as below (it fills the instrumentor's gaps from DSPy's callback hooks, which run inside the instrumentor's spans):

```py
import json

import dspy
from dspy.utils.callback import BaseCallback
from openinference.instrumentation import TraceConfig
from opentelemetry import trace

# Same switches as the instrumentor: OPENINFERENCE_HIDE_INPUTS / OPENINFERENCE_HIDE_OUTPUTS.
_config = TraceConfig()


def _message(role, values):
    text = "\n".join(v for v in values if isinstance(v, str))
    return json.dumps([{"role": role, "parts": [{"type": "text", "content": text}]}]) if text else None


class MapleCallback(BaseCallback):
    def __init__(self):
        self._agents = set()
        self._lms = {}

    def on_module_start(self, call_id, instance, inputs):
        if type(instance).__module__.startswith("dspy."):
            return  # Predict, ChainOfThought, ReAct: building blocks, not agents
        self._agents.add(call_id)
        span = trace.get_current_span()
        span.set_attribute("gen_ai.operation.name", "invoke_agent")
        span.set_attribute("gen_ai.agent.name", type(instance).__name__)
        user = _message("user", [*inputs.get("args", ()), *inputs.get("kwargs", {}).values()])
        if user and not _config.hide_inputs:
            span.set_attribute("gen_ai.input.messages", user)

    def on_module_end(self, call_id, outputs, exception):
        if call_id not in self._agents:
            return
        self._agents.discard(call_id)
        if isinstance(outputs, dspy.Prediction) and not _config.hide_outputs:
            reply = _message("assistant", [v for k, v in outputs.items() if k != "reasoning"])
            if reply:
                trace.get_current_span().set_attribute("gen_ai.output.messages", reply)

    def on_tool_start(self, call_id, instance, inputs):
        span = trace.get_current_span()
        span.set_attribute("gen_ai.tool.name", instance.name)
        span.set_attribute("gen_ai.tool.description", instance.desc or "")
        if not _config.hide_inputs:
            span.set_attribute("gen_ai.tool.call.arguments", json.dumps(inputs.get("kwargs", {}), default=str))

    def on_lm_start(self, call_id, instance, inputs):
        self._lms[call_id] = instance

    def on_lm_end(self, call_id, outputs, exception):
        lm = self._lms.pop(call_id, None)
        # The LM's history holds the provider response. Threads share the LM, so match ours by identity.
        entry = next((e for e in reversed(lm.history[-16:]) if e["outputs"] is outputs), None) if lm else None
        if entry is None or getattr(entry["response"], "cache_hit", False):
            return  # history is off, or a cache hit that cost nothing
        usage = entry["usage"] or {}
        attributes = {
            "gen_ai.response.id": getattr(entry["response"], "id", None),
            "gen_ai.response.model": entry.get("response_model"),
            "gen_ai.usage.input_tokens": usage.get("prompt_tokens"),
            "gen_ai.usage.output_tokens": usage.get("completion_tokens"),
            "gen_ai.usage.cache_read.input_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            "gen_ai.usage.reasoning.output_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
            "gen_ai.usage.cost": entry.get("cost"),
        }
        trace.get_current_span().set_attributes({k: v for k, v in attributes.items() if v is not None})
```

Register it where the app configures DSPy, keeping existing callbacks:

```py
import tracing  # first

import dspy
from maple_dspy import MapleCallback

dspy.configure(lm=dspy.LM("openai/gpt-4o-mini"), callbacks=[MapleCallback()])  # append to any existing callbacks list
```

- Every later `dspy.configure(callbacks=...)` or `dspy.context(callbacks=...)` must include the `MapleCallback` instance too, or it is replaced.
- If the app's program is a bare `dspy.ReAct` / `dspy.ChainOfThought` called directly, wrap it in a small `dspy.Module` subclass named after the agent. Only user-defined module classes become agents (`invoke_agent`, `gen_ai.agent.name` = class name).

## Step 3: One session per conversation

Maple reads `session.id` for DSPy. Wrap every call to the program in `using_session` with the app's own stored conversation id:

```py
from openinference.instrumentation import using_session

def handle_message(conversation_id: str, question: str, turns: list[dict]) -> str:
    with using_session(conversation_id):
        answer = assistant(question=question, conversation=dspy.History(messages=turns)).answer
    turns.append({"question": question, "answer": answer})
    return answer
```

- Use the id the app already stores the chat under. Never a new UUID per request, never a constant.
- For a one-shot job (batch, CLI run, orchestration), mint one id per run and wrap the whole run.
- Async handlers work unchanged (`using_session` is context-based).

Streaming (`dspy.streamify`):

```py
stream_assistant = dspy.streamify(assistant, stream_listeners=[dspy.streaming.StreamListener("answer")])


async def stream_message(conversation_id: str, question: str, turns: list[dict]):
    with using_session(conversation_id):
        async for chunk in stream_assistant(question=question, conversation=dspy.History(messages=turns)):
            if isinstance(chunk, dspy.streaming.StreamResponse):
                yield chunk.chunk
            elif isinstance(chunk, dspy.Prediction):
                turns.append({"question": question, "answer": chunk.answer})
```

- Call `dspy.streamify(...)` only after `dspy.configure(callbacks=[MapleCallback()])`: it snapshots the callback list when called. A streamified program created earlier (e.g. at import time) streams without the callback: no tokens, no tool names.
- `using_session` must wrap the loop that consumes the stream (inside the generator handed to the SSE/`StreamingResponse`), not only the `stream_assistant(...)` call: the program starts on the first iteration.
- Streamed calls get tokens and cost; they have no `gen_ai.response.id` (DSPy's native engine drops it) and no TTFT attribute. Expected.

## Step 4: Content

- Default: prompts, replies, tool arguments and results are captured. Maple shows them as the transcript.
- To turn content off: `OPENINFERENCE_HIDE_INPUTS=true` and `OPENINFERENCE_HIDE_OUTPUTS=true`, set before `tracing.py` / `maple_dspy.py` are imported. The callback honours both.
- If the user mentions PII or compliance, ask whether to disable content; do not decide silently.

## Step 5: Tools, errors, sub-agents

- Tools need no changes: plain functions passed to `dspy.ReAct(tools=[...])` or `dspy.Tool(...)` get `<name>.__call__` spans. A raised exception marks the tool span `ERROR` with the message; Maple counts it. Do not catch exceptions inside the tool just to return an error string: that hides the failure.
- Give tools real docstrings; the callback records them as `gen_ai.tool.description`.
- Sub-agents: DSPy's idiom is an orchestrator module calling worker modules. Give each worker its own class with a descriptive name (`WeatherWorker`, `BudgetWorker`). Two instances of one class share one lane.
- Parallel workers: `dspy.Parallel` is fine once `ThreadingInstrumentor` runs. `multiprocessing` is not covered; each process starts its own trace.

## Step 6: Flush

- Long-running servers: nothing to add; the provider flushes on normal exit.
- Scripts, CLIs, jobs: `provider.shutdown()` in a `finally` at the end of `main`.
- Serverless handlers and notebooks: `provider.force_flush()` before returning / after each run.

```py
from tracing import provider

try:
    run()
finally:
    provider.shutdown()
```

## Step 7: Verify

Run one conversation of 2-3 messages with the same conversation id (one using a tool), with `cache=False` on the LM so every call hits the provider. No scriptable entry point (server, UI, REPL only): write a small driver for this run (one conversation id, 2+ turns, one tool call, flush before exit).

Without Maple access (`MAPLE_TEST`, no MCP): the run must exit with no export errors on stderr (`Failed to export`, 401 lines) AND a local exporter (`provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))` in a scratch run) must show `<YourModule>.forward`, `LM.__call__` and `<tool>.__call__` spans carrying `session.id`. Silence alone proves nothing (no spans is silent too). With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

Then check in Maple **Agent Sessions** (`https://app.maple.dev/agent-sessions`, or `app.eu.maple.dev`), or with the Maple MCP (`list_agent_sessions`, `get_agent_session`):

- Exactly one session for the conversation, id = the conversation id, framework **DSPy**. A second conversation is a second session.
- One turn per program call; each turn's root is `<YourModule>.forward`, titled with the user's question.
- Model calls named `LM.__call__`, each with model, input and output tokens, and cost where DSPy knows the price. The LLM call count equals the real number of model calls (not double).
- If the app streams: the streamed turn is in the same session and its `LM.__call__` spans have tokens.
- Transcript non-empty (DSPy's `[[ ## field ## ]]` prompt format is expected).
- Tool calls named `<tool>.__call__` with `gen_ai.tool.name`, arguments and results. `finish.__call__` (ReAct's end-of-loop tool) is expected and counts as a tool call.
- A tool that raised is counted as failed (session check **Tool availability** fails with the exception); no successful tool or model call is marked failed.
- Worker modules appear as separate agents/lanes; with `dspy.Parallel`, all workers are in the same trace as the orchestrator, none orphaned.
- The process exited cleanly and the last turn is present (flush ran).

401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust: keys are region-bound, so it likely belongs to the other region; try the other endpoint.

## Known behaviours (expected, nothing to fix; explain them if the user asks)

- `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` set before `instrument()` runs is equivalent to `TraceConfig(enable_genai_semconv=True)`. The GenAI dual-write never overwrites a key already set, so the callback's values win.
- Each `LM.__call__` sits under `Predict.forward`, `Predict(StringSignature).forward` and `ChatAdapter.__call__`; those are DSPy steps, not extra model calls.
- `dspy.ReAct` catches tool exceptions and hands `Execution error in <tool>: ...` back to the model. The tool span is `ERROR` and counted as failed; the `ReAct.forward` span and the user's module span stay `OK`, and the program's return value doesn't reveal the failure.
- Tool spans have no `gen_ai.tool.call.id`: ReAct asks the model for the next tool as text fields (`next_tool_name`, `next_tool_args`), not through the provider's tool-calling API.
- When `ChatAdapter` can't parse a reply, DSPy retries with `JSONAdapter`: one `Predict` span holds two adapter spans, each with its own `LM.__call__`. Both calls happened and both are billed.
- Cost is DSPy's estimate from each history entry's `cost`: on the `lm15` engine from DSPy's bundled model metadata, on the LiteLLM engine LiteLLM's `response_cost`. Maple never prices tokens; a model DSPy can't price shows as **unpriced**.
- An `LM` with a custom `engine=` reports whatever usage that engine puts on its response.
- Anthropic models run on the LiteLLM engine by default (as does `dspy.LM(..., engine="litellm")`); that is where an extra LiteLLM/OpenAI instrumentor would double-count.
- `dspy.Parallel` copies only DSPy's settings into its worker threads, not the OpenTelemetry context; `ThreadingInstrumentor` is what carries it.
- Narrower content switches (`OPENINFERENCE_HIDE_INPUT_TEXT`, `OPENINFERENCE_HIDE_OUTPUT_TEXT`, `OPENINFERENCE_HIDE_LLM_INVOCATION_PARAMETERS`) redact parts of each model message; the callback's agent messages follow only `OPENINFERENCE_HIDE_INPUTS` / `OPENINFERENCE_HIDE_OUTPUTS`.
- With content hidden the session still shows turns, model and tool calls, tokens and failures, with an empty transcript and no tool arguments or results.

## Do not

- Do not name a `dspy.Module` attribute `history`: DSPy appends LM calls to it and a `dspy.History` there crashes every model call (`TypeError: object of type 'History' has no len()`). Pass `dspy.History` as an input field.
- Do not set `disable_history=True` or `max_history_size=0`: the callback reads token usage from LM history.
- Do not use `opentelemetry-instrumentation-genai-dspy` as the Maple path: 1.2b0 records no model calls and is not identified as DSPy.
- Do not trace optimizer runs (`MIPROv2`, `GEPA`, `BootstrapFewShot`) or `dspy.Evaluate` under the production service name; they make hundreds of calls.
