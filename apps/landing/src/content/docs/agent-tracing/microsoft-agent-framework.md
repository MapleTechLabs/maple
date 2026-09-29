---
title: "Trace Microsoft Agent Framework and Semantic Kernel agents with OpenTelemetry"
description: "Send Microsoft Agent Framework and Semantic Kernel traces from Python or .NET to Maple as one Agent Session per conversation."
group: "AI Agents"
order: 30
navLabel: "Microsoft Agent Framework"
icon: "dotnet"
---

Microsoft Agent Framework (MAF) emits OpenTelemetry spans for every agent run, model call and tool call in Python and .NET. It does not set a conversation id when your app keeps chat history itself, so you add one with a short span processor, or every turn shows up as its own session.

Tested with `agent-framework` 1.19 (Python), `Microsoft.Agents.AI` 1.22 (.NET) and Semantic Kernel 1.44 (Python).

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-microsoft-agent-framework](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-microsoft-agent-framework) skill.

```text
Set up Maple agent tracing for Microsoft Agent Framework in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-microsoft-agent-framework -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. EU organizations should say EU region.

## Export traces from Python

MAF installs no exporter, so add the OTLP/HTTP one:

```bash
pip install "agent-framework-core>=1.19.0" "agent-framework-openai>=1.14.4" opentelemetry-exporter-otlp-proto-http
```

Call `configure_otel_providers()` once at startup, before you create agents. `enable_sensitive_data=True` records prompts, replies and tool arguments and results; without it the transcript is empty.

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

Keep `otlp_protocol="http/protobuf"`. MAF defaults to gRPC, which Maple doesn't accept.

If your app already has a `TracerProvider` (Azure Monitor, Logfire, your own), don't call `configure_otel_providers()`. Add Maple's exporter and `ConversationIdProcessor` to your provider, then call `enable_instrumentation(enable_sensitive_data=True, enable_message_events=False)` from `agent_framework.observability`.

## Export traces from .NET

```bash
dotnet add package Microsoft.Agents.AI --version 1.22.0
dotnet add package Microsoft.Agents.AI.OpenAI --version 1.22.0
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.19.1
```

`UseOpenTelemetry()` on the agent also instruments its chat client:

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

Keep the leading `*` in `AddSource`: the default source names start with `Experimental.`, so `AddSource("Microsoft.Agents.AI.*")` matches nothing. Keep `/v1/traces` in the endpoint and the `HttpProtobuf` line. Pass each tool a `name`, or a local function in `Program.cs` shows up as something like `_Main_g_GetWeather_0_3`.

## Group each conversation into one session

Maple groups turns by `gen_ai.conversation.id`. MAF sets it only when the provider stores the conversation (Responses API with `store=True`, Foundry agents). This processor stamps your id on every span started inside a `conversation()` block:

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

Wrap each request in it. `session.session_id` works as the id, or create the session with your own chat id: `agent.create_session(session_id=chat_id)`.

```py
from agent_framework import AgentSession

from maple_tracing import conversation


async def handle_message(session: AgentSession, text: str) -> str:
    with conversation(session.session_id):
        response = await agent.run(text, session=session)
    return response.text
```

When streaming, keep the whole `async for` loop inside the block. Build workflows inside it too, or `WorkflowBuilder.build()` shows up as a separate one-span session. Don't use `gen_ai.agent.id` or the `conversation_id` chat option as the id; the first is shared by every user and the second turns off MAF's in-memory history.

In .NET, use an `Activity` processor with an `AsyncLocal` and set it before `RunAsync`:

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

## Flush before a script exits

`configure_otel_providers()` batches spans. Scripts, CLIs and notebooks that exit without flushing lose their last turns, so shut the providers down in a `finally`:

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

In a serverless handler, call `trace.get_tracer_provider().force_flush()` before returning. In .NET, `using var tracerProvider` flushes when `Main` ends.

## Semantic Kernel

Semantic Kernel (SK) reads its telemetry switches at import time, so set them before the first `import semantic_kernel`. SK brings no exporter, so configure your own provider with the same `ConversationIdProcessor`:

```bash
pip install "semantic-kernel>=1.44.1" opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

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

Wrap each turn in `with conversation(thread_id):`. The transcript comes from `ChatCompletionAgent`, so pass messages positionally (`await agent.get_response(text, thread=thread)`); the `messages=` keyword records an empty input. Code that calls the kernel without an agent has no transcript in Maple.

## Check that it works

Run a conversation of two or three turns where one turn calls a tool. Within about a minute, **Agent Sessions** shows one session for it, labeled **Microsoft Agent Framework** or **Semantic Kernel** (.NET shows **Unidentified**), with one turn per `agent.run()`, the transcript, and tool calls with their arguments and results. Cost shows as unpriced because MAF doesn't emit one.

## Troubleshooting

- **Nothing arrives, or `ImportError: opentelemetry-exporter-otlp-proto-grpc is required`.** The protocol defaulted to gRPC. Set `otlp_protocol="http/protobuf"` or `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`.
- **Every turn is its own session.** Register `ConversationIdProcessor` and wrap each call, including the whole streaming loop, in `conversation()`.
- **Spans but an empty transcript.** Sensitive data is off, or `OTEL_SEMCONV_STABILITY_OPT_IN` is set without `gen_ai_latest_experimental` (use `http,gen_ai_latest_experimental`).
- **.NET: no spans at all.** Use `AddSource("*Microsoft.Agents.AI*")` with the leading `*`.
- **Semantic Kernel: no `chat` or `invoke_agent` spans.** The `SEMANTICKERNEL_EXPERIMENTAL_GENAI_*` variables were set after `semantic_kernel` was imported.

## Related

- [Agent Sessions](/docs/agent-sessions/overview): what a session, turn, model call and tool call are in Maple.
- [Trace your AI agent](/docs/agent-tracing): guides for other frameworks.
- [Python instrumentation](/docs/guides/instrumentation-python) and [.NET instrumentation](/docs/guides/instrumentation-csharp): tracing the rest of the service.
- [Agent Framework observability](https://learn.microsoft.com/en-us/agent-framework/agents/observability): Microsoft's reference for the settings above.
- [Semantic Kernel telemetry](https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/observability/): the SK diagnostics switches.
