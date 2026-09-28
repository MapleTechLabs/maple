---
title: "Trace LiteLLM agents and the LiteLLM Proxy with OpenTelemetry"
description: "Send LiteLLM's OpenTelemetry spans to Maple from the Python SDK or the self-hosted LiteLLM Proxy, add the agent and tool spans LiteLLM can't emit, and group each conversation into one Agent Session."
group: "AI Agents"
order: 40
navLabel: "LiteLLM"
icon: "litellm"
---

LiteLLM traces model calls, and only model calls. Its OpenTelemetry logger writes one span per `acompletion()`, with the model, the provider, token counts and the prompt and reply. LiteLLM has no agent loop, no tool executor and no notion of a conversation, so the loop around those calls is your code, and the agent and tool spans have to come from your code too. This guide shows the Python that adds them.

Two defaults go wrong for Maple. The default (v1) logger has no conversation id at all, so every model call lands in its own one-call session, and when your code already has a span open, v1 writes its attributes onto that span after it has ended and they are dropped. LiteLLM's newer v2 logger fixes both and turns `litellm_session_id` into `gen_ai.conversation.id`, but it is off by default, only traces the async API, and in LiteLLM 1.103 it can't load on OpenTelemetry 1.44 or newer.

This guide covers the LiteLLM Python SDK and the self-hosted LiteLLM Proxy. It was tested with `litellm` 1.103.0 and the OpenTelemetry Python SDK 1.43.0 on Python 3.12.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-litellm](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-litellm) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for LiteLLM in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-litellm -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Trace in your app or at the proxy, not both

There are two places LiteLLM can trace a model call:

- **In your app**, when your code calls `litellm.acompletion()` directly. The next sections cover this.
- **At the LiteLLM Proxy**, when your app sends OpenAI-compatible requests to a proxy you run. See [Trace at the LiteLLM Proxy](#trace-at-the-litellm-proxy).

In both cases your app still emits the agent and tool spans, because only your app knows about them. Pick one place for the model-call spans. If the proxy traces the calls and your app also instruments its OpenAI client, every call shows up twice in the same trace.

## Export LiteLLM SDK spans to Maple

Install LiteLLM with the OpenTelemetry SDK and the OTLP/HTTP exporter:

```bash
pip install "litellm==1.103.0" "opentelemetry-sdk==1.43.0" "opentelemetry-exporter-otlp-proto-http==1.43.0"
```

Keep OpenTelemetry below 1.44 on LiteLLM 1.103, the latest stable release as of September 2026. OpenTelemetry 1.44 removed the Events API that LiteLLM's v2 logger imports ([BerriAI/litellm#41990](https://github.com/BerriAI/litellm/issues/41990)). Importing `OpenTelemetryV2` as below then fails with `ModuleNotFoundError: No module named 'opentelemetry._events'`. The `callbacks: ["otel"]` form the proxy uses is worse: LiteLLM catches the error, logs `Error initializing custom logger` and keeps serving requests without exporting anything. The fix is merged, and the 1.104.0rc1 release candidate traces correctly with OpenTelemetry 1.45. Drop the pin once 1.104 is out.

Point the exporter at Maple with the standard OpenTelemetry variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself.

Then set up tracing once, when your process starts. Create your own `TracerProvider` and hand it to LiteLLM's v2 logger, so LiteLLM's spans and yours go through one exporter:

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
# Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

# LiteLLM's v2 OpenTelemetry logger, writing into the same provider as your own spans.
litellm.callbacks = [
    OpenTelemetryV2(
        config=OpenTelemetryV2Config(capture_message_content="span_only"),
        tracer_provider=provider,
    )
]

tracer = trace.get_tracer("support-agent")
```

Import `tracing` at the top of your entry point, before the first model call. Passing the logger instance means you don't need `LITELLM_OTEL_V2=true`, and LiteLLM builds no provider or exporter of its own. If your app already has a `TracerProvider`, pass that one as `tracer_provider=` instead of creating a second.

Don't also put `"otel"` in `litellm.callbacks` or `success_callback`. That adds a second logger, and every model call is exported twice.

### Trace the agent loop around LiteLLM

Each `acompletion()` becomes a `chat <model>` span. To get turns, sub-agents and tool calls in Maple, wrap each agent run in an `invoke_agent` span and each tool call in an `execute_tool` span. LiteLLM's spans nest under whatever span is current, so they land inside the agent span in the same trace:

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
            # The model gets the error as the tool result; the span is marked failed.
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
            # Parallel tool calls run concurrently; each keeps the agent span as its parent.
            results = await asyncio.gather(*(run_tool(agent, call) for call in message.tool_calls))
            for call, output in zip(message.tool_calls, results):
                messages.append({"role": "tool", "tool_call_id": call.id, "content": output})
```

The v2 logger only traces the async API. `litellm.completion()` and the other sync calls produce no span at all, because the logger closes spans in its async success callback. Use `acompletion()`. If your code is sync throughout, see the troubleshooting entry on sync code.

## Group every turn of a conversation into one session

Maple groups LiteLLM traces into sessions by `gen_ai.conversation.id`. The v2 logger writes it on every `chat` span from `litellm_session_id=`, or from `metadata={"session_id": ...}` if you already pass metadata. Pass it on every call, from the chat or thread id your app already has:

```py
from agent import Agent, run_agent

assistant = Agent("assistant", "openrouter/openai/gpt-4o-mini", "You are a concise assistant.")
history: dict[str, list] = {}


async def handle_message(chat_id: str, text: str) -> str:
    messages = history.setdefault(chat_id, [])
    messages.append({"role": "user", "content": text})
    return await run_agent(assistant, chat_id, messages)
```

The id must be stable for the whole conversation and different between conversations. A per-process constant merges every user into one session.

Without it, each turn is its own session named `trace:<id>`, and with the v1 logger there is no way to set it on LiteLLM's spans at all.

Leave `gen_ai.conversation.id` off your own `invoke_agent` span. Maple labels a session with the framework of its earliest span that carries the session id, so putting it on your span labels the session **Unidentified** instead of **LiteLLM**. The id on LiteLLM's `chat` spans is enough, because Maple groups whole traces: one span with the id pulls in every span of its trace.

## Record prompts, responses and tool calls

The v2 logger records no content by default. `capture_message_content="span_only"` in `tracing.py` turns it on, and each `chat` span then carries `gen_ai.input.messages` and `gen_ai.output.messages` as JSON in the OpenAI chat format: the system prompt, the history, tool calls and tool results. Maple builds the transcript from those attributes. The environment variable `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only` does the same when LiteLLM builds the config itself, as the proxy does.

One gap in the transcript today: Maple doesn't read the OpenAI `tool_calls` field inside these messages. A model call whose reply is only a tool request shows no reply text, and the tool call itself appears once, from your `execute_tool` span, with its arguments and result. Without the `execute_tool` spans below, tool calls would be missing from the transcript entirely.

Don't use `event_only`. It moves content to OpenTelemetry log events, which Maple doesn't read, and the transcript is empty.

To keep prompts out of Maple, set `capture_message_content="no_content"` and remove the `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` lines from `run_tool`. Sessions keep their turns, models, tool names, tokens and errors, and the transcript is empty.

`litellm.turn_off_message_logging = True` is the in-between option. It applies to every LiteLLM logging callback, and the messages keep their roles and tool calls, but each text becomes `redacted-by-litellm`. For pattern-based redaction of message content, run an OpenTelemetry Collector between your app and Maple.

## Tools, errors and sub-agents

Each tool call is an `execute_tool <tool name>` span with the tool name, the model's call id, the arguments and the result. Maple matches it to the model reply that requested it by `gen_ai.tool.call.id`.

`run_tool` catches the exception, gives the model an `{"error": ...}` result so it can recover, and marks the span failed with `error.type` and an ERROR status. Maple counts the call as failed. If your loop instead returns error strings from tools without touching the span, Maple counts them as successes.

A failed model call needs nothing from you. LiteLLM marks its `chat` span ERROR and sets `error.type` to the exception class, for example `RateLimitError`.

For several agents, give each its own `name`. It becomes `gen_ai.agent.name` on its `invoke_agent` span, and Maple draws one lane per agent name. The simplest orchestrator is an agent whose tools are the other agents: each tool function calls `run_agent` with the same conversation id, so the whole run is one trace in one session:

```py
from agent import Agent, run_agent

# weather_worker, budget_worker, transport_worker and summary are Agent(...) instances
WORKERS = (weather_worker, budget_worker, transport_worker, summary)


def delegate(worker: Agent, conversation_id: str):
    async def call(task: str) -> str:
        return await run_agent(worker, conversation_id, [{"role": "user", "content": task}])

    return call


def task_tool(name: str) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": f"Delegate a task to the {name} agent.",
            "parameters": {"type": "object", "properties": {"task": {"type": "string"}}, "required": ["task"]},
        },
    }


async def briefing(conversation_id: str, request: str) -> str:
    orchestrator = Agent(
        "orchestrator",
        "openrouter/openai/gpt-4o-mini",
        "Call weather_worker, budget_worker and transport_worker in parallel, "
        "then call summary once with their results, then reply with the summary.",
        {w.name: delegate(w, conversation_id) for w in WORKERS},
        [task_tool(w.name) for w in WORKERS],
    )
    return await run_agent(orchestrator, conversation_id, [{"role": "user", "content": request}])
```

Each delegation is an `execute_tool weather_worker` span whose only child is `invoke_agent weather_worker`, which Maple shows as a sub-agent lane with the tool's arguments and result as the lane's input and output. When the model requests several workers in one reply, `asyncio.gather` in `run_agent` runs them in parallel, and they overlap in time as siblings under `invoke_agent orchestrator`.

If your code calls the workers directly instead of through the model, wrap those calls in `with agent_span("orchestrator"):` so they still share one trace. `asyncio.gather` keeps the OpenTelemetry context, so workers started with it nest correctly. Thread pools don't: wrap work sent to `run_in_executor` or a `ThreadPoolExecutor` with `contextvars.copy_context().run`.

## Tokens and cost

Each `chat` span carries `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens` when the provider reports caching. Your own spans carry no usage, so nothing is counted twice.

For streaming, pass `stream_options={"include_usage": True}` and consume the stream inside the agent span. LiteLLM closes the `chat` span when the stream ends, with the token counts and `gen_ai.response.time_to_first_chunk`:

```py
async def stream_agent(agent: Agent, conversation_id: str, messages: list):
    with agent_span(agent.name):
        stream = await litellm.acompletion(
            model=agent.model,
            messages=[{"role": "system", "content": agent.instructions}, *messages],
            stream=True,
            stream_options={"include_usage": True},
            litellm_session_id=conversation_id,
        )
        text = ""
        async for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                text += delta
                yield delta
        messages.append({"role": "assistant", "content": text})
```

Cost shows as unpriced by default. LiteLLM prices every call, but the v2 logger writes the price to `litellm.cost.total` (and v1 buries it in the `hidden_params` JSON), and Maple reads cost only from `gen_ai.usage.cost`, `gen_ai.usage.total_cost` or `llm.cost.total`, and never prices tokens itself.

To get cost into Maple, add up LiteLLM's price for every call of a turn, sub-agents included, and put the total on the outermost `invoke_agent` span. Only the outermost one: Maple subtracts a sub-agent's reported cost from the agent above it, on the assumption that the parent's figure already includes it, so a per-agent total on every level undercounts the orchestrator. Replace `agent_span` in `agent.py`:

```py
from contextvars import ContextVar

# LiteLLM's price for every model call of the current turn, sub-agents included.
turn_costs: ContextVar[list | None] = ContextVar("turn_costs", default=None)


@contextmanager
def agent_span(name: str):
    with tracer.start_as_current_span(f"invoke_agent {name}") as span:
        span.set_attribute("gen_ai.operation.name", "invoke_agent")
        span.set_attribute("gen_ai.agent.name", name)
        if turn_costs.get() is not None:  # a sub-agent: the outermost agent reports the cost
            yield span
            return
        costs: list[float] = []
        token = turn_costs.set(costs)
        try:
            yield span
        finally:
            turn_costs.reset(token)
            span.set_attribute("gen_ai.usage.cost", sum(costs))
```

Then record each call's price. In `run_agent`, right after `acompletion` returns:

```py
            turn_costs.get().append(response._hidden_params.get("response_cost") or 0.0)
```

A stream carries its price on the last chunk's `usage.cost`. In `stream_agent`, keep it while you consume the stream and record it once at the end:

```py
        text, cost = "", 0.0
        async for chunk in stream:
            if getattr(chunk, "usage", None) is not None:  # the last chunk carries usage and cost
                cost = getattr(chunk.usage, "cost", None) or cost
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                text += delta
                yield delta
        turn_costs.get().append(cost)
```

The session and turn totals are then exact. The cost sits on the agent rather than on each model call, so the per-model breakdown stays unpriced.

## Trace at the LiteLLM Proxy

When your apps call a LiteLLM Proxy you run, trace the model calls there. Every app behind the proxy gets model-call spans without code changes, and content and retention settings live in one place. Enable the v2 logger in the proxy's `config.yaml`:

```yaml
model_list:
  - model_name: gpt-4o-mini
    litellm_params:
      model: openrouter/openai/gpt-4o-mini
      api_key: os.environ/OPENROUTER_API_KEY

litellm_settings:
  callbacks: ["otel"]
```

and in the proxy's environment:

```bash
LITELLM_OTEL_V2=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=litellm-proxy
OTEL_ENVIRONMENT_NAME=production
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only
```

The official `ghcr.io/berriai/litellm` image ships OpenTelemetry 1.28 and the FastAPI instrumentation, so the 1.44 problem above doesn't apply to it. A pip-installed proxy needs the same pin plus the FastAPI instrumentation, which is what continues your app's trace:

```bash
pip install "litellm[proxy]==1.103.0" "opentelemetry-sdk==1.43.0" \
  "opentelemetry-exporter-otlp-proto-http==1.43.0" "opentelemetry-instrumentation-fastapi==0.64b0"
litellm --config config.yaml
```

In your app, keep `agent_span` and `run_tool` from above, drop the LiteLLM logger from `tracing.py`, and send two headers with every request: `traceparent`, so the proxy's spans join the app's trace under the agent span, and `x-litellm-session-id`, which the proxy turns into `gen_ai.conversation.id`:

```py
import os

from openai import AsyncOpenAI
from opentelemetry import propagate

client = AsyncOpenAI(base_url="http://localhost:4000", api_key=os.environ["LITELLM_API_KEY"])


async def call_model(conversation_id: str, messages: list, tools: list | None):
    headers = {"x-litellm-session-id": conversation_id}
    propagate.inject(headers)  # adds traceparent for the current span
    return await client.chat.completions.create(
        model="gpt-4o-mini", messages=messages, tools=tools, extra_headers=headers
    )
```

`metadata: {"session_id": ...}` in the request body works as well. A W3C `baggage` header with `session.id=...` is picked up only when neither is present.

Don't add an OpenAI client instrumentor (OpenInference, OpenLLMetry, `opentelemetry-instrumentation-openai-v2`) to the app on top of this. The app's span and the proxy's span describe the same call, and Maple can't always tell them apart, so LLM call counts and tokens double. If you can't configure the proxy, do the opposite: leave its OpenTelemetry off and instrument the client in the app.

Each request then shows up in your app's trace as `invoke_agent` → `POST /chat/completions` (the proxy's server span) → `chat gpt-4o-mini`, next to an `auth /chat/completions` span for the proxy's key check. Depending on its setup, the proxy adds more housekeeping spans (database, Redis, guardrails).

