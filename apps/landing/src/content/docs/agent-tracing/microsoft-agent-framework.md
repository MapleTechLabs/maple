---
title: "Trace Microsoft Agent Framework and Semantic Kernel agents with OpenTelemetry"
description: "Send Microsoft Agent Framework and Semantic Kernel traces to Maple so each conversation becomes one Agent Session with its transcript, tool calls, tokens and failures, in Python and .NET."
group: "AI Agents"
order: 30
navLabel: "Microsoft Agent Framework"
icon: "dotnet"
---

Microsoft Agent Framework (MAF) ships its own OpenTelemetry instrumentation in Python and .NET. Every `agent.run()` produces an `invoke_agent` span, a `chat` span per model call and an `execute_tool` span per tool call, using the current GenAI semantic conventions, with tokens (including cache and reasoning buckets) and, once you switch content capture on, the full prompts and replies as span attributes. Workflows add `workflow.run`, `executor.process` and `edge_group.process` spans.

What it doesn't emit is a conversation id. MAF only sets `gen_ai.conversation.id` when the model provider stores the conversation server side, so with Chat Completions, OpenRouter or any local chat history, every turn arrives as its own one-turn session. This guide adds the id with a 15-line span processor.

This guide covers `agent-framework` 1.19 (Python), `Microsoft.Agents.AI` 1.22 (.NET), and Semantic Kernel 1.44 (Python), the framework MAF replaces, which has its own section below.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-microsoft-agent-framework](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-microsoft-agent-framework) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Microsoft Agent Framework in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-microsoft-agent-framework -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Export Agent Framework traces to Maple (Python)

MAF depends on the OpenTelemetry API and SDK but installs no exporter. Add the HTTP one:

```bash
pip install "agent-framework-core>=1.19.0" "agent-framework-openai>=1.14.4" opentelemetry-exporter-otlp-proto-http
```

The `agent-framework` meta-package works too; it pulls in every connector (Azure, Anthropic, Bedrock and more), so install the core and the connectors you use instead.

Call `configure_otel_providers()` once at startup, before you create agents:

```py
# telemetry.py
import os

from agent_framework.observability import configure_otel_providers
from opentelemetry import trace

from maple_tracing import ConversationIdProcessor

configure_otel_providers(
    service_name="support-agent",
    resource_attributes={"deployment.environment.name": "production"},
    otlp_endpoint="https://ingest.maple.dev",  # EU: https://ingest.eu.maple.dev
    otlp_protocol="http/protobuf",
    otlp_headers={"Authorization": f"Bearer {os.environ['MAPLE_INGEST_KEY']}"},
    enable_sensitive_data=True,   # prompts, replies, tool arguments and results
    enable_message_events=False,  # skip the duplicate copy of the content in OTLP logs
)
trace.get_tracer_provider().add_span_processor(ConversationIdProcessor())
```

`ConversationIdProcessor` comes from the next section. Instrumentation itself is on by default, so this is the whole setup: `configure_otel_providers()` builds the tracer, meter and logger providers and an OTLP exporter for each. It appends `/v1/traces`, `/v1/metrics` and `/v1/logs` to the endpoint for you.

**Set the protocol explicitly.** MAF defaults to gRPC, unlike the OpenTelemetry spec's `http/protobuf`. Without `otlp_protocol` (or `OTEL_EXPORTER_OTLP_PROTOCOL`), the exporter fails with an import error if the gRPC package isn't installed, or silently retries a gRPC connection that never succeeds if it is.

The same configuration through environment variables, with a bare `configure_otel_providers()` call:

```bash
export OTEL_SERVICE_NAME="support-agent"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export ENABLE_SENSITIVE_DATA="true"
export ENABLE_MESSAGE_EVENTS="false"
```

If your app already configures OpenTelemetry (Azure Monitor, Logfire, your own `TracerProvider`), don't call `configure_otel_providers()`. Add Maple's exporter and `ConversationIdProcessor` to the provider you have, and call `enable_instrumentation(enable_sensitive_data=True, enable_message_events=False)` from `agent_framework.observability`.

## Export Agent Framework traces to Maple (.NET)

```bash
dotnet add package Microsoft.Agents.AI --version 1.22.0
dotnet add package Microsoft.Agents.AI.OpenAI --version 1.22.0
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.19.1
```

Instrument the agent with `UseOpenTelemetry()`. In 1.22 it also instruments the agent's chat client, so you get the `chat` and `execute_tool` spans without wrapping the `IChatClient` yourself:

