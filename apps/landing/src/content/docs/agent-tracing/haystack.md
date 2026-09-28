---
title: "Trace Haystack agents with OpenTelemetry"
description: "Send Haystack 3 Agent and pipeline runs to Maple as one Agent Session per conversation, with the transcript, model, tokens, cost and failed tool calls."
group: "AI Agents"
order: 28
navLabel: "Haystack"
icon: "haystack"
---

Haystack 3 traces its own pipelines, components, Agent steps and tool calls through the `opentelemetry-haystack` tracer. Those spans use a private `haystack.*` vocabulary: the model id and token counts exist only inside a JSON blob of the model's reply, a failed tool call ends with status `Unset`, and there is no conversation id anywhere. Sent to Maple as-is, every Haystack run shows up with the right shape but with no model calls, no tokens, no transcript, no tool failures, and one session per request.

This guide keeps Haystack's own spans and adds a single-file tracer of about 120 lines, `maple_haystack.py`, that writes the OpenTelemetry GenAI attributes Maple reads onto them while they are still open. It covers Python 3.10+ with `haystack-ai` 3.2 and `opentelemetry-haystack` 1.0, for the `Agent` component, `AgentTool`/`PipelineTool` sub-agents and chat generators in plain pipelines.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-haystack](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-haystack) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Haystack in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-haystack -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Why not the plain Haystack tracer or OpenInference

There are three ready-made ways to get OpenTelemetry spans out of Haystack. None of them gives Maple a complete session on its own:

| Option | What Maple gets | What is missing |
| --- | --- | --- |
| `OpenTelemetryTracer` from `opentelemetry-haystack` | Pipeline, component, Agent, step and tool spans, detected as **Haystack** | Model, tokens, transcript and tool failures (all inside `haystack.*` blobs Maple does not read), session id |
| `openinference-instrumentation-haystack` | Model and tokens on generator spans | Tool spans (tools run inside the Agent, which it records as one opaque chain), session id (`using_session` writes `session.id`, which Maple ignores for this dialect), framework label ("Unidentified") |
| OpenLLMetry `opentelemetry-instrumentation-haystack` | `Pipeline.run`, plus `OpenAIGenerator` and `OpenAIChatGenerator` calls | Agent steps, tool spans, tokens, every other generator (OpenRouter, Anthropic, ...), content in indexed `gen_ai.prompt.N.*` keys Maple does not read, session id |

The tracer in this guide is a subclass of the first option. It keeps every span and tag Haystack emits, so nothing you already see in Maple's trace view changes, and adds `gen_ai.*` attributes next to them. Don't run it together with the OpenInference or OpenLLMetry instrumentor: each would record every model call a second time.

## Install and export to Maple

```bash
pip install "haystack-ai>=3.2" "opentelemetry-haystack>=1.0" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Save this file next to your app as `maple_haystack.py`:

```py
"""Haystack tracer that adds the OpenTelemetry GenAI attributes Maple reads."""

import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from haystack.dataclasses import ChatMessage
from haystack_integrations.tracing.opentelemetry import OpenTelemetrySpan, OpenTelemetryTracer
from opentelemetry import trace
from opentelemetry.trace import StatusCode

logger = logging.getLogger(__name__)
_conversation_id: ContextVar[str | None] = ContextVar("maple_conversation_id", default=None)


@contextmanager
def conversation(conversation_id: str) -> Iterator[None]:
    """Every Haystack run inside this block joins the same Maple session."""
    token = _conversation_id.set(conversation_id)
    try:
        yield
    finally:
        _conversation_id.reset(token)


def _messages(messages: list[ChatMessage]) -> str:
    out = []
    for m in messages:
        parts: list[dict[str, Any]] = [{"type": "text", "content": t} for t in m.texts]
        parts += [{"type": "tool_call", "id": c.id, "name": c.tool_name, "arguments": c.arguments} for c in m.tool_calls]
        parts += [{"type": "tool_call_response", "id": r.origin.id, "response": r.result} for r in m.tool_call_results]
        out.append({"role": m.role.value, "parts": parts})
    return json.dumps(out, default=str)


