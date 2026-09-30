---
title: "Trace Pydantic AI agents with OpenTelemetry"
description: "Send Pydantic AI's built-in OpenTelemetry spans to Maple so each conversation shows up as one Agent Session."
group: "AI Agents"
order: 20
navLabel: "Pydantic AI"
icon: "pydantic"
---

Pydantic AI already emits OpenTelemetry spans for runs, model calls and tool calls. You export them to Maple and pass a conversation id on every run. Without the id, each message becomes its own session.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-pydantic-ai](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-pydantic-ai) skill and follows it.

```text
Set up Maple agent tracing for Pydantic AI in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-pydantic-ai -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Export spans to Maple

Install the OpenTelemetry SDK and the OTLP/HTTP exporter next to Pydantic AI. Swap `[openai]` for the extras of the providers you use.

```bash
pip install "pydantic-ai-slim[openai]>=2.51" "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Point the exporter at Maple. For an EU organization, use `https://ingest.eu.maple.dev`.

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
```

Set up tracing once, when your process starts:

```py
# tracing.py
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

Import `tracing` at the top of your entry point (`main.py`, the FastAPI app module, the worker), before the first `agent.run()`.

If your app already has a `TracerProvider` (from `opentelemetry-instrument`, Sentry or your own setup), add the `BatchSpanProcessor` to it instead of creating a second one, and call `Agent.instrument_all(InstrumentationSettings(include_content=True, include_binary_content=False))` without `tracer_provider`.

### If you already use Logfire

Skip the `pip install` above, because it conflicts with Logfire's OpenTelemetry pins. Keep the three environment variables. Logfire exports to Maple whenever `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

```py
import logfire

logfire.configure(service_name="support-agent", environment="production", send_to_logfire=False)
logfire.instrument_pydantic_ai()
```

Logfire scrubs tool arguments and results by default. If they arrive as `[Scrubbed due to ...]`, see Troubleshooting.

## Pass the conversation id on every run

Pass the chat or thread id your app already has as `conversation_id=` on every `run()`, `run_stream()` and `iter()`:

```py
from pydantic_ai import Agent

support = Agent("openai:gpt-4o-mini", name="support")


async def handle_message(chat_id: str, text: str, history: list) -> str:
    result = await support.run(text, conversation_id=chat_id, message_history=history)
    return result.output
```

The id must stay the same for the whole conversation and differ between conversations.

When streaming, keep the `async with` block open until the stream is finished. The run's span ends when the block exits.

```py
async def stream_reply(chat_id: str, text: str, history: list):
    async with support.run_stream(text, conversation_id=chat_id, message_history=history) as run:
        async for delta in run.stream_text(delta=True):
            yield delta
```

### Sub-agents

When a tool runs another agent, pass `conversation_id` and `usage` from the tool's context. Give every agent a `name=` so each one gets its own lane.

```py
from pydantic_ai import Agent, RunContext

weather_worker = Agent("openai:gpt-4o-mini", name="weather_worker", tools=[get_weather])
orchestrator = Agent("openai:gpt-4o-mini", name="orchestrator")


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

## Flush short-lived processes

A Lambda, a killed worker or a notebook kernel doesn't exit normally, so flush explicitly:

```py
import asyncio

from opentelemetry import trace


def handler(event, context):
    try:
        return asyncio.run(handle_message(event["chat_id"], event["text"], []))
    finally:
        trace.get_tracer_provider().force_flush()
```

In a script or CLI, call `provider.shutdown()` at the end. With Logfire, use `logfire.force_flush()` or `logfire.shutdown()`.

## Check that it works

If Pydantic AI prints an `observability: off` banner on the first run, `tracing.py` didn't run before your first `agent.run()`.

Run a conversation with two messages and a tool call, then open **Agent Sessions**. You should see one session with your conversation id and framework **Pydantic AI**, one turn per `run()`, a transcript with prompts, replies and tool calls, and token counts and cost on every model call.

## Troubleshooting

- **Every message is its own session.** Pass `conversation_id=` on every `run()`, `run_stream()` and `iter()`.
- **A multi-agent run is split into several turns or sessions.** Pass `conversation_id=ctx.conversation_id` to every nested `run()`.
- **Tool arguments or results read `[Scrubbed due to ...]`.** Logfire's scrubbing matched a word like `session` or `auth`. Pass `scrubbing=logfire.ScrubbingOptions(callback=...)` that keeps `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`, or `scrubbing=False`.
- **A failed tool shows as successful.** The tool returned an error value. Raise `ToolFailed("...")` so the call is marked failed and the model still sees the message.
- **Spans show up twice.** Another instrumentor (Logfire's `instrument_openai()`, OpenInference, OpenLLMetry) also traces the model client. Remove it and keep Pydantic AI's.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Instrument a Python application](/docs/guides/instrumentation-python)
