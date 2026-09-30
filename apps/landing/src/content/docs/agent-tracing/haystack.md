---
title: "Trace Haystack agents with OpenTelemetry"
description: "Send Haystack 3 Agent and pipeline runs to Maple as one Agent Session per conversation, with transcript, model, tokens, cost and failed tool calls."
group: "AI Agents"
order: 28
navLabel: "Haystack"
icon: "haystack"
---

This guide adds `maple_haystack.py`, a Haystack tracer that records model, tokens, messages and failed tool calls for Maple, and a `conversation()` block that groups runs into one session.

Tested with `haystack-ai` 3.2 and `opentelemetry-haystack` 1.0 on Python 3.10 or later.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-haystack](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-haystack) skill and follows it.

```text
Set up Maple agent tracing for Haystack in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-haystack -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install and add the Maple tracer

```bash
pip install "haystack-ai>=3.2" "opentelemetry-haystack>=1.0" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Save this file next to your app as `maple_haystack.py`:

```py
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
                "gen_ai.usage.cost": usage.get("cost"),
            }
            if self._content:
                attributes["gen_ai.output.messages"] = _messages(replies)
            self._span.set_attributes({k: v for k, v in attributes.items() if v is not None})

    def _tool(self, key: str, value: Any) -> None:
        if key.endswith(".output") and isinstance(value, dict) and "error" in value:
            self._span.set_status(StatusCode.ERROR, str(value["error"]) if self._content else "Tool invocation failed")
            self._span.set_attribute("error.type", "ToolInvocationError")
        if self._content:
            attribute = "gen_ai.tool.call.arguments" if key.endswith(".input") else "gen_ai.tool.call.result"
            self._span.set_attribute(attribute, value if isinstance(value, str) else json.dumps(value, default=str))


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
            tags.pop("haystack.pipeline.input_data", None)

        with self._tracer.start_as_current_span(operation_name, attributes=attributes) as raw_span:
            span = MapleSpan(raw_span, operation, self._content)
            span.set_tags(tags)
            yield span
```

## Export to Maple

Configure OpenTelemetry once at startup and hand Haystack the tracer:

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

EU organizations use `https://ingest.eu.maple.dev`. Set the base URL only; the exporter appends `/v1/traces`.

Import `telemetry` before the first `pipeline.run()` or `agent.run()`. Keep the tracer name `"haystack"`, since Maple labels the sessions by it. If the app already has a `TracerProvider`, skip the provider lines and pass `trace.get_tracer("haystack")` from the existing one.

## Group turns into one session

Each run is its own trace. Wrap every run in `conversation()` with your chat's id:

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
    # The Agent re-adds its system prompt on every run, so don't store it
    return [m for m in result["assistant"]["messages"] if not m.is_from("system")]
```

Use the id your app already stores for the chat. A new UUID per request gives one session per message, and one id for the whole process merges every user into one session.

## Agent names, content and tokens

Each agent is named after its pipeline component (`assistant` above) or the `name=` of the `AgentTool` that wraps it. An Agent run directly with `agent.run()` is called `agent`.

To keep prompts and responses out of Maple, pass `content=False`:

```py
tracing.enable_tracing(MapleHaystackTracer(trace.get_tracer("haystack"), content=False))
```

`HAYSTACK_CONTENT_TRACING_ENABLED` has no effect with this tracer.

A streamed `OpenAIChatGenerator` reply carries no token counts unless you ask for them (OpenRouter always sends usage):

```py
OpenAIChatGenerator(model="gpt-4o-mini", generation_kwargs={"stream_options": {"include_usage": True}})
```

Cost only appears with `OpenRouterChatGenerator`. Other providers show tokens and read as **unpriced**.

## Flush before short-lived processes exit

Scripts, notebooks, cron jobs and serverless handlers need an explicit flush before they exit:

```py
try:
    handle_message(chat_id, history, text)
finally:
    provider.force_flush()
    provider.shutdown()
```

Long-running servers only need `provider.shutdown()` in their shutdown hook.

## Check that it works

Run a conversation of at least two turns, one with a tool call, and open **Agent Sessions** filtered by your service name. You should see one session per conversation id, labelled Haystack, with one turn per `pipeline.run()`, model calls with tokens, and tool calls with failed ones marked.

## Troubleshooting

- **Every request is its own session.** Wrap the `pipeline.run()` call itself in `conversation()`, and pass the chat's stored id.
- **Spans but no model calls, tokens or transcript.** `enable_tracing()` got the plain `OpenTelemetryTracer`, or a later call replaced `MapleHaystackTracer`.
- **No Haystack spans at all.** Haystack 3 doesn't trace until you call `tracing.enable_tracing(...)`. Call it before the first run.
- **Every model call appears twice.** Remove `openinference-instrumentation-haystack` or OpenLLMetry's `opentelemetry-instrumentation-haystack`.
- **Tokens are zero with a non-OpenAI generator.** Print `result["replies"][0].meta["usage"]` once and add its keys to `_chat()`.
- **A failed tool isn't counted.** The tool caught its own exception. Let it raise, or return `{"error": ...}`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