```csharp
using System.ClientModel;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

using var tracerProvider = Sdk.CreateTracerProviderBuilder()
    .ConfigureResource(r => r.AddService("support-agent"))
    .AddSource("*Microsoft.Agents.AI*")    // agent, chat and workflow spans
    .AddSource("*Microsoft.Extensions.AI") // chat clients you instrument yourself
    .AddProcessor(new ConversationIdProcessor())
    .AddOtlpExporter(o =>
    {
        o.Endpoint = new Uri("https://ingest.maple.dev/v1/traces"); // EU: ingest.eu.maple.dev
        o.Protocol = OtlpExportProtocol.HttpProtobuf;
        o.Headers = "Authorization=Bearer YOUR_INGEST_KEY";
    })
    .Build();

var openAi = new OpenAIClient(
    new ApiKeyCredential(Environment.GetEnvironmentVariable("OPENAI_API_KEY")!));

AIAgent agent = openAi.GetChatClient("gpt-4o-mini").AsIChatClient()
    .AsAIAgent(
        instructions: "You are a helpful assistant.",
        name: "support_agent",
        tools: [AIFunctionFactory.Create(GetWeather, name: "get_weather")])
    .AsBuilder()
    .UseOpenTelemetry(configure: a => a.EnableSensitiveData = true)
    .Build();
```

Pass each tool a `name`. `AIFunctionFactory.Create` otherwise uses the method name, and a local function in a top-level `Program.cs` compiles to something like `_Main_g_GetWeather_0_3`, which is what Maple then shows as the tool.

The wildcards matter. With no `sourceName`, the agent emits on `Experimental.Microsoft.Agents.AI`, and `Microsoft.Extensions.AI` chat clients on `Experimental.Microsoft.Extensions.AI`. A plain `AddSource("Microsoft.Agents.AI.*")`, as some samples use, matches neither, and you get zero spans. Workflows emit on `Microsoft.Agents.AI.Workflows` once you call `.WithOpenTelemetry()` on the `WorkflowBuilder`.

When you set `Endpoint` in code, it must include `/v1/traces`, and the .NET exporter also defaults to gRPC, so keep the `HttpProtobuf` line. .NET agent spans show up under the **Unidentified** framework in Maple (the Python instrumentation scope is what identifies MAF); sessions, transcripts, tokens and tools work the same. The agent span is named `invoke_agent support_agent(<agent id>)` in .NET, while `gen_ai.agent.name` stays `support_agent`.

## Group every turn of a conversation into one session

Maple groups traces into a session by `gen_ai.conversation.id`. On an ordinary `agent.run()`, MAF writes that attribute only from the provider's own conversation id (`AgentSession.service_session_id`), which exists when the Responses API stores history (`store=True`) or a Foundry agent owns the thread. With Chat Completions, OpenRouter, Ollama, or anything that keeps history in an `AgentSession` in your process, it's never set. The session's own `session_id` isn't exported either.

Skip this and every `agent.run()` is its own session in Maple, named after its trace id: a ten-message chat becomes ten one-turn sessions, and a human-in-the-loop approval splits a turn in two.

Two things look like fixes and aren't:

- **`gen_ai.agent.id`** is a random id per `Agent` object. A server that builds one agent at startup stamps the same value on every user's conversation.
- **The `conversation_id` chat option** (`Agent(..., conversation_id=...)` or `options={"conversation_id": ...}`) does reach the `invoke_agent` span, but it's a provider setting, not a label. It turns off the in-memory history MAF adds to a session, and the Responses API client sends it as `previous_response_id`.

Instead, add this processor. It stamps the id on every span started inside a `conversation()` block, including the `chat`, `execute_tool` and workflow spans, and it follows `asyncio` tasks the block creates:

```py
# maple_tracing.py
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

Wrap each request in it. The session's `session_id` is a good id: it's stable for the life of the conversation and survives `to_dict()`/`from_dict()` if you persist sessions.

```py
from agent_framework import Agent, AgentSession
from agent_framework.openai import OpenAIChatCompletionClient

from maple_tracing import conversation

agent = Agent(
    OpenAIChatCompletionClient(model="gpt-4o-mini"),
    "You are a helpful assistant.",
    name="support_agent",
    tools=[get_weather, calculate],
)


async def handle_message(session: AgentSession, text: str) -> str:
    with conversation(session.session_id):
        response = await agent.run(text, session=session)
    return response.text
```

Create the session with your own chat id if you have one: `agent.create_session(session_id=chat_id)`. For streaming, keep the whole `async for` inside the block, because the `chat` span starts on the first pull:

```py
with conversation(session.session_id):
    async for update in agent.run(text, session=session, stream=True):
        print(update.text, end="")
