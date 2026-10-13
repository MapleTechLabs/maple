---
name: maple-agent-tracing-microsoft-agent-framework
description: "Trace Microsoft Agent Framework and Semantic Kernel agents (Python and .NET) with Maple: native GenAI spans exported over OTLP/HTTP, plus a span processor that adds the conversation id so each chat is one Agent Session with transcript, tools and tokens. Triggers on 'trace my agent framework agent', 'add Maple to Microsoft Agent Framework', 'add Maple to Semantic Kernel', 'agent sessions for agent-framework', 'OpenTelemetry for Semantic Kernel'."
---

# Maple agent tracing: Microsoft Agent Framework and Semantic Kernel

Goal: one user conversation = one Maple Agent Session, with a transcript, every model call, every tool call (arguments, results, failures) and tokens.

The framework emits the spans itself. You add: an OTLP/HTTP exporter, content capture, a `gen_ai.conversation.id` span processor (the framework never sets one for local-history sessions), and a flush.

## Step 0: Detect

- Python MAF: `agent-framework`, `agent-framework-core` in `pyproject.toml` / `requirements*.txt` / `uv.lock`. Check the installed version (`python -c "import agent_framework; print(agent_framework.__version__)"`). Target ≥ 1.19.0; upgrade if older (1.13 lacks the `otlp_*` arguments used below).
- .NET MAF: `Microsoft.Agents.AI` in `*.csproj`. Target ≥ 1.22.0.
- Semantic Kernel: `semantic-kernel` (Python, target ≥ 1.44.1) or `Microsoft.SemanticKernel` (.NET). Use the Semantic Kernel section.
- Existing OpenTelemetry: search for `TracerProvider(`, `set_tracer_provider`, `configure_azure_monitor`, `logfire.configure`, `configure_otel_providers`, `AddOpenTelemetry(`, `Sdk.CreateTracerProviderBuilder`. If a provider exists, add Maple's exporter and the conversation processor to it; do not create a second provider and do not call `configure_otel_providers()`.
- Find every place a user message is handled (HTTP route, queue consumer, CLI loop) and what identifies the conversation there (chat id, thread id, `AgentSession`). You need it in Step 3.

## Step 1: Key and region

- US endpoint `https://ingest.maple.dev`, EU `https://ingest.eu.maple.dev`. Header `Authorization=Bearer <key>`. Protocol `http/protobuf`.
- Key in the user's prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's existing secret/env convention (`.env`, settings class, user-secrets). If there is none, inlining the ingest key is acceptable: ingest keys are write-only.
- Key from an env var: when it's unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally (Step 2 shows it). Never raise, exit or throw over the key, no bare `KeyError` on `os.environ['MAPLE_INGEST_KEY']`, and never pass a null `Environment.GetEnvironmentVariable(...)` into the .NET header (`Bearer ` with no key is an opaque 401).
- App loads `.env` (`load_dotenv()`): call it before `configure_otel_providers()` / the provider is built, and before reading the key. Otherwise the exporter silently targets `localhost:4318` with no key.

## Step 2: Install and init

### Python MAF

```bash
pip install "agent-framework-core>=1.19.0" "agent-framework-openai>=1.14.4" opentelemetry-exporter-otlp-proto-http
```

(Keep the `agent-framework` meta-package if the project already uses it; still add `opentelemetry-exporter-otlp-proto-http`, MAF installs no exporter.)

Create `maple_tracing.py` next to the app entry point:

```py
from contextlib import contextmanager
from contextvars import ContextVar

from opentelemetry.sdk.trace import SpanProcessor

_conversation_id: ContextVar[str | None] = ContextVar("conversation_id", default=None)


class ConversationIdProcessor(SpanProcessor):
    """Puts gen_ai.conversation.id on every span started inside `conversation()`."""

    def on_start(self, span, parent_context=None):
        if (conversation_id := _conversation_id.get()) is not None:
            span.set_attribute("gen_ai.conversation.id", conversation_id)


@contextmanager
def conversation(conversation_id: str):
    token = _conversation_id.set(conversation_id)
    try:
        yield
    finally:
        _conversation_id.reset(token)
```

At startup, once, before agents are created:

```py
import logging
import os

from agent_framework.observability import configure_otel_providers
from opentelemetry import trace

from maple_tracing import ConversationIdProcessor

key = os.environ.get("MAPLE_INGEST_KEY")
if key:
    configure_otel_providers(
        service_name="<service-name>",
        resource_attributes={"deployment.environment.name": "<env>"},
        otlp_endpoint="https://ingest.maple.dev",
        otlp_protocol="http/protobuf",
        otlp_headers={"Authorization": f"Bearer {key}"},
        enable_sensitive_data=True,
        enable_message_events=False,
    )
    trace.get_tracer_provider().add_span_processor(ConversationIdProcessor())
else:
    # A missing key disables export; it never stops the app.
    logging.getLogger(__name__).warning("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")
```

Equivalent env-var config, with a bare `configure_otel_providers()` call:

```bash
export OTEL_SERVICE_NAME="<service-name>"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
export ENABLE_SENSITIVE_DATA="true"
export ENABLE_MESSAGE_EVENTS="false"
```

- `otlp_protocol` is mandatory: MAF defaults to gRPC (spec says http/protobuf) and fails silently or with an ImportError.
- `configure_otel_providers()` appends `/v1/traces`, `/v1/metrics`, `/v1/logs` to the endpoint. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, if set, is used as-is and must include `/v1/traces`.
- Existing provider instead: add `BatchSpanProcessor(OTLPSpanExporter(endpoint="https://ingest.maple.dev/v1/traces", headers={...}))` and `ConversationIdProcessor()` to it, then `from agent_framework.observability import enable_instrumentation; enable_instrumentation(enable_sensitive_data=True, enable_message_events=False)`.
- For OpenRouter or any Chat Completions endpoint use `OpenAIChatCompletionClient(model=..., api_key=..., base_url=...)`, not `OpenAIChatClient` (Responses API; OpenRouter rejects its `previous_response_id` on turn 2).

### .NET MAF

```bash
dotnet add package Microsoft.Agents.AI --version 1.22.0
dotnet add package Microsoft.Agents.AI.OpenAI --version 1.22.0
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.19.1
```

```csharp
using var tracerProvider = Sdk.CreateTracerProviderBuilder()
    .ConfigureResource(r => r.AddService("<service-name>"))
    .AddSource("*Microsoft.Agents.AI*")
    .AddSource("*Microsoft.Extensions.AI")
    .AddProcessor(new ConversationIdProcessor())
    .AddOtlpExporter(o =>
    {
        o.Endpoint = new Uri("https://ingest.maple.dev/v1/traces");
        o.Protocol = OtlpExportProtocol.HttpProtobuf;
        o.Headers = "Authorization=Bearer <key>";
    })
    .Build();

AIAgent agent = chatClient
    .AsAIAgent(instructions: "...", name: "<agent_name>", tools: [...])
    .AsBuilder()
    .UseOpenTelemetry(configure: a => a.EnableSensitiveData = true)
    .Build();

sealed class ConversationIdProcessor : BaseProcessor<Activity>
{
    public static readonly AsyncLocal<string?> Current = new();

    public override void OnStart(Activity activity)
    {
        if (Current.Value is { } id) activity.SetTag("gen_ai.conversation.id", id);
    }
}
```

- Default source names carry an `Experimental.` prefix; `AddSource("Microsoft.Agents.AI.*")` matches nothing. Keep the leading `*`.
- `UseOpenTelemetry()` on the agent (1.22) also instruments its chat client. Do not add a second `UseOpenTelemetry()` on the `IChatClient`.
- Name every tool: `AIFunctionFactory.Create(GetWeather, name: "get_weather")`. Without `name:`, a local function in top-level `Program.cs` is exported as `_Main_g_GetWeather_0_3`.
- Workflows: `.WithOpenTelemetry()` on the `WorkflowBuilder` (source `Microsoft.Agents.AI.Workflows`, matched by the wildcard).
- In a hosted app, put the same sources, processor and exporter in `builder.Services.AddOpenTelemetry().WithTracing(...)`.

## Step 3: Conversation id

MAF only sets `gen_ai.conversation.id` from the provider's own conversation id (`AgentSession.service_session_id`: Responses API with `store=True`, or a Foundry agent owning the thread). With Chat Completions, OpenRouter, Ollama or local `AgentSession` history it is never set, and `AgentSession.session_id` is not exported, so every `agent.run()` becomes its own `trace:<id>` session.

Wrap every request/turn so all spans of that turn start inside `conversation(<id>)`:

```py
async def handle_message(session: AgentSession, text: str) -> str:
    with conversation(session.session_id):
        response = await agent.run(text, session=session)
    return response.text
```

- Id: the app's chat/thread id, or `AgentSession.session_id` (create sessions with `agent.create_session(session_id=chat_id)` when the app has an id). Must be stable across all turns of one conversation and differ between conversations.
- Streaming: the whole `async for update in agent.run(..., stream=True)` loop goes inside the `with`.
- Approval resumes (`request.to_function_approval_response(...)` passed back to `agent.run`) and workflow runs go inside the same `with`. 1.19 logs a WARN "Ignored an approval response ... did not match" on each resume even though the tool runs; ignore it if the `execute_tool` span is there once.
- Workflow executors (fan-out included) inherit the id.
- .NET: `ConversationIdProcessor.Current.Value = chatId;` in the request handler before `RunAsync`/`RunStreamingAsync`.

## Step 4: Content

- Python: `enable_sensitive_data=True` (or `ENABLE_SENSITIVE_DATA=true`). .NET: `EnableSensitiveData = true` (or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`).
- If the process sets `OTEL_SEMCONV_STABILITY_OPT_IN`, it must include `gen_ai_latest_experimental` (e.g. `http,gen_ai_latest_experimental`); otherwise MAF moves content off the spans into log events Maple doesn't read.
- `enable_message_events=False`: otherwise every message is also exported as OTLP log records (duplicate payload).
- `gen_ai.tool.definitions` (each tool's JSON schema) is sent on every `invoke_agent` span even with sensitive data off.
- If the user wants no prompt content stored, leave sensitive data off and tell them the transcript and tool arguments/results will be empty.

## Step 5: Tools, errors, sub-agents

- Give every `Agent` a distinct `name` (Maple lanes key on `gen_ai.agent.name`; unnamed agents get a UUID).
- Tool failures: raising from the tool function is enough; MAF sets ERROR + `error.type` on `execute_tool`. Do not catch and return an error string from the tool body (that hides the failure).
- Python MAF also logs each tool failure as an ERROR and a WARN log record; `configure_otel_providers()` exports them as OTLP logs next to the span.
- Approval-gated tools (`@tool(approval_mode="always_require")`): the resume is a new `agent.run()` and trace; it joins the session only inside `conversation()`. A rejected call emits no `execute_tool` span; the rejection only appears in the next `chat` span's input messages, and only with sensitive data on.
- Workflows record fan-in as span links, so parallel executors are siblings under `workflow.run`.
- Sub-agents: prefer `worker.as_tool()` in the orchestrator's `tools=[...]`, or MAF workflows/orchestrations. Do not also instrument the provider SDK (e.g. OpenInference/OpenLLMetry OpenAI instrumentors): that double-counts every call.

## Step 6: Flush

Scripts, CLIs, notebooks, tests, serverless:

```py
from opentelemetry import _logs, metrics, trace

try:
    asyncio.run(main())
finally:
    for provider in (trace.get_tracer_provider(), metrics.get_meter_provider(), _logs.get_logger_provider()):
        provider.shutdown()
```

Serverless handler kept warm: `trace.get_tracer_provider().force_flush()` before returning. Long-running servers: nothing per request. .NET: `using var tracerProvider` disposes at exit; hosted apps flush on graceful shutdown.

## Semantic Kernel

Python (≥ 1.44.1; `uv` needs `--prerelease=allow` for its `azure-ai-agents` dependency):

```bash
pip install "semantic-kernel>=1.44.1" opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

In a module imported before anything that imports `semantic_kernel`:

```py
import logging
import os

os.environ["SEMANTICKERNEL_EXPERIMENTAL_GENAI_ENABLE_OTEL_DIAGNOSTICS"] = "true"
os.environ["SEMANTICKERNEL_EXPERIMENTAL_GENAI_ENABLE_OTEL_DIAGNOSTICS_SENSITIVE"] = "true"

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from maple_tracing import ConversationIdProcessor

provider = TracerProvider(resource=Resource.create({"service.name": "<service-name>"}))
provider.add_span_processor(ConversationIdProcessor())
key = os.environ.get("MAPLE_INGEST_KEY")
if key:
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
        endpoint="https://ingest.maple.dev/v1/traces",
        headers={"Authorization": f"Bearer {key}"},
    )))
else:
    # A missing key disables export; it never stops the app.
    logging.getLogger(__name__).warning("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")
trace.set_tracer_provider(provider)
```

- The env vars are read once at import; set later, SK emits no GenAI spans and no warning.
- Wrap each turn in `with conversation(thread.id):` (`ChatHistoryAgentThread().id` is stable; SK never exports it).
- Call agents with positional messages: `await agent.get_response(text, thread=thread)`, `agent.invoke_stream(text, thread=thread)`. The keyword form `messages=` records empty input.
- Transcript comes only from `invoke_agent` spans (`ChatCompletionAgent`). Model-call content is Python logging, which Maple doesn't read; code that uses the kernel without an agent has no transcript. Tell the user.
- Orchestrations on `InProcessRuntime`: wrap in `with conversation(id), tracer.start_as_current_span("<run name>"):` and call `runtime.start()` inside it, or the run splits into many traces.
- Flush with `provider.shutdown()` in `finally`.
- Other SK differences to expect (not setup bugs): tool spans are `execute_tool <Plugin>-<function>`; failing tools get ERROR + `error.type` but no result attribute; finish reasons are Python enum names (`FinishReason.STOP`), so Maple's reply-length and refusal checks can't read them; `temperature=0` is omitted from spans.
- .NET SK: same env vars (or `AppContext` switches `Microsoft.SemanticKernel.Experimental.GenAI.EnableOTelDiagnostics[Sensitive]`), `AddSource("Microsoft.SemanticKernel*")`, same `ConversationIdProcessor`.

## Step 7: Verify

Run one real conversation (2-3 turns, one tool call; a second conversation if cheap). No scriptable entry point (server, UI, REPL only): write a small driver for this run (one conversation id, 2+ turns, one tool call, flush before exit). With a real key, open Agent Sessions (`https://app.maple.dev/agent-sessions`, EU `app.eu.maple.dev`) after ~1 minute, or with the Maple MCP `list_agent_sessions` with `search=<conversation id>` returns one row. Without Maple access (`MAPLE_TEST`, no MCP): the run must exit with no export errors on stderr (`Failed to export`, 401 lines) AND a local exporter (`ConsoleSpanExporter` added temporarily, or the endpoint pointed at a local collector) must show the spans below with `gen_ai.conversation.id`. Silence alone proves nothing (no spans is silent too). A 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust: keys are region-bound, so it likely belongs to the other region; try the other endpoint. Check:

- Spans arrive and the process exits cleanly (flush ran); `service.name` is yours, not `agent_framework` / `unknown_service`.
- Every span of every turn in one conversation has the same `gen_ai.conversation.id`; a second conversation has a different one. In Maple: one session per conversation, not `trace:<id>` sessions.
- Each turn: `invoke_agent <name>` root (.NET: `invoke_agent <name>(<agent id>)`) with `chat <model>` and `execute_tool <tool>` descendants in the same trace (streamed turn included).
- `chat` spans: `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` (also on the streamed turn), `gen_ai.input.messages` / `gen_ai.output.messages` as JSON arrays of `{role, parts}` (Python MAF; SK: on `invoke_agent` only).
- `execute_tool`: real tool name, `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`; a raising tool has ERROR status + `error.type`, successful ones don't.
- Sub-agents have distinct `gen_ai.agent.name`s.
- No attribute contains the model API key or `Bearer `.
- Cost: none is emitted; Maple shows sessions as unpriced. Framework label: "Microsoft Agent Framework" / "Semantic Kernel".

## Tokens and cost notes

- `chat` spans carry `gen_ai.usage.input_tokens` / `output_tokens` plus cache-read, cache-creation and reasoning buckets when the provider returns them. The OpenAI chat-completions client requests `include_usage` itself when streaming.
- `invoke_agent` repeats the sum of its own `chat` calls; Maple nets it out, so don't strip it.
- `gen_ai.provider.name` is the client type (`openai` even when pointed at OpenRouter or Ollama); `server.address` holds the real base URL.
- .NET streamed `chat` spans carry `gen_ai.response.time_to_first_chunk` (time to first token in Maple); Python MAF doesn't record it.

## Do not

- Do not pass `conversation_id` as an agent/run option to label traces: it disables in-memory history and becomes `previous_response_id` on the Responses client.
- Do not pass a bare string as `Message("user", text)` contents; use `[text]`.
