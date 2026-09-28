---
name: maple-agent-tracing-haystack
description: "Trace Haystack agents with Maple: installs a small Haystack tracer that adds OpenTelemetry GenAI attributes to Haystack's own spans, so each conversation is one Maple Agent Session with transcript, model, tokens, cost and tool failures. Triggers on 'trace my haystack agent', 'add Maple to haystack', 'agent sessions for haystack', 'OpenTelemetry for haystack'."
---

# Maple agent tracing: Haystack

Goal: one conversation = one Maple Agent Session, with transcript, model calls, tool calls (failures marked), tokens and (on OpenRouter) cost. Reasoning and details: https://maple.dev/docs/agent-tracing/haystack

Haystack's `OpenTelemetryTracer` alone gives Maple structure only (model, tokens, content live in `haystack.*` JSON blobs Maple doesn't read; failed tools end `Unset`; no conversation id). The fix is `MapleHaystackTracer`, a subclass that writes `gen_ai.*` attributes on the live spans.

## Step 0: Detect

- `haystack-ai` version: `python -c "import haystack; print(haystack.__version__)"`. Need `>=3.0`; guide verified on 3.2. For 2.x, stop and tell the user this skill targets Haystack 3.
- Find where Agents/Pipelines run (`Agent(`, `Pipeline(`, `.run(`, `AgentTool(`, `PipelineTool(`) and where a chat/thread id is available per request.
- Existing OTel: grep for `TracerProvider(`, `set_tracer_provider`, `configure_otel`, `logfire.configure`, `opentelemetry-instrument`. If a provider exists, reuse it: only add the Maple exporter (if not already exporting to Maple) and `enable_tracing(...)`. Never create a second provider.
- Remove/skip `HaystackInstrumentor().instrument()` (OpenInference) and OpenLLMetry's Haystack instrumentor if present: they double every model call. Remove any existing `enable_tracing(OpenTelemetryTracer(...))` or `OpenTelemetryConnector` component and replace with Step 2.

## Step 1: Key and region

- US endpoint `https://ingest.maple.dev`; EU endpoint `https://ingest.eu.maple.dev`. Header `Authorization=Bearer <key>`. Protocol `http/protobuf`.
- Key given in the prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Private `maple_sk_` keys never go in browser code.
- Follow the repo's secret/env convention (`.env`, settings module, deployment env). If none exists, inline is acceptable: ingest keys are write-only.

## Step 2: Install and init

```bash
pip install "haystack-ai>=3.2" "opentelemetry-haystack>=1.0" "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Use the repo's package manager (`uv add`, `poetry add`, requirements file). Write this file verbatim as `maple_haystack.py` in the app's package:

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
            # Tool results arrive as strings: write them as-is, so a JSON result stays a JSON object
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

Init once at startup, before the first `pipeline.run()`/`agent.run()` (no import-order constraint beyond that):

```py
from haystack import tracing
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from maple_haystack import MapleHaystackTracer

provider = TracerProvider(
    resource=Resource.create({"service.name": "<service>", "deployment.environment.name": "<env>"})
)
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
tracing.enable_tracing(MapleHaystackTracer(trace.get_tracer("haystack")))
```

Env:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev   # EU: https://ingest.eu.maple.dev; /v1/traces is appended
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <key>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

- Tracer name must be `"haystack"` (instrumentation scope = how Maple labels the vendor Haystack).
- Set a real `service.name`; never leave `unknown_service`.

## Step 3: Session id

Haystack has no conversation concept; the app owns the message history. Wrap every run in `conversation(<stable chat id>)`:

```py
from maple_haystack import conversation

with conversation(chat_id):
    result = pipeline.run({"assistant": {"messages": [*history, ChatMessage.from_user(text)]}})
