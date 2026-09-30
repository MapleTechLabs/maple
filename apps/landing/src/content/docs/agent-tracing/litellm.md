---
title: "Trace LiteLLM agents and the LiteLLM Proxy with OpenTelemetry"
description: "Send LiteLLM's model-call spans to Maple from the Python SDK or the LiteLLM Proxy, and add the agent and tool spans that group each conversation into one Agent Session."
group: "AI Agents"
order: 40
navLabel: "LiteLLM"
icon: "litellm"
---

LiteLLM traces each model call. Your code adds the agent and tool spans and passes a session id on every call so Maple groups the turns into one session.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-litellm](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-litellm) skill and follows it.

```text
Set up Maple agent tracing for LiteLLM in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-litellm -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Trace in your app or at the proxy

If your code calls `litellm.acompletion()`, follow the next sections. If your app calls a LiteLLM Proxy you run, see [Trace at the LiteLLM Proxy](#trace-at-the-litellm-proxy). Trace model calls in one place only, or every call shows up twice.

## Install LiteLLM and the exporter

```bash
pip install "litellm==1.103.0" "opentelemetry-sdk==1.43.0" "opentelemetry-exporter-otlp-proto-http==1.43.0"
```

Keep OpenTelemetry at 1.43. Version 1.44 and later break LiteLLM 1.103's logger.

Point the exporter at Maple:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
```

For an EU organization, use `https://ingest.eu.maple.dev`.

## Register LiteLLM's v2 logger

Use the v2 logger (`OpenTelemetryV2`). The default v1 logger makes every call its own session. Pass it your `TracerProvider`:

```py
# tracing.py
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

import litellm
from litellm.integrations.otel.logger import OpenTelemetryV2
from litellm.integrations.otel.model.config import OpenTelemetryV2Config

provider = TracerProvider(
    resource=Resource.create(
        {"service.name": "support-agent", "deployment.environment.name": "production"}
    )
)
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

litellm.callbacks = [
    OpenTelemetryV2(
        config=OpenTelemetryV2Config(capture_message_content="span_only"),
        tracer_provider=provider,
    )
]

tracer = trace.get_tracer("support-agent")
```

Import `tracing` at the top of your entry point. If your app already has a `TracerProvider`, pass that one. Don't also add `"otel"` to `litellm.callbacks`, which registers a second logger.

`"span_only"` records prompts and replies for the transcript. Use `"no_content"` to keep them out of Maple.

## Wrap the agent loop in agent and tool spans

Wrap each agent run in an `invoke_agent` span and each tool call in an `execute_tool` span. The v2 logger only traces `acompletion()`, not `completion()`:

```py
# agent.py
import asyncio
import inspect
import json
from contextlib import contextmanager
from dataclasses import dataclass, field

import litellm
from opentelemetry.trace import StatusCode

from tracing import tracer


@dataclass
class Agent:
    name: str
    model: str
    instructions: str
    tools: dict = field(default_factory=dict)  # tool name -> function (sync or async)
    schemas: list = field(default_factory=list)  # OpenAI-style tool definitions


@contextmanager
def agent_span(name: str):
    with tracer.start_as_current_span(f"invoke_agent {name}") as span:
        span.set_attribute("gen_ai.operation.name", "invoke_agent")
        span.set_attribute("gen_ai.agent.name", name)
        yield span


async def run_tool(agent: Agent, call) -> str:
    name = call.function.name
    with tracer.start_as_current_span(f"execute_tool {name}") as span:
        span.set_attribute("gen_ai.operation.name", "execute_tool")
        span.set_attribute("gen_ai.tool.name", name)
        span.set_attribute("gen_ai.tool.call.id", call.id)
        span.set_attribute("gen_ai.tool.call.arguments", call.function.arguments)
        try:
            result = agent.tools[name](**json.loads(call.function.arguments or "{}"))
            if inspect.isawaitable(result):
                result = await result
        except Exception as exc:
            span.set_status(StatusCode.ERROR, str(exc))
            span.set_attribute("error.type", type(exc).__name__)
            result = {"error": str(exc)}
        output = json.dumps(result)
        span.set_attribute("gen_ai.tool.call.result", output)
        return output


async def run_agent(agent: Agent, conversation_id: str, messages: list) -> str:
    with agent_span(agent.name):
        while True:
            response = await litellm.acompletion(
                model=agent.model,
                messages=[{"role": "system", "content": agent.instructions}, *messages],
                tools=agent.schemas or None,
                litellm_session_id=conversation_id,
            )
            message = response.choices[0].message
            messages.append(message.model_dump(exclude_none=True))
            if not message.tool_calls:
                return message.content or ""
            results = await asyncio.gather(*(run_tool(agent, call) for call in message.tool_calls))
            for call, output in zip(message.tool_calls, results):
                messages.append({"role": "tool", "tool_call_id": call.id, "content": output})
```

