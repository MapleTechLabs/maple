---
name: maple-agent-tracing-google-adk
description: "Trace Google ADK (Agent Development Kit) agents with Maple, in Python (google-adk) and TypeScript (@google/adk): register an OTLP tracer provider, get the transcript and tool calls into the GenAI attributes Maple reads (env switches + a plugin in Python, a span processor in TypeScript), and keep one session per ADK session id. Triggers on 'trace my ADK agent', 'add Maple to Google ADK', 'add Maple to @google/adk', 'agent sessions for Google ADK', 'OpenTelemetry for google-adk'."
---

# Maple agent tracing: Google ADK (Python and TypeScript)

Goal: one conversation = one ADK session id = one Maple Agent Session, with the transcript (user, assistant, tool calls and results), model calls, tool calls with arguments/results, failures, and tokens.

ADK emits its own OTel spans (scope `gcp.vertex.agent`): `invocation` > `invoke_agent {agent}` > `call_llm` > `generate_content {model}`, plus `execute_tool {tool}`. No instrumentation package is needed. You add: a tracer provider (Runner apps only), the env vars below, one plugin, one span processor.

**TypeScript (`@google/adk` in `package.json`): follow [references/typescript.md](references/typescript.md) instead of Steps 0-7 below.** Step 1 (key and region) applies to both. ADK for TypeScript records content differently (Gemini-shaped JSON on `gcp.vertex.agent.*` attributes, no `generate_content` span), so the Python env switches and plugin do not apply there.

## Step 0: Detect versions and existing setup

- Read `pyproject.toml` / `requirements*.txt` / `uv.lock`. Require `google-adk>=2.10`; upgrade if lower (before 2.7, `gen_ai.system` is always `gemini` and failed tools are not marked ERROR).
- ADK caps `opentelemetry-sdk<=1.42.1`. Never pin a newer OTel package; let the resolver choose.
- Find how ADK runs:
  - `adk web` / `adk api_server` (CLI): ADK builds the tracer provider from `OTEL_EXPORTER_OTLP_*` env. Do NOT register another provider.
  - `Runner(...)` in the app's own code (FastAPI, worker, script, notebook): nothing is exported unless the app registers a provider. You must add one.
- Grep for an existing OTel setup: `set_tracer_provider`, `TracerProvider(`, `logfire.configure`, `sentry_sdk.init`, `maybe_set_otel_providers`, `opentelemetry-instrument`. If one exists, add the Maple processor to that provider instead of creating a second one.
- Grep for double instrumentation and remove it if it only exists for tracing: `litellm.callbacks` containing `"otel"`, `openinference-instrumentation-google-adk` / `GoogleADKInstrumentor`, `openinference-instrumentation-litellm`, `openinference-instrumentation-openai`, `opentelemetry-instrumentation-openai-v2`. Ask the user before removing something another backend relies on.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key given in the prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with a key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention (`.env`, settings module, deployment env). If there is none, inline values are acceptable: ingest keys are write-only.
- Key read from env in code: when it is unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally. Never raise or exit over the key; no bare `KeyError` on import, no header without a key.

## Step 2: Install and initialize

```bash
pip install "google-adk>=2.10" opentelemetry-exporter-otlp-proto-http
```

Add `litellm` only if the app uses `google.adk.models.lite_llm.LiteLlm`. Use the repo's package manager (`uv add`, `poetry add`).

Env vars (all runtimes, including `adk web`/`api_server`):

```bash
OTEL_SERVICE_NAME=<service-name>
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY
ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false
```

- `OTEL_EXPORTER_OTLP_ENDPOINT` gets `/v1/traces` appended. If you use `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` instead, give the full `https://ingest.maple.dev/v1/traces`.
- The env vars must be in the process environment when `telemetry.py` builds the exporter. Otherwise it silently targets `localhost:4318` with no key.

For Runner apps, create `telemetry.py` next to the entry point:

```py
# telemetry.py
import json

from google.adk.plugins.base_plugin import BasePlugin
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


class SkipDuplicateToolSpans(BatchSpanProcessor):
    """Drops two ADK tool spans that would count a call twice: the
    `execute_tool (merged)` summary of parallel calls, and the span of a call
    paused for confirmation (it runs again, in its own span, once approved)."""

    def on_end(self, span):
        if span.name != "execute_tool (merged)" and not span.attributes.get("adk.awaiting_confirmation"):
            super().on_end(span)


class ToolCallAttributes(BasePlugin):
    """Records each tool call's arguments and result on its `execute_tool` span,
    and marks the span of a call that is waiting for confirmation."""

    def __init__(self):
        super().__init__(name="tool_call_attributes")

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
        trace.get_current_span().set_attribute("gen_ai.tool.call.arguments", json.dumps(tool_args, default=str))

    async def after_tool_callback(self, *, tool, tool_args, tool_context, result):
        span = trace.get_current_span()
        if tool_context.actions.requested_tool_confirmations:
            span.set_attribute("adk.awaiting_confirmation", True)
        span.set_attribute("gen_ai.tool.call.result", json.dumps(result, default=str))


# Reads OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
provider = TracerProvider(resource=Resource.create())
provider.add_span_processor(SkipDuplicateToolSpans(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
```

- Import `telemetry` before any `google.adk` or agent import; if you use python-dotenv, call `load_dotenv()` on the line before it.
- Existing provider found in Step 0: skip `TracerProvider(...)`/`set_tracer_provider`; call `existing_provider.add_span_processor(SkipDuplicateToolSpans(OTLPSpanExporter()))` right after it is created. Keep `ToolCallAttributes`.
- Register the plugin on every `Runner`: `Runner(..., plugins=[telemetry.ToolCallAttributes()])`, appending to existing plugins. For `adk web`/`api_server`, add it to the `App(name=..., root_agent=..., plugins=[...])` in the agent module and do not create a provider (only the plugin is needed). The processor can't be added there without replacing ADK's provider, so `execute_tool (merged)` spans and paused-confirmation spans stay; tell the user tool counts can be inflated under the CLI.

## Step 3: Session id

- ADK writes `session.id` as `gen_ai.conversation.id` on `invoke_agent` and `generate_content` spans; Maple groups on it. One `run_async()` = one trace = one turn.
- Make sure every turn of a conversation calls `runner.run_async(user_id=..., session_id=<conversation id>, new_message=...)` with the SAME id. Use the app's own chat/thread id. `Runner(..., auto_create_session=True)` creates the session under that id on the first turn. `InMemoryRunner` (ADK samples) has no `auto_create_session`: call `await runner.session_service.create_session(app_name=..., user_id=..., session_id=<conversation id>)` once before the first turn; `plugins=` works the same.
- Fix code that calls `session_service.create_session(...)` without `session_id` on every request: that mints a new UUID per turn (and the model loses history).
- Never use a process-global constant session id for all users.
- Prefer `run_async()`; in servers do not use sync `runner.run()`.

## Step 4: Content

- The two OTel env vars from Step 2 put `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions` on `generate_content` spans as `[{role, parts}]` JSON. This is the only content Maple reads.
- `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` means log records only. Use `SPAN_ONLY`.
- `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` removes ADK's `gcp.vertex.agent.*` duplicate blobs (Maple ignores them; they double payload size).
- Per-request alternative: `RunConfig(telemetry=TelemetryConfig(genai_semconv_stability_opt_in="experimental", capture_message_content=ContentCapturingMode.SPAN_ONLY))`, imports from `google.adk.telemetry.context`.
- If the user wants no content: omit `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` and delete the two `gen_ai.tool.call.*` `set_attribute` lines from `ToolCallAttributes` (keep the plugin: it still marks paused-confirmation spans). Tell the user the transcript will be empty.

## Step 5: Tools, errors, sub-agents

- A tool call is marked failed (ERROR + `error.type`) when the tool raises, or returns a dict with a non-empty `"error"` key (`error.type=TOOL_ERROR`).
- Tools returning `{"status": "error", "error_message": ...}` are NOT marked failed. If the repo uses that format, tell the user and offer to change it to `{"error": ...}` (changes what the model sees; confirm first).
- A raised tool exception aborts the run. Only if the user wants the agent to continue, add:

```py
class ToolErrorsAsResults(BasePlugin):
    def __init__(self):
        super().__init__(name="tool_errors_as_results")

    async def on_tool_error_callback(self, *, tool, tool_args, tool_context, error):
        return {"error": str(error)}
```