class MapleSpan(OpenTelemetrySpan):
    def __init__(self, span: trace.Span, operation: str | None, content: bool) -> None:
        super().__init__(span)
        self._operation = operation
        self._content = content

    def set_content_tag(self, key: str, value: Any) -> None:
        try:
            if self._operation == "chat":
                self._chat(key, value)
            elif self._operation == "execute_tool":
                self._tool(key, value)
        except Exception:  # a tracing bug must never fail the agent run
            logger.exception("maple_haystack: could not map %s", key)
        if self._content:
            self.set_tag(key, value)

    def _chat(self, key: str, value: Any) -> None:
        if key.endswith(".input") and self._content:
            messages = value["messages"]
            system = [{"type": "text", "content": m.text} for m in messages if m.is_from("system")]
            if system:
                self._span.set_attribute("gen_ai.system_instructions", json.dumps(system))
            self._span.set_attribute("gen_ai.input.messages", _messages([m for m in messages if not m.is_from("system")]))
        elif key.endswith(".output"):
            replies = value["replies"]
            meta = replies[0].meta
            usage = meta.get("usage") or {}
            prompt_details = usage.get("prompt_tokens_details") or {}
            attributes = {
                "gen_ai.response.model": meta.get("model"),
                "gen_ai.response.finish_reasons": meta.get("finish_reason"),
                "gen_ai.usage.input_tokens": usage.get("prompt_tokens"),
                "gen_ai.usage.output_tokens": usage.get("completion_tokens"),
                "gen_ai.usage.cache_read.input_tokens": prompt_details.get("cached_tokens"),
                "gen_ai.usage.cache_write.input_tokens": prompt_details.get("cache_write_tokens"),
                "gen_ai.usage.reasoning.output_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
                "gen_ai.usage.cost": usage.get("cost"),  # OpenRouter prices every call; other providers leave this out
            }
            if self._content:
                attributes["gen_ai.output.messages"] = _messages(replies)
            self._span.set_attributes({k: v for k, v in attributes.items() if v is not None})

    def _tool(self, key: str, value: Any) -> None:
        if key.endswith(".output") and isinstance(value, dict) and "error" in value:
            # Haystack records a failed tool as {"error": ...} and leaves the span status unset
            self._span.set_status(StatusCode.ERROR, str(value["error"]))
            self._span.set_attribute("error.type", "ToolInvocationError")
        if self._content:
            attribute = "gen_ai.tool.call.arguments" if key.endswith(".input") else "gen_ai.tool.call.result"
            self._span.set_attribute(attribute, json.dumps(value, default=str))


class MapleHaystackTracer(OpenTelemetryTracer):
    def __init__(self, tracer: trace.Tracer, *, content: bool = True) -> None:
        super().__init__(tracer)
        self._content = content

    @contextmanager
    def trace(self, operation_name: str, tags: dict[str, Any] | None = None, parent_span: Any = None) -> Iterator[MapleSpan]:
        tags = dict(tags or {})
        attributes: dict[str, str] = {}
        operation = None
        if operation_name == "haystack.agent.run":
            # The Agent span has no name: use the pipeline component or the AgentTool that runs it
            parent = getattr(trace.get_current_span(), "attributes", None) or {}
            attributes["gen_ai.operation.name"] = "invoke_agent"
            attributes["gen_ai.agent.name"] = parent.get("haystack.component.name") or parent.get("gen_ai.tool.name") or "agent"
        elif operation_name == "haystack.agent.step.llm" or str(tags.get("haystack.component.type", "")).endswith("ChatGenerator"):
            operation = attributes["gen_ai.operation.name"] = "chat"
        elif operation_name == "haystack.agent.step.tool":
            operation = attributes["gen_ai.operation.name"] = "execute_tool"
            attributes["gen_ai.tool.name"] = tags["haystack.tool.name"]
        if conversation_id := _conversation_id.get():
            attributes["gen_ai.conversation.id"] = conversation_id
        if not self._content:
            tags.pop("haystack.pipeline.input_data", None)  # a plain tag, not gated by Haystack's content switch

        with self._tracer.start_as_current_span(operation_name, attributes=attributes) as raw_span:
            span = MapleSpan(raw_span, operation, self._content)
            span.set_tags(tags)
            yield span