Maple currently counts each `auth /chat/completions` span as an extra LLM call, because it comes from LiteLLM and its name contains "chat". On the proxy path the LLM call count in the sessions list is double the real number. The session page also counts the proxy's `POST /chat/completions` server span, which carries `gen_ai.request.model`, so it shows three times the real number. Tokens, cost, the transcript and the session grouping are not affected.

## Short-lived processes

LiteLLM creates its `chat` span after the call returns, from a background logging queue. A script that exits right after its last call loses that call's span: the queue is drained at interpreter exit, after the `TracerProvider` has already shut down. Drain the queue, then flush, before the event loop ends:

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

Call `flush_tracing()` at the end of every Lambda or Cloud Run job invocation, after each notebook cell that calls a model, and in your web framework's shutdown hook. A long-running server needs it only at shutdown.

## Check that it works

Run one conversation with at least two messages and a tool call, then open **Agent Sessions** in Maple. Spans take a few seconds to arrive. You should see:

- one session per conversation, with the id you passed as `litellm_session_id`, and framework **LiteLLM**;
- one turn per top-level `invoke_agent` span, labeled with the user's message, and a transcript with the prompts, replies and tool calls;
- `invoke_agent <agent name>` spans from your code, `chat <model>` spans from LiteLLM inside them, and `execute_tool <tool>` spans for tool calls;
- a lane per agent name for multi-agent runs, all in the caller's session;
- input and output tokens on every `chat` span, including streamed ones;
- failed tool calls marked as failed, with the error as the result;
- cost shown as unpriced, or the turn totals if you added `gen_ai.usage.cost`.