- Human approval (`FunctionTool(func, require_confirmation=True)`): ADK opens an `execute_tool` span for the paused call and another when the approved call runs. `ToolCallAttributes` marks the paused one and `SkipDuplicateToolSpans` drops it, so each call counts once. Send the approval (`FunctionResponse` named `adk_request_confirmation`) with the same `session_id`: it becomes its own trace in the same session. A rejected call is marked failed (`This tool call is rejected.`).
- Every agent needs a distinct `name` (becomes `gen_ai.agent.name`, Maple's lanes).
- Agents as tools: use `sub_agents=[LlmAgent(..., mode="single_turn")]`. Each call produces `execute_tool {agent}` (counted as a tool call, result = the sub-agent's reply) and a sibling `invoke_agent {agent}` under the parent agent, not nested; several delegations in one model response run in parallel. Replace `AgentTool(agent=...)` if present and the user agrees: `AgentTool` runs the sub-agent in a fresh in-memory session, so its spans carry a second `gen_ai.conversation.id` and Maple may file the turn under the wrong session.
- `SequentialAgent` / `ParallelAgent` / `LoopAgent` need no changes.

## Step 6: Flush

- Scripts, CLIs, notebooks, jobs, tests: wrap the work in `try/finally` and call `telemetry.provider.force_flush()` then `telemetry.provider.shutdown()`.
- Servers: call `provider.shutdown()` in the shutdown hook (FastAPI `lifespan`).
- CPU-throttled serverless (Cloud Run default, Cloud Functions, Lambda): call `provider.force_flush()` before returning each response.

## Step 7: Verify

Run one conversation of 2-3 turns with the same session id, one turn calling a tool, then flush. If the app has no scriptable entry point (`adk web` agent package, server, UI only), write a small driver for this run: one session id, 2+ turns, a tool call, flush before exit. With a real key, open Maple → Agent Sessions (`https://app.maple.dev/agent-sessions`, EU `app.eu.maple.dev`); data appears within about a minute. Check:

- [ ] Exactly one session for the conversation, framework **Google ADK**, one turn per `run_async()`. A second conversation is a separate session.
- [ ] Transcript shows user messages, assistant replies, tool calls with arguments and results.
- [ ] LLM calls and input/output tokens are non-zero on every turn, including streamed ones. Model = `gen_ai.request.model` (e.g. `openrouter/openai/gpt-4o-mini`).
- [ ] Tool calls carry real function names; no tool named `(merged tools)`; an approved confirmation-gated call counts once.
- [ ] A failing tool is counted as an error; successful tools are not.
- [ ] Sub-agents appear as separate lanes with their own names.
- [ ] No duplicated model calls (no second instrumentor).
- [ ] Cost shows "unpriced" (expected: ADK records no cost).

With the Maple MCP: `list_agent_sessions` with `search=<session id>` returns one row.

Without Maple access (or with `MAPLE_TEST`), both must hold; silence alone proves nothing (no spans is silent too):
- The run exits with no `Failed to export span batch` / 401 lines on stderr.
- A local console exporter shows the spans. Temporarily add `provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))` (`from opentelemetry.sdk.trace.export import SimpleSpanProcessor, ConsoleSpanExporter`), run one turn, and confirm `generate_content` spans have `gen_ai.conversation.id`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.input_tokens`; `execute_tool` spans have `gen_ai.tool.call.arguments`. Also useful with a real key when exports fail. Remove it afterwards.

Tell the user about the known gaps: cost is unpriced; the model is the requested id, not the served one, and there is no `gen_ai.response.id`.

## Reference notes

- Scope: ADK for Python here, ADK for TypeScript in references/typescript.md. ADK for Go and Kotlin emit the same span names; their provider setup is not covered.
- Expected trace per turn:

  ```text
  invocation
  └─ invoke_agent assistant
     ├─ call_llm
     │  └─ generate_content openrouter/openai/gpt-4o-mini
     ├─ execute_tool get_weather
     └─ call_llm
        └─ generate_content openrouter/openai/gpt-4o-mini
  ```

- Tokens: `generate_content` carries `gen_ai.usage.input_tokens` / `output_tokens`, plus `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.reasoning.output_tokens` when reported (cached inside input, thinking inside output). `call_llm` repeats the same usage; Maple counts it on `generate_content` only, so totals and LLM call count are correct. Streamed turns (`StreamingMode.SSE`) report usage; `LiteLlm` requests it via `stream_options.include_usage`.
- Cost: LiteLLM computes a cost but it never reaches ADK's spans; sessions are unpriced.
- `AgentTool` detail: Maple keeps one `gen_ai.conversation.id` per trace and picks the larger of the two, which is why the turn can move to another session.
- The approval `run_async()` is its own turn, labeled with the original request.
- With the settings in this skill, `generate_content` spans carry no provider attribute; doesn't affect grouping, tokens or transcript.
- 401 from the exporter (`ingest_unauthorized`, "Invalid ingest key"): with a key you trust, it usually belongs to the other region (keys are region-bound): try the other endpoint.

## Do not

- Do not drop or filter `call_llm` spans: `generate_content` would lose its parent.
