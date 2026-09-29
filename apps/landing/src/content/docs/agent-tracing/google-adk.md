---
title: "Trace Google ADK agents with OpenTelemetry"
description: "Send Google Agent Development Kit (ADK) traces to Maple with the transcript, tool calls and tokens, one session per ADK session."
group: "AI Agents"
order: 22
navLabel: "Google ADK"
icon: "googleadk"
---

Google's Agent Development Kit (ADK) emits OpenTelemetry spans for every run, agent, model call and tool call, and stamps the ADK session id on them, so a multi-turn chat groups into one Maple session. You need no instrumentation package.

Two things need setup. By default ADK writes prompts and replies into its own attributes, which Maple doesn't read, so you switch it to the GenAI format with two environment variables. And with a plain `Runner`, nothing exports until you register a tracer provider.

Tested with ADK for Python 2.10. ADK for Go and Kotlin emit the same span names, but their setup isn't covered here.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-google-adk](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-google-adk) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Google ADK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-google-adk -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is under **Settings → Ingestion**. EU organizations should say EU region.

## Install ADK and the OTLP exporter

```bash
pip install "google-adk>=2.10" litellm opentelemetry-exporter-otlp-proto-http
```

`litellm` is only needed for non-Gemini models through ADK's `LiteLlm` wrapper. Don't pin a newer OpenTelemetry version: ADK 2.10 caps `opentelemetry-sdk` at 1.42.1.

## Configure the export and the transcript format

```bash
OTEL_SERVICE_NAME=support-agent
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20YOUR_INGEST_KEY
# Put prompts, replies and tool calls on span attributes, in the format Maple reads
OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY
# Drop ADK's own copies of the same content, which Maple doesn't read
ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false
```

The `%20` is an encoded space; the Python SDK decodes it. EU organizations use `https://ingest.eu.maple.dev`. Use `SPAN_ONLY` exactly: `true` sends content to log records, which Maple doesn't read for the transcript.

These settings store every prompt and tool result in Maple. To keep structure and tokens without content, leave `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` unset and delete the two `gen_ai.tool.call.*` lines from the plugin below.

## Register a tracer provider

`adk web` and `adk api_server` build a tracer provider from the environment. A `Runner` in your own app, worker or script doesn't, and its spans go nowhere without a warning. Add a `telemetry.py`:

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

ADK doesn't record tool arguments or results, so the `ToolCallAttributes` plugin adds them. `SkipDuplicateToolSpans` drops two tool spans that would otherwise count one call twice.

Import `telemetry` as the first line of your entry point and register the plugin on the runner:

```py
# main.py
import telemetry  # first, so the provider exists before ADK runs

from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types


def get_weather(city: str) -> dict:
    """Get the current weather for a city."""
    return {"city": city, "temperature_c": 21, "condition": "partly cloudy"}


agent = LlmAgent(
    name="assistant",
    model=LiteLlm(model="openrouter/openai/gpt-4o-mini"),
    instruction="You are a concise assistant.",
    tools=[get_weather],
)

runner = Runner(
    app_name="support",
    agent=agent,
    session_service=InMemorySessionService(),
    plugins=[telemetry.ToolCallAttributes()],
    auto_create_session=True,
)
```

If your app already sets up OpenTelemetry (Logfire, Sentry, a platform agent), add the `SkipDuplicateToolSpans(OTLPSpanExporter())` processor to that provider instead of creating a second one.

Under `adk web` or `adk api_server`, skip the provider and register the plugin on your `App`: `App(name="support", root_agent=agent, plugins=[ToolCallAttributes()])`.

## Use one ADK session per conversation

Each `runner.run_async()` call is one turn. Pass your own conversation id as `session_id` on every turn, and the whole conversation is one Maple session:

```py
async def chat(conversation_id: str, user_id: str, text: str) -> str:
    reply = ""
    async for event in runner.run_async(
        user_id=user_id,
        session_id=conversation_id,  # the same id on every turn of this conversation
        new_message=types.Content(role="user", parts=[types.Part(text=text)]),
    ):
        if event.is_final_response() and event.content and event.content.parts:
            reply = "".join(part.text or "" for part in event.content.parts)
    return reply
```

With `auto_create_session=True`, the runner creates the session under that id on the first turn. Don't call `create_session()` without a `session_id` on each request; ADK then mints a new id per turn and every message becomes its own session.

To call an agent like a tool, add it to `sub_agents` with `mode="single_turn"`. `AgentTool` runs the sub-agent under a second session id, which can move the turn into a separate session.

## Flush before a short-lived process exits

`BatchSpanProcessor` sends spans every 5 seconds, so a script, notebook cell or job that exits sooner loses the last turn. Flush when the work ends:

```py
# script.py
import telemetry  # first

import asyncio

from main import chat


async def main():
    try:
        await chat("support-4821", "user-17", "What's the weather in Berlin?")
    finally:
        telemetry.provider.force_flush()
        telemetry.provider.shutdown()


asyncio.run(main())
```

In a server, call `provider.shutdown()` from your shutdown hook. On Cloud Run or another platform that freezes the CPU between requests, call `provider.force_flush()` before each response returns.

## Check that it works

Run a conversation of two or three turns, one of them calling a tool, then open **Agent Sessions**. You should see one session with the framework **Google ADK**, one turn per `run_async()`, a transcript with the tool calls, their arguments and results, and tokens on each model call.

Cost shows as unpriced, because ADK doesn't record it.

## Troubleshooting

- **No spans at all.** You run a `Runner` without a registered tracer provider. Import `telemetry.py` first.
- **Tokens but an empty transcript.** `OTEL_SEMCONV_STABILITY_OPT_IN` or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY` is missing, or the capture variable is `true`.
- **Every message is its own session.** Pass the same conversation id as `session_id` on every turn.
- **A failing tool shows as successful.** It returned `{"status": "error", ...}`. Return a dict with an `"error"` key, or raise.
- **Every model call appears twice.** Another instrumentor wraps the same calls (`litellm.callbacks = ["otel"]`, `openinference-instrumentation-google-adk`). Remove it.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): how Maple builds sessions, turns and checks.
- [Agent tracing guides](/docs/agent-tracing): every framework.
- [ADK agent activity traces](https://google.github.io/adk-docs/observability/traces/): ADK's span reference and export setup.
- [LiteLLM](/docs/agent-tracing/litellm): tracing LiteLLM on its own, outside ADK.
- [OpenTelemetry for any agent](/docs/agent-tracing/opentelemetry): the GenAI attributes Maple reads.