```

It maps Haystack's spans as follows:

| Haystack span | Maple reads |
| --- | --- |
| `haystack.agent.run` | `invoke_agent`, agent name from the pipeline component or `AgentTool` that runs it |
| `haystack.agent.step.llm`, and any `*ChatGenerator` component | `chat`: model, finish reason, input/output/cache/reasoning tokens, cost, messages |
| `haystack.agent.step.tool` | `execute_tool`: tool name, arguments, result, and `Error` status when the tool failed |
| every span | `gen_ai.conversation.id` inside a `conversation()` block |

Then configure OpenTelemetry once at startup and hand Haystack the tracer:

```py
# telemetry.py
from haystack import tracing
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from maple_haystack import MapleHaystackTracer

provider = TracerProvider(
    resource=Resource.create({"service.name": "support-agent", "deployment.environment.name": "production"})
)
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

tracing.enable_tracing(MapleHaystackTracer(trace.get_tracer("haystack")))
```

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` to the endpoint itself.

Import `telemetry` before the first `pipeline.run()` or `agent.run()`. Unlike Haystack's content switch, the tracer has no import-order trap: Haystack looks up the active tracer on every span, so any run after `enable_tracing()` is traced.

Two details matter here:

- **Keep the tracer name `"haystack"`.** It becomes the instrumentation scope, which is how Maple labels the sessions as Haystack. Maple also recognizes Haystack's span names, but the scope covers spans added in newer Haystack releases too.
- **If the app already has a `TracerProvider`** (from FastAPI instrumentation or another library), skip the provider lines and pass `trace.get_tracer("haystack")` from the existing one. A second provider sends every span twice or not at all.

## Group turns into one session

Haystack's `Agent` is stateless: your app keeps the message history and passes it into every run, so nothing on the wire says that two runs belong to the same chat. Each `pipeline.run()` is its own trace, and without a conversation id Maple shows each one as a separate one-turn session.

Wrap every run in `conversation()` with your own chat id:

```py
from haystack import Pipeline
from haystack.components.agents import Agent
from haystack.dataclasses import ChatMessage
from haystack_integrations.components.generators.openrouter import OpenRouterChatGenerator

from maple_haystack import conversation

chat_generator = OpenRouterChatGenerator(model="openai/gpt-4o-mini")
agent = Agent(chat_generator=chat_generator, tools=[get_weather, calculate], system_prompt=SYSTEM_PROMPT)
pipeline = Pipeline()
pipeline.add_component("assistant", agent)


def handle_message(chat_id: str, history: list[ChatMessage], text: str) -> list[ChatMessage]:
    with conversation(chat_id):
        result = pipeline.run({"assistant": {"messages": [*history, ChatMessage.from_user(text)]}})
    # The Agent adds its system prompt on every run, so keep it out of the stored history
    return [m for m in result["assistant"]["messages"] if not m.is_from("system")]
```

Use the id your app already stores for the chat, such as a database row id or a thread id from your frontend. Don't mint a new UUID per request, and don't use one id for the whole process: both break the grouping, in opposite directions.

`conversation()` is a `ContextVar`, so it is scoped to the current request in async and threaded servers alike, and it follows the Agent into the worker threads that run tools in parallel. It writes `gen_ai.conversation.id` on every span of the run. Maple needs it on at least one span per trace to join that trace to the session.

## Record prompts, responses and tool calls

With the default `content=True`, the tracer writes:

- `gen_ai.input.messages` and `gen_ai.output.messages` on every model call, as `{role, parts}` arrays with text, tool calls and tool results;
- `gen_ai.system_instructions` with the Agent's system prompt;
- `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` on every tool span;
- Haystack's own `haystack.*.input`/`.output` tags, as before.

