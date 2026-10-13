---
name: maple-agent-tracing-crewai
description: "Trace CrewAI crews and flows with Maple: OpenInference CrewAI instrumentor plus the model-SDK instrumentor, GenAI dual-write, one Maple Agent Session per conversation with transcript, model and tool calls, tokens, failed tools and one lane per agent. Triggers on 'trace my crewai agent', 'add Maple to crewai', 'agent sessions for crewai', 'OpenTelemetry for crewai'."
---

# Maple agent tracing: CrewAI

Goal: every conversation the app runs through CrewAI shows up in Maple **Agent Sessions** as ONE session, with the transcript, each model call (model, tokens), each tool call (name, result, failure) and one lane per agent role.

CrewAI exports nothing to your backend. All spans come from OpenInference, and the defaults are wrong for Maple in three ways this skill fixes: the CrewAI instrumentor records no model calls (a second, SDK-level instrumentor is required), no session id, and no agent-name attribute.

## Step 0: Detect versions and existing OpenTelemetry

- Read `pyproject.toml` / `requirements*.txt` / `uv.lock` / `poetry.lock`. Need `crewai>=1.15`, Python 3.10-3.13. If older, upgrade CrewAI first (1.x changed provider routing).
- Find every `LLM(model=...)` / `Agent(llm=...)` string and map it to the SDK CrewAI calls. Install one instrumentor per SDK actually used:

| Model string | SDK | Instrumentor package / class |
| --- | --- | --- |
| `openai/…`, `openrouter/…`, `deepseek/…`, `ollama/…`, `hosted_vllm/…`, `cerebras/…`, `dashscope/…`, `custom_openai=True`, or any bare name not matched below | `openai` | `openinference-instrumentation-openai` / `OpenAIInstrumentor` |
| `anthropic/…`, `claude/…`, bare `claude-…` | `anthropic` | `openinference-instrumentation-anthropic` / `AnthropicInstrumentor` |
| `gemini/…`, `google/…`, bare `gemini-…` | `google-genai` | `openinference-instrumentation-google-genai` / `GoogleGenAIInstrumentor` |
| `bedrock/…`, `aws/…`, bare `anthropic.claude-…` | `boto3` | `openinference-instrumentation-bedrock` / `BedrockInstrumentor` |
| any other prefix (LiteLLM fallback, needs `crewai[litellm]`) | `litellm` | `openinference-instrumentation-litellm` / `LiteLLMInstrumentor` |

  An agent with no `llm=` uses env `MODEL` / `MODEL_NAME` / `OPENAI_MODEL_NAME`, else `gpt-4.1-mini` (the `openai` row); resolve that string with the same table. `azure/…` uses `azure-ai-inference`, which has no OpenInference instrumentor: tell the user model calls won't be recorded.
- Find every `kickoff` call site (`crew.kickoff`, `kickoff_async`, `akickoff`, `flow.kickoff`, `flow.handle_turn`, `flow.resume`, `Agent.kickoff`) and how conversations are identified (chat id, thread id, session row, flow `state.id`).
- Search for an existing `TracerProvider`, `trace.set_tracer_provider`, `opentelemetry-instrument`, `logfire.configure`, `phoenix.otel.register`, `langfuse`, `sentry_sdk.init`, `CrewAIInstrumentor`, `litellm.callbacks = ["otel"]`. If a provider exists, REUSE it: add Maple's exporter and the processor below to it and pass it to `instrument()`. Never create a second provider. If an instrumentor's `instrument()` already runs, change that call instead of adding another.
- Search for `OTEL_SDK_DISABLED`. If set to true, remove it (it kills the whole SDK) and replace with `CREWAI_DISABLE_TELEMETRY=true`.

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
pip install "crewai>=1.15" "openinference-instrumentation-crewai>=1.1.18" \
  "openinference-instrumentation-openai>=0.1.61" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Use the repo's package manager (`uv add`, `poetry add`...). Swap/add the model-SDK instrumentor per the Step 0 table.