```

In .NET, the same idea is an `Activity` processor with an `AsyncLocal`:

```csharp
using System.Diagnostics;
using OpenTelemetry;

sealed class ConversationIdProcessor : BaseProcessor<Activity>
{
    public static readonly AsyncLocal<string?> Current = new();

    public override void OnStart(Activity activity)
    {
        if (Current.Value is { } id) activity.SetTag("gen_ai.conversation.id", id);
    }
}
```

```csharp
AgentSession session = await agent.CreateSessionAsync();
ConversationIdProcessor.Current.Value = chatId; // once per request, before RunAsync
var response = await agent.RunAsync(userMessage, session);
```

## Record prompts, responses and tool calls

Content is off by default in both languages. Without it, Maple shows the model, tokens and timing of each call, but the transcript is empty and tool calls have no arguments or results.

- **Python:** `enable_sensitive_data=True` or `ENABLE_SENSITIVE_DATA=true`. Content lands on the spans as `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`, which is the shape Maple reads.
- **.NET:** `EnableSensitiveData = true` in the `UseOpenTelemetry` callback, or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`.

Two Python settings change where content goes:

- `OTEL_SEMCONV_STABILITY_OPT_IN`: MAF uses the current GenAI conventions only while this variable is unset or includes `gen_ai_latest_experimental`. If another library in your app sets it to something like `http`, MAF drops back to the v1.36 conventions: the message attributes and tool arguments disappear from the spans and the content goes to log events, which Maple doesn't read for sessions. Use `OTEL_SEMCONV_STABILITY_OPT_IN=http,gen_ai_latest_experimental`.
- `ENABLE_MESSAGE_EVENTS` defaults to `true` and sends a second copy of every message as OTLP log records. Maple builds the transcript from span attributes, so turn it off unless another tool reads those logs.

With content on, everything the user types and every tool result is stored in Maple. To keep a service's content out, leave sensitive data off there and keep the spans; sessions, tokens, tool names and failures still work. Tool definitions (`gen_ai.tool.definitions`, the JSON schema of each tool) are sent on every `invoke_agent` span even with sensitive data off.

## Tools, errors and sub-agents

Each function tool call is an `execute_tool <tool name>` span with `gen_ai.tool.name`, `gen_ai.tool.call.id`, the arguments and the result. When a tool raises, MAF marks that span ERROR with `error.type` (the exception class) and the message in the status, then hands the model an error string as the tool result so the run continues. Maple counts the failure on the tool, and the agent and `chat` spans above it stay green, which is correct: the turn itself succeeded. .NET does the same (`error.type=System.InvalidOperationException`, for example).

Python MAF also logs each tool failure as an ERROR and a WARN record. `configure_otel_providers()` exports those to Maple as logs, next to the span.

Give every agent a distinct `name`. Maple opens a sub-agent lane when an `invoke_agent` span's `gen_ai.agent.name` differs from its parent's, and an agent with no name gets its UUID as the name.

The simplest multi-agent pattern is agents as tools. The orchestrator's `execute_tool weather_worker` span has the worker's `invoke_agent weather_worker` span as its child, which Maple shows as a delegation with the task and the answer:

```py
weather_worker = Agent(client, "Report current weather.", name="weather_worker", tools=[get_weather])
budget_worker = Agent(client, "Estimate trip costs.", name="budget_worker", tools=[calculate])

orchestrator = Agent(
    client,
    "Delegate each part of the briefing to the right worker, then summarize.",
    name="orchestrator",
    tools=[weather_worker.as_tool(), budget_worker.as_tool()],
)

with conversation(session.session_id):
    result = await orchestrator.run(brief, session=session)
```

Workflows (`WorkflowBuilder`, or the `SequentialBuilder`, `ConcurrentBuilder`, `HandoffBuilder` and `MagenticBuilder` orchestrations) trace each executor as `executor.process <id>` with the agent's `invoke_agent` span inside it. Fan-in is recorded as span links, not parent-child, so parallel workers appear as siblings under `workflow.run`. The executors run as `asyncio` tasks and inherit the conversation id from the block.

Build the workflow inside the `conversation()` block too. `WorkflowBuilder.build()` emits its own one-span `workflow.build` trace. Inside the block it joins the session as a short extra trace with no model calls; built once at import time, it becomes a one-span session of its own.

Tools that need approval (`@tool(approval_mode="always_require")`) end the run with a pending request. The resume is a new `agent.run()` and a new trace; with the processor in place, it joins the same session. A rejected call emits no `execute_tool` span at all; the rejection only appears in the next `chat` span's input messages.

## Tokens and cost