Maple builds the transcript and the turn labels from the `gen_ai.*` messages. The `haystack.*` blobs only show up in the raw span attributes.

`HAYSTACK_CONTENT_TRACING_ENABLED` has no effect with this tracer: `MapleHaystackTracer` decides on its own. Without the tracer, that variable is read once, at the first `import haystack`, and setting it any later silently records nothing.

To keep prompts and responses out of Maple, turn content off:

```py
tracing.enable_tracing(MapleHaystackTracer(trace.get_tracer("haystack"), content=False))
```

Model, tokens, cost, finish reasons, tool names and tool failures are still recorded, because they come from the reply metadata rather than the text. The error message of a failed tool stays on the span status, and Haystack's message quotes the call's arguments (``Failed to invoke Tool `fetch_transport_data` with parameters {'city': 'Rome'}``). If arguments can carry personal data, redact them in `_tool()` before `set_status`.

Haystack also puts the whole pipeline input on the root span as `haystack.pipeline.input_data`, a plain tag that its own content switch never gated. With `content=False` the tracer drops it, so the user's message doesn't leak through the back door. To redact rather than drop, filter the values in `_messages()` before they are written.

## Tools, errors and sub-agents

Each tool call is a `haystack.agent.step.tool` span with `gen_ai.tool.name` set to the tool's name. Tools of one step run in parallel threads, and their spans sit side by side under the step.

When a tool raises, Haystack wraps the exception in `ToolInvocationError`, feeds the error text back to the model, and writes `{"error": "..."}` as the tool output. The span itself ends with status `Unset`, so without the tracer the failure is invisible. The tracer sets status `Error` with the message and `error.type=ToolInvocationError`, which is what Maple counts as a failed tool call. This happens with both values of `raise_on_tool_invocation_failure`.

Maple opens a lane for every agent with a distinct `gen_ai.agent.name`. The tracer takes that name from what runs the Agent:

- an Agent added to a pipeline gets its component name, `assistant` in the example above;
- an Agent wrapped in `AgentTool(agent=..., name="weather_worker", ...)` gets the tool name, and Maple shows the tool call as a delegation to that sub-agent;
- an Agent inside a `PipelineTool` gets its component name in the inner pipeline;
- an Agent run directly with `agent.run()` is called `agent`.

A multi-agent setup with the orchestrator in a pipeline and workers as `AgentTool`s looks like this:

```py
from haystack.tools import AgentTool

weather_worker = AgentTool(
    agent=Agent(chat_generator=chat_generator, tools=[get_weather], system_prompt="Report the weather."),
    name="weather_worker",
    description="Look up the current weather for a city.",
)
# budget_worker and transport_worker are built the same way
orchestrator = Agent(chat_generator=chat_generator, tools=[weather_worker, budget_worker, transport_worker])
pipeline = Pipeline()
pipeline.add_component("orchestrator", orchestrator)

with conversation(briefing_id):
    pipeline.run({"orchestrator": {"messages": [ChatMessage.from_user("Brief me on Amsterdam.")]}})
```

Approval gates (`ConfirmationHook` at `before_tool`) stay inside the same run and the same session. A call the user rejects never reaches the tool, so it has no tool span; the model sees the rejection as a tool result, which is visible in the transcript.

## Tokens and cost