Environment (in the repo's env mechanism):

```bash
OTEL_SERVICE_NAME=<service name, e.g. the app/package name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
CREWAI_DISABLE_TELEMETRY=true
CREWAI_TRACING_ENABLED=false
```

- Base URL only. `OTLPSpanExporter()` with no args appends `/v1/traces`. If you pass `endpoint=` in code, it must end in `/v1/traces`.
- `CREWAI_DISABLE_TELEMETRY=true` stops the analytics export to telemetry.crewai.com. `CREWAI_TRACING_ENABLED=false` stops the AMP uploader and its first-run prompt that waits on stdin at exit. Both must be in the environment before `crewai` is imported (env file loaded by the process, or `os.environ.setdefault(...)` at the top of `tracing.py` if the repo has no env mechanism).

Create `tracing.py` (adapt the module path to the repo layout):

```py
# tracing.py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.crewai import CrewAIInstrumentor
from openinference.instrumentation.openai import OpenAIInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


class CrewAIAgentNames(SpanProcessor):
    """Copies each CrewAI agent's role to gen_ai.agent.name, which Maple uses for agent lanes."""

    def on_start(self, span, parent_context=None):
        # The instrumentor records the role (graph.node.id) just after the agent span starts,
        # so name the agent span when its first child starts, while it's still open.
        parent = trace.get_current_span(parent_context)
        attrs = getattr(parent, "attributes", None) or {}
        role = attrs.get("graph.node.id")
        if role and "gen_ai.agent.name" not in attrs and parent.is_recording():
            parent.set_attribute("gen_ai.agent.name", role)


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(CrewAIAgentNames())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

config = TraceConfig(enable_genai_semconv=True)
CrewAIInstrumentor().instrument(tracer_provider=provider, config=config, skip_dep_check=True)
OpenAIInstrumentor().instrument(tracer_provider=provider, config=config, skip_dep_check=True)
```

- `import tracing` at the top of every entry point (web app module, worker, CLI main, `main.py` of a `crewai create` project) so `instrument()` runs before the first kickoff.
- Other SDKs: add `AnthropicInstrumentor().instrument(...)` etc. with the same `tracer_provider`, `config` and `skip_dep_check=True`. Only for SDKs the app uses (Step 0).
- Existing provider: skip `TracerProvider()`/`set_tracer_provider`, add `CrewAIAgentNames()` and the exporter to the existing provider, pass it as `tracer_provider=`.
- `enable_genai_semconv=True` on EVERY instrumentor is required. The env var `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` is equivalent only if set before `instrument()`; prefer the code form.
- Keep `skip_dep_check=True`: a failed version check makes `instrument()` skip itself with only an error log.
- Keep `CrewAIAgentNames` exactly, and add it BEFORE the `BatchSpanProcessor`.

## Step 3: One session per conversation

CrewAI has no conversation id; each `kickoff()` is its own trace. `crew_id` (new per Crew object) and `crew_key` (same for every user of a crew) are NOT conversation ids. Maple reads `session.id` for CrewAI, and the instrumentors set it only inside `using_session`:

```py
from crewai import LLM, Agent, Crew, Task
from openinference.instrumentation import using_session

llm = LLM(model="openai/gpt-4o-mini", temperature=0)


def build_crew(text: str, history: str, stream: bool = False) -> Crew:
    assistant = Agent(
        role="assistant",
        goal="Answer the user's questions",
        backstory="You are a concise, helpful assistant.",
        llm=llm,
        tools=[get_weather, calculate],
    )
    task = Task(
        description=f"{text}\n\nConversation so far:\n{history}",
        expected_output="A short, direct reply to the user.",
        agent=assistant,
        name="reply",
    )
    return Crew(name="support", agents=[assistant], tasks=[task], stream=stream)


def handle_message(conversation_id: str, text: str, history: str) -> str:
    with using_session(conversation_id):
        return build_crew(text, history).kickoff().raw
```

- Wrap EVERY kickoff call site in `with using_session(<conversation id>):`. Use the app's stored conversation/chat/thread id. Never a fresh UUID per request, never a constant.
- Conversational flows: `with using_session(sid): flow.handle_turn(text, session_id=sid)`. Use the same id for both. Give the flow class a `name = "<snake_name>"` attribute: unnamed flows produce `Flow_<uuid>.kickoff` roots (then `Flow_<session id>` from the second turn).
- Batch/one-shot crews (no chat): one id per run/job is correct; still wrap the kickoff so the run is a named session instead of `trace:<id>`.
- Give every `Crew` a `name=` (otherwise the root span is `Crew_<uuid>.kickoff`) and every `Task` a `name=`. Put the user's message FIRST in the task description: Maple labels turns with the first line of `Current Task: …`.
- Do not change the app's own history handling beyond that; CrewAI has no chat memory, so the app already passes history somehow.
- `akickoff()` is NOT instrumented (no crew/agent spans, each model/tool call becomes its own trace). Replace `await crew.akickoff(...)` with `await crew.kickoff_async(...)` (same result, runs instrumented `kickoff` in a thread). Same for `Agent.akickoff` -> `Agent.kickoff` in a thread. Tell the user why.
- `Crew(stream=True)` calls `kickoff` twice (an empty stub `kickoff` span + the real one in a second trace). Wrap each streamed turn:

```py
from opentelemetry import trace

tracer = trace.get_tracer("chat")


def stream_message(conversation_id: str, text: str, history: str, send) -> None:
    with using_session(conversation_id), tracer.start_as_current_span(
        "invoke_agent support",
        attributes={
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.conversation.id": conversation_id,
        },
    ):
        for chunk in build_crew(text, history, stream=True).kickoff():
            send(chunk.content)
```

  Iterate INSIDE the `with`. `LLM(stream=True)` alone (no `Crew(stream=True)`) needs no wrapper.
- Tool approvals via `@before_tool_call` + `context.request_human_input(...)` need nothing: the hook runs inside the kickoff before the tool span starts (approved call = one tool span; blocked call = no tool span, model gets `Tool execution blocked by hook`).
- `flow.resume(...)` after `@human_feedback` is not instrumented: wrap it the same way (`using_session` with the same id + the wrapper span).
- Your own spans (plain OTel tracer) don't get `session.id` automatically; give them `attributes=dict(get_attributes_from_context())` (from `openinference.instrumentation`) if you add any beyond the wrapper above.

## Step 4: Content

- On by default: model spans carry the messages CrewAI sent (system = role/goal/backstory, user = `Current Task: …` + context) and the reply; agent spans the task and output; tool spans arguments and results. Leave it on unless the user or repo says prompts are sensitive.
- To turn off: `TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)` passed to every instrumentor (or `OPENINFERENCE_HIDE_INPUTS=true` / `OPENINFERENCE_HIDE_OUTPUTS=true`). Narrower: `hide_input_text`, `hide_output_text`.
- The hide switches do NOT cover `crew_tasks` (task descriptions, i.e. the user's message), `crew_inputs`, `crew_agents` on the `<crew>.kickoff` span, or `flow_inputs` on a flow's kickoff span. If prompts must never leave the infrastructure, tell the user to delete those attributes in an OpenTelemetry Collector (`attributes` processor, `action: delete`).
- Agent roles, task names and tool names are span names and always recorded. Don't put PII in them.
- Do NOT set `share_crew=True` to get content; it only adds data to CrewAI's analytics.

## Step 5: Tools, errors, agents

- Tool exceptions are marked failed automatically (`<tool>.run` span status ERROR with the message). Do not catch exceptions inside tools to return an error string: the span stays OK and Maple won't count the failure.
- Tool spans need native function calling (all providers in the Step 0 table). Custom `BaseLLM` subclasses or LiteLLM models without function calling use the ReAct text path, which the instrumentor doesn't patch: no tool spans. Tell the user.
- Every agent needs a distinct `role`; `CrewAIAgentNames` turns roles into lanes.
- `async_execution=True` tasks keep context (siblings under the crew span). Nothing to do.
- `Process.hierarchical`: delegated coworker work (`Delegate work to coworker` / `Ask question to coworker` tools) runs through un-instrumented `Agent.execute_task`: its model calls sit inside the tool span, no lane. Known; not fixable here.
- Known, not fixable here: no `gen_ai.tool.call.id` on tool spans.

## Step 6: Flush

- `TracerProvider` flushes on normal interpreter exit (atexit). That covers servers and CLIs that exit normally, including `crewai run`.
- Serverless handlers (Lambda, Cloud Run jobs, Modal functions...): call `provider.force_flush()` in a `finally` before returning.
- Scripts that may be killed or call `os._exit`, and notebooks: `provider.force_flush()` after each run; `provider.shutdown()` at the very end.

## Step 7: Verify

Run one real conversation (2-3 messages, same conversation id, at least one tool call), and one message in a second conversation. No scriptable entry point (server, UI, REPL only): write a small driver for this run (one conversation id, 2+ turns, one tool call, flush before exit).

Without Maple access (`MAPLE_TEST`, no MCP): the run must exit with no export errors on stderr (`Failed to export`, 401 lines) AND a local exporter (`provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))` in a scratch run) must show `<crew>.kickoff`, model and `<tool>.run` spans carrying `session.id`. Silence alone proves nothing (no spans is silent too). Say so and list what the user should check in Maple. With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

Otherwise check in Maple **Agent Sessions** (`https://app.maple.dev/agent-sessions`, EU `app.eu.maple.dev`), filtered to the service name:

- Exactly one session per conversation id (two here), not one per message and no `trace:<id>` sessions.
- Framework shows CrewAI in the session list (model spans themselves are tagged `openinference-openai`; that's fine).
- One turn per kickoff; each turn's root span is `<crew name>.kickoff` (or `<flow name>.kickoff`, or your `invoke_agent` wrapper when streaming). No empty extra turns.
- Transcript is non-empty (system message from role/goal/backstory, `Current Task: …`, replies).
- Model calls (`ChatCompletion` for the OpenAI instrumentor) have a model and non-zero input/output tokens, including streamed calls. Each call appears once.
- Tool calls `<tool>.run` with results; a tool that raised is counted as failed and nothing else is.
- One lane per agent role (`<role>.<task>._execute_core` spans carry `gen_ai.agent.name`).
- Cost: unpriced unless models go through LiteLLM (which records `llm.cost.total`). Expected.
- No spans with scope `crewai.telemetry`, no `coding_agent` attribute (telemetry is off).

Edge cases:

- Tokens: model spans carry `gen_ai.usage.input_tokens`/`output_tokens` (plus cached and reasoning tokens when reported); crew and agent spans carry none, so nothing double-counts. CrewAI's OpenAI provider always requests `stream_options={"include_usage": True}` when streaming, so streamed calls keep tokens.
- Model = the one the provider returned (e.g. `anthropic/claude-haiku-4.5` behind OpenRouter); provider = the SDK used, so every OpenRouter model shows `openai`.
- `memory=True` / `planning=True` add real, billed model calls (memory analysis, embeddings, planning agent); they appear in the session. Expected.
- The Arize Phoenix CrewAI page still recommends the LiteLLM instrumentor; ignore it for native providers (it records nothing there).
- Flow span layout: `<flow name>.kickoff` root, one `<flow name>.<method>` span per `@start`/`@listen`/`@router` method, crews and `Agent.kickoff()` nested inside. Conversational flow turns show `<flow>.route_conversation` and `<flow>.converse_turn` under the kickoff.

If sessions are split per message: `using_session` missing or id changing. No model spans/tokens: wrong or missing SDK instrumentor. Every call its own trace: `akickoff`. Nothing arrives: exporter endpoint/header wrong, `.env` loaded after `tracing.py`, `OTEL_SDK_DISABLED=true`, or process exited without flushing. 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust: keys are region-bound, so it likely belongs to the other region; try the other endpoint.

## Do not

- Do not stack two model-layer instrumentors (or `litellm.callbacks=["otel"]`) on the same calls: duplicate model spans and tokens.