For sub-agents, call `run_agent` for the worker from inside a tool function, with its own `name` and the same conversation id.

## Group every turn into one session

`litellm_session_id=` sets the session. Pass the chat or thread id your app already has, stable for the whole conversation:

```py
from agent import Agent, run_agent

assistant = Agent("assistant", "openrouter/openai/gpt-4o-mini", "You are a concise assistant.")
history: dict[str, list] = {}


async def handle_message(chat_id: str, text: str) -> str:
    messages = history.setdefault(chat_id, [])
    messages.append({"role": "user", "content": text})
    return await run_agent(assistant, chat_id, messages)
```

Don't set `gen_ai.conversation.id` on your own `invoke_agent` span, or the session is labeled **Unidentified** instead of **LiteLLM**.

For streaming, pass `stream_options={"include_usage": True}` and consume the stream inside the agent span, or the streamed call has no token counts.

## Trace at the LiteLLM Proxy

To trace at a proxy you run, enable the logger in its `config.yaml`:

```yaml
model_list:
  - model_name: gpt-4o-mini
    litellm_params:
      model: openrouter/openai/gpt-4o-mini
      api_key: os.environ/OPENROUTER_API_KEY

litellm_settings:
  callbacks: ["otel"]
```

Set these in the proxy's environment:

```bash
LITELLM_OTEL_V2=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=litellm-proxy
OTEL_ENVIRONMENT_NAME=production
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only
```

The `ghcr.io/berriai/litellm` image works as is. A pip-installed proxy needs these packages:

```bash
pip install "litellm[proxy]==1.103.0" "opentelemetry-sdk==1.43.0" \
  "opentelemetry-exporter-otlp-proto-http==1.43.0" "opentelemetry-instrumentation-fastapi==0.64b0"
```

Then start it with `litellm --config config.yaml`.

In your app, keep `agent_span` and `run_tool`, drop the LiteLLM logger from `tracing.py`, and send `traceparent` and `x-litellm-session-id` with every request:

```py
import os

from openai import AsyncOpenAI
from opentelemetry import propagate

client = AsyncOpenAI(base_url="http://localhost:4000", api_key=os.environ["LITELLM_API_KEY"])


async def call_model(conversation_id: str, messages: list, tools: list | None):
    headers = {"x-litellm-session-id": conversation_id}
    propagate.inject(headers)
    return await client.chat.completions.create(
        model="gpt-4o-mini", messages=messages, tools=tools, extra_headers=headers
    )
```

Don't also instrument the OpenAI client in the app, or calls and tokens double. On this path the session page's LLM call count shows 2x the real number. Tokens, cost and the transcript are correct.

## Flush before a short-lived process exits

A script, Lambda or notebook cell that ends right after its last call loses that call's span. Drain LiteLLM's queue and flush:

```py
import asyncio

from litellm.litellm_core_utils.logging_worker import GLOBAL_LOGGING_WORKER

from tracing import provider


async def flush_tracing() -> None:
    await asyncio.sleep(0)  # LiteLLM queues its log event on the next loop tick
    await GLOBAL_LOGGING_WORKER.flush()
    provider.force_flush()


async def main() -> None:
    try:
        print(await handle_message("chat-42", "What's the weather in Berlin?"))
    finally:
        await flush_tracing()


asyncio.run(main())
provider.shutdown()
```

A long-running server needs this only in its shutdown hook.

## Check that it works

Run a conversation with two messages and a tool call, then open **Agent Sessions** in Maple. You should see one session with the id you passed and framework **LiteLLM**, one turn per message, and a transcript with the prompts, replies and tool calls.

## Troubleshooting

- **`ModuleNotFoundError: No module named 'opentelemetry._events'`, or no LiteLLM spans and `Error initializing custom logger` in the log.** OpenTelemetry 1.44+ on LiteLLM 1.103. Pin OpenTelemetry to 1.43.0.
- **Your spans arrive but no `chat` spans.** The code calls sync `litellm.completion()`. Switch to `acompletion()`.
- **Every call is its own session, or spans are named `litellm_request`.** You're on the v1 logger, or no session id was sent. Use the `OpenTelemetryV2` setup and pass `litellm_session_id=` (SDK) or `x-litellm-session-id` (proxy) on every call.
- **Every model call appears twice.** Two loggers, or the proxy and an in-app OpenAI instrumentor both trace the call. Keep one.
- **The last call of a script is missing.** Await `flush_tracing()` before the event loop ends.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [LiteLLM: OpenTelemetry v2](https://docs.litellm.ai/docs/observability/opentelemetry_v2)