Tokens come from the `usage` object Haystack's generators put in each reply's `meta`. The tracer reads the OpenAI field names (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens` and `.cache_write_tokens`, `completion_tokens_details.reasoning_tokens`), which is what `OpenAIChatGenerator`, `OpenRouterChatGenerator` and other OpenAI-compatible generators report.

**Streaming needs one extra flag with OpenAI.** A streamed OpenAI response only carries usage when you ask for it, and Haystack doesn't:

```py
OpenAIChatGenerator(model="gpt-4o-mini", generation_kwargs={"stream_options": {"include_usage": True}})
```

OpenRouter always sends usage in the last streamed chunk, so `OpenRouterChatGenerator` needs nothing extra.

Maple never prices tokens itself. It shows cost only when a span carries one, and the only Haystack generator that reports a price is OpenRouter's (`usage.cost`, in USD), which the tracer copies to `gen_ai.usage.cost`. With any other provider, sessions show tokens and read as **unpriced**.

The Agent itself reports no usage, so there is nothing to double count: each model call is counted once, on its `haystack.agent.step.llm` span.

## Short-lived processes

`BatchSpanProcessor` exports in the background every 5 seconds. A script, CLI, notebook cell, cron job or serverless handler that exits sooner loses the last batch. Flush before the process ends:

```py
try:
    handle_message(chat_id, history, text)
finally:
    provider.force_flush()
    provider.shutdown()
```

Long-running servers only need `provider.shutdown()` in their shutdown hook.

## Check that it works

Run one conversation of at least two turns, one of them with a tool call. Within a minute, open **Agent Sessions** in Maple and filter by your service name. You should see:

- **one session per conversation id**, labelled Haystack, with one turn per `pipeline.run()`;
- a transcript with the user's messages, the assistant's replies and the tool calls, each turn labelled with its user message;
- an LLM call per `haystack.agent.step.llm` span, with the model (for example `openai/gpt-4o-mini`) and input and output tokens, including the streamed turn;
- a tool call per `haystack.agent.step.tool` span, named after the tool, with a failed tool counted as an error;
- the agent name from your pipeline component or `AgentTool`, and a lane per sub-agent;
- cost on OpenRouter, or "unpriced" with other providers.

Each turn's trace looks like this:

```text
haystack.pipeline.run
  haystack.component.run            assistant
    haystack.agent.run              invoke_agent, agent "assistant"
      haystack.agent.step
        haystack.agent.step.llm     chat, openai/gpt-4o-mini
        haystack.agent.step.tool    execute_tool, get_weather
      haystack.agent.step
        haystack.agent.step.llm     chat
```

An Agent with hooks, such as a `ConfirmationHook`, also gets a `haystack.agent.hook` span before its tool calls. Like `haystack.agent.step`, it carries no model or tool attributes, so Maple doesn't count it as a call.

## Troubleshooting

- **Every request is its own session.** The run happened outside a `conversation()` block, or each request passes a fresh id. Wrap the `pipeline.run()` call itself, and pass the chat's stored id.
- **Sessions show the right spans but no model calls, tokens or transcript.** Haystack is still using the plain `OpenTelemetryTracer`. Check that `enable_tracing()` gets a `MapleHaystackTracer`, and that no later call replaces it.
- **No Haystack spans at all.** Haystack 3 no longer turns tracing on when `opentelemetry-sdk` is installed. Call `tracing.enable_tracing(...)` before the first run.
- **Every model call appears twice.** The OpenInference or OpenLLMetry Haystack instrumentor is also active. Remove it; this tracer already records every model call.
- **The streamed turn has no tokens.** `OpenAIChatGenerator` without `stream_options.include_usage`. Add it to `generation_kwargs`.
- **Tokens are zero with a non-OpenAI generator.** Its `meta["usage"]` doesn't use the OpenAI field names. Print `result["replies"][0].meta["usage"]` once and add its keys to `_chat()`.
- **The agent is called `agent`.** It ran through `agent.run()`, not as a pipeline component or `AgentTool`. Add it to a `Pipeline` under the name you want to see.
- **A failed tool isn't counted.** The tool caught its own exception and returned a normal value. Let it raise, or return `{"error": ...}`, which Haystack uses for failures too.
- **Sessions are split or missing turns in a script.** The process exited before the batch was exported. Call `provider.force_flush()` and `provider.shutdown()` in `finally`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Agent tracing guides](/docs/agent-tracing)
- [Trace agents with plain OpenTelemetry](/docs/agent-tracing/opentelemetry)
- [Haystack tracing docs](https://docs.haystack.deepset.ai/docs/tracing)
- [`opentelemetry-haystack` on PyPI](https://pypi.org/project/opentelemetry-haystack/)