Every `chat` span carries `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus `cache_read.input_tokens`, `cache_creation.input_tokens` and `reasoning.output_tokens` when the provider returns them. Streaming works without extra settings: the OpenAI chat completions client requests `include_usage` itself.

The `invoke_agent` span repeats the total of that agent's own `chat` calls. A sub-agent called as a tool reports its calls on its own `invoke_agent` span, not the orchestrator's. Maple subtracts the child `chat` spans, so the session total counts each call once.

In .NET, streamed `chat` spans also carry `gen_ai.response.time_to_first_chunk`, which Maple shows as time to first token. Python MAF doesn't record it.

MAF emits no cost attribute, and Maple doesn't price tokens, so sessions show as unpriced. `gen_ai.provider.name` on `chat` spans is the client type (`openai` for the OpenAI client, even when it points at OpenRouter or Ollama), and `server.address` holds the real base URL.

## Flush before a short-lived process exits

`configure_otel_providers()` uses batch processors, and MAF has no flush helper. A script, CLI, notebook cell or serverless handler that exits without flushing loses its last turns. Shut the three providers down in a `finally`:

```py
from opentelemetry import _logs, metrics, trace


def shutdown_telemetry() -> None:
    for provider in (trace.get_tracer_provider(), metrics.get_meter_provider(), _logs.get_logger_provider()):
        provider.shutdown()  # exports whatever is still buffered


try:
    asyncio.run(main())
finally:
    shutdown_telemetry()
```

For a long-running server, don't shut down per request. In a serverless handler that is frozen between invocations, call `trace.get_tracer_provider().force_flush()` before returning.

In .NET, `using var tracerProvider` flushes on dispose at the end of `Main`. In a hosted app, `AddOpenTelemetry()` flushes on graceful shutdown.

## Semantic Kernel

Semantic Kernel (SK) 1.44 is in maintenance while Microsoft moves agent work to MAF, and its telemetry differs in four ways.

**It's gated by environment variables read at import time.** Set them before the first `import semantic_kernel`, or SK emits no GenAI spans and logs no warning. SK brings no exporter or provider, so set up your own:

```bash
pip install "semantic-kernel>=1.44.1" opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

`semantic-kernel` 1.44 depends on a pre-release `azure-ai-agents`, so `uv` needs `--prerelease=allow`; pip resolves it as is.

```py
# telemetry.py: import this before anything that imports semantic_kernel
import os

os.environ["SEMANTICKERNEL_EXPERIMENTAL_GENAI_ENABLE_OTEL_DIAGNOSTICS"] = "true"
os.environ["SEMANTICKERNEL_EXPERIMENTAL_GENAI_ENABLE_OTEL_DIAGNOSTICS_SENSITIVE"] = "true"

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from maple_tracing import ConversationIdProcessor

provider = TracerProvider(resource=Resource.create({"service.name": "support-agent"}))
provider.add_span_processor(ConversationIdProcessor())
provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(
            endpoint="https://ingest.maple.dev/v1/traces",  # EU: https://ingest.eu.maple.dev/v1/traces
            headers={"Authorization": f"Bearer {os.environ['MAPLE_INGEST_KEY']}"},
        )
    )
)
trace.set_tracer_provider(provider)
```

**Model-call content goes to Python logging, not spans.** The `chat <model>` spans carry model, tokens and finish reason; the prompts and replies are log records Maple doesn't read. The transcript comes from the agent instead: `ChatCompletionAgent` puts the messages you pass in and the reply on its `invoke_agent` span as `gen_ai.input.messages` and `gen_ai.output.messages`. Pass the messages positionally, `await agent.get_response(text, thread=thread)`. SK reads them from the second positional argument, and `get_response(messages=text, ...)` records an empty input. Code that calls the kernel directly (`kernel.invoke_prompt`, a chat service without an agent) has no transcript in Maple.

**There's no conversation id either.** `ChatHistoryAgentThread.id` isn't exported, so use the same `ConversationIdProcessor` and wrap each request in `with conversation(thread_id):`.

**The agent runtime splits orchestrations across traces.** `ConcurrentOrchestration`, `SequentialOrchestration` and the other orchestrations run on `InProcessRuntime`, which starts each message on a new trace. One run became 10 traces in our test. Open your own span around the run and start the runtime inside the `conversation()` block, so the runtime's tasks inherit both:

```py
tracer = trace.get_tracer("support-agent")

with conversation(conversation_id), tracer.start_as_current_span("briefing"):
    runtime = InProcessRuntime()
    runtime.start()
    result = await orchestration.invoke(task=brief, runtime=runtime)
    output = await result.get()
    await runtime.stop_when_idle()
```