history = [m for m in result["assistant"]["messages"] if not m.is_from("system")]  # Agent re-adds its system prompt
```

- `chat_id` = the id the app already stores for the chat/thread (DB id, frontend thread id). Never a per-request UUID, never a process-wide constant.
- Wrap the run call itself (inside the request handler). It is a ContextVar: request-scoped and carried into Haystack's tool threads.
- It writes `gen_ai.conversation.id` on every span. That is the only session key Maple reads for Haystack (`session.id` is ignored).

## Step 4: Content

- Default `MapleHaystackTracer(..., content=True)` writes `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`/`.result`, plus Haystack's own `haystack.*` content tags.
- Maple shows a tool span's `gen_ai.tool.call.result` only when it is a JSON object/array. Plain-text tool results still appear in the transcript (as the next model call's tool message) but not on the tool call row. Don't change tools for this; mention it if the user's tools return strings.
- `content=False` keeps model, tokens, cost, finish reason, tool names and failures; drops messages, tool args/results, `haystack.*` content tags and the ungated `haystack.pipeline.input_data` tag. Use it if the user asks for no prompts/PII in telemetry. The failed tool's status message still quotes its arguments (Haystack's `Failed to invoke Tool ... with parameters {...}`); if arguments can hold PII, redact them in `_tool()` before `set_status`.
- `HAYSTACK_CONTENT_TRACING_ENABLED` is irrelevant with this tracer; don't add it.

## Step 5: Tools, errors, sub-agents

- Tool spans: `haystack.agent.step.tool` → `execute_tool` + `gen_ai.tool.name`. A tool that raises becomes `{"error": ...}` in Haystack; the tracer sets status `Error` + `error.type=ToolInvocationError`. Don't catch exceptions inside tools just to return strings; let them raise (or return `{"error": ...}`).
- Agent name (`gen_ai.agent.name`, needed for Maple lanes) = pipeline component name, or the `AgentTool` name, else `agent`. If the app calls `agent.run()` directly for its main agent, prefer running it as a `Pipeline` component with a meaningful name (only if that's a small change; otherwise leave it and mention the `agent` name).
- Sub-agents: use `AgentTool(agent=..., name="<worker>", description=...)` (Haystack ≥3.1) or `PipelineTool`; each worker gets its own name/lane. Keep them under the same `conversation()` block.
- Streaming with `OpenAIChatGenerator`: add `generation_kwargs={"stream_options": {"include_usage": True}}` or the streamed turn has no tokens. OpenRouter always sends usage.
- Token mapping reads OpenAI-style `meta["usage"]` keys (`prompt_tokens`, `completion_tokens`, `*_details`). For another generator, print one reply's `meta["usage"]`; if keys differ, extend `_chat()`.
- Cost: only OpenRouter reports `usage.cost` → `gen_ai.usage.cost`. Other providers show "unpriced" in Maple; say so to the user.

## Step 6: Flush

Scripts, CLIs, notebooks, jobs, serverless: flush before exit.

```py
try:
    run()
finally:
    provider.force_flush()
    provider.shutdown()
```

Servers: `provider.shutdown()` in the shutdown hook (FastAPI lifespan, atexit).

## Step 7: Verify

Run one real conversation (≥2 turns, one tool call). If you can export to a local collector or console first, check the spans; otherwise check Maple (Agent Sessions, filter by service). Check:

- Every span has `service.name` set; spans' scope is `haystack`.
- Each `haystack.agent.step.llm` span has `gen_ai.operation.name=chat`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` (also on the streamed turn).
- `gen_ai.input.messages`/`gen_ai.output.messages` are JSON arrays of `{role, parts}` (content on).
- Each tool call has one `haystack.agent.step.tool` span with the real `gen_ai.tool.name`; a failing tool has status `Error` and `error.type`; successful tools don't.
- `haystack.agent.run` has `gen_ai.operation.name=invoke_agent` and a distinct `gen_ai.agent.name` per sub-agent.
- Every trace of one conversation carries the same `gen_ai.conversation.id`; a second conversation carries a different one.
- No model call appears twice (no second instrumentor).
- No attribute contains an API key or `Bearer `.
- In Maple: one session per conversation labelled Haystack, turns = runs, transcript non-empty, LLM/tool counts match, failed tool counted, cost shown (OpenRouter) or unpriced.

Tell the user: known gaps are no `gen_ai.provider.name`, no `gen_ai.response.id`, no tool call id on tool spans, and cost only on OpenRouter.

## Do not

- Don't rely on `OpenTelemetryTracer`/`OpenTelemetryConnector` alone: Maple gets no model, tokens, transcript or tool failures.
- Don't add `openinference-instrumentation-haystack` or OpenLLMetry's Haystack instrumentor alongside (double model calls; OpenInference has no tool spans and its `session.id` is ignored).
- Don't create a second `TracerProvider`; don't rename the tracer from `"haystack"`.
- Don't mint a conversation id per request or share one across users.
- Don't set `session.id` or `maple_ai.session.id` for Haystack; `gen_ai.conversation.id` via `conversation()` is the key.
- Don't expect Haystack 2.x auto-tracing: 3.x needs `enable_tracing(...)`.
- Don't use a console exporter in production or forget the flush in short-lived processes.
- Don't modify `maple_haystack.py` beyond extending usage keys or redaction.