## Troubleshooting

- **`ModuleNotFoundError: No module named 'opentelemetry._events'` at startup, or no LiteLLM spans and a logged `Error initializing custom logger`.** LiteLLM 1.103 with OpenTelemetry 1.44 or newer. Pin `opentelemetry-sdk` and the exporter to 1.43.0, or upgrade to LiteLLM 1.104 once it's released.
- **Your spans arrive but no `chat` spans.** The code calls the sync `litellm.completion()`, which the v2 logger doesn't trace. Switch to `acompletion()`.
- **Spans named `litellm_request` and `raw_gen_ai_request`, and each call is its own session.** That is the v1 logger: `litellm.callbacks = ["otel"]` without the v2 instance. Use the `OpenTelemetryV2` setup above.
- **Model, tokens and prompts missing, and the SDK logs `Setting attribute on ended span`.** Also v1: with a span already open it writes onto that span instead of creating its own. If you must stay on v1 for sync code, set `USE_OTEL_LITELLM_REQUEST_SPAN=true` and `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`, and put `gen_ai.conversation.id` on your `invoke_agent` span, since v1 can't carry it. The framework then shows as **Unidentified**.
- **Every call is its own session.** No `litellm_session_id=` (SDK) or `x-litellm-session-id` header (proxy) was sent. Pass it on every call.
- **The framework shows as Unidentified.** Your own span carries `gen_ai.conversation.id` or `maple_ai.session.id`. Remove it and let LiteLLM's spans carry the id.
- **Spans arrive with no prompts or replies.** Content capture is off, which is the v2 default. Set `capture_message_content="span_only"` or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only`.
- **The last call of a script or Lambda is missing.** The process ended before LiteLLM's logging queue ran. Await `flush_tracing()` before the loop ends.
- **Every model call appears twice.** Two loggers (the v2 instance plus `"otel"` in `litellm.callbacks`), or the proxy and an in-app OpenAI instrumentor both tracing the same call. Keep one.
- **Proxy spans land in their own traces, apart from the app's agent span.** The request carried no `traceparent`. Inject it with `propagate.inject(headers)` inside the agent span, and don't set `OTEL_IGNORE_CONTEXT_PROPAGATION` on the proxy.
- **The LLM call count is twice what the app made (three times on the session page), on the proxy path only.** Maple counts the proxy's `auth /chat/completions` spans as calls, and the session page also counts its `POST /chat/completions` server span. Token and cost totals are correct.
- **A model call shows an empty reply in the transcript.** That call only requested tools. The tool calls appear as their own rows from your `execute_tool` spans.
- **Session cost is lower than LiteLLM's spend.** Sub-agents report their own `gen_ai.usage.cost` and Maple subtracts it from the parent agent's. Report cost only on the outermost agent span, as in the cost section.
- **Nothing arrives from the proxy.** It is still on the default `console` exporter because no endpoint reached it. Check that `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the proxy's environment, not only in your app's.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [All agent tracing guides](/docs/agent-tracing)
- [Trace OpenRouter calls with Broadcast](/docs/agent-tracing/openrouter)
- [LiteLLM: OpenTelemetry v2](https://docs.litellm.ai/docs/observability/opentelemetry_v2)
- [LiteLLM: OpenTelemetry (v1)](https://docs.litellm.ai/docs/observability/opentelemetry_integration)
- [Instrument a Python application](/docs/guides/instrumentation-python)