Smaller differences: tool spans are named `execute_tool <Plugin>-<function>`, failing tools get ERROR status and `error.type` but no result attribute, finish reasons are Python enum names (`FinishReason.STOP`) so Maple's reply-length and refusal checks can't read them, and a `temperature` of `0` is left off the span. Flush with `provider.shutdown()` as above.

In .NET, SK reads the same variables, or the `AppContext` switches `Microsoft.SemanticKernel.Experimental.GenAI.EnableOTelDiagnostics` and `...EnableOTelDiagnosticsSensitive`. Add `AddSource("Microsoft.SemanticKernel*")` to the tracer provider. SK .NET spans show up under the **Unidentified** framework in Maple.

## Check that it works

Run one conversation of two or three turns, one of which calls a tool. Sessions appear in **Agent Sessions** within about a minute. You should see:

- **One session per conversation**, labeled **Microsoft Agent Framework** (or **Semantic Kernel**) for Python, whose id is your conversation id, not `trace:…`. A second conversation is a second session.
- **One turn per `agent.run()`**, each rooted at `invoke_agent support_agent` with `chat gpt-4o-mini` and `execute_tool get_weather` spans under it. An approval resume is its own turn in the same session. In .NET the root is `invoke_agent support_agent(<agent id>)`.
- **A transcript** with the system instructions, your messages and the replies, labeled by the first line of each user message.
- **Tool calls** with arguments and results, and failed tools counted under **Tool errors**.
- **Tokens** on every model call, including streamed ones. Cost shows as unpriced.
- For multi-agent runs, a lane per agent name.

## Troubleshooting

- **Nothing arrives, no error.** The protocol is still gRPC. Set `otlp_protocol="http/protobuf"` or `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`. If you set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, it's used as is and needs the `/v1/traces` path.
- **`ImportError: opentelemetry-exporter-otlp-proto-grpc is required`.** Same cause: the protocol defaulted to gRPC.
- **Every turn is its own session.** No `gen_ai.conversation.id`. Register `ConversationIdProcessor` and wrap the call, including the whole `async for` when streaming, in `conversation()`.
- **Every user shares one session.** The id is a process-wide constant: `gen_ai.agent.id`, a module-level string, or `conversation()` called once at startup. Use a per-conversation id.
- **An extra session with a single `workflow.build` span.** The workflow was built outside `conversation()`. Build it per request inside the block.
- **Spans but an empty transcript (Python).** Sensitive data is off, or `OTEL_SEMCONV_STABILITY_OPT_IN` is set without `gen_ai_latest_experimental`.
- **The agent forgets earlier turns after adding tracing.** You passed `conversation_id` as a chat option, which disables the in-memory history. Remove it and use the processor.
- **Every message part is one character.** `Message("user", text)` iterates a bare string; pass a list: `Message("user", [text])`.
- **OpenRouter rejects the second turn with a `previous_response_id` error.** `OpenAIChatClient` is the Responses API client. Use `OpenAIChatCompletionClient` for OpenRouter and other Chat Completions endpoints.
- **A WARN log "Ignored an approval response ... did not match the active approval occurrence identity", but the tool ran.** Seen on every approval resume with `to_function_approval_response()` in 1.19. The `execute_tool` span shows the approved call ran once; the log is noise.
- **.NET: no spans at all.** `AddSource` doesn't match the default `Experimental.` prefix. Use `AddSource("*Microsoft.Agents.AI*")`.
- **.NET: tools named like `_Main_g_GetWeather_0_3`.** The tool is a local function in a top-level `Program.cs`. Pass `name:` to `AIFunctionFactory.Create`.
- **Semantic Kernel: `AutoFunctionInvocationLoop` spans but no `chat` or `invoke_agent`.** The `SEMANTICKERNEL_EXPERIMENTAL_GENAI_*` variables were set after `semantic_kernel` was imported.
- **Semantic Kernel: an orchestration shows as many small sessions or traces.** Wrap the run in your own span and `conversation()` and start the runtime inside it.

## Related

- [Agent Sessions](/docs/agent-sessions/overview): what a session, turn, model call and tool call are in Maple.
- [Trace your AI agent](/docs/agent-tracing): guides for other frameworks.
- [Python instrumentation](/docs/guides/instrumentation-python) and [.NET instrumentation](/docs/guides/instrumentation-csharp): tracing the rest of the service.
- [Agent Framework observability](https://learn.microsoft.com/en-us/agent-framework/agents/observability): Microsoft's reference for the settings above.
- [Semantic Kernel telemetry](https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/observability/): the SK diagnostics switches.
