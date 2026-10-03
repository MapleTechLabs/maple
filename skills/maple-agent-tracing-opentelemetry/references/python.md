# Python reference (3.10+)

Tested pattern: `opentelemetry-sdk` 1.45, `opentelemetry-exporter-otlp-proto-http` 1.45, `openai` 3.20 against an OpenAI-compatible Chat Completions API (OpenRouter here), Python 3.14.

This is a complete loop. If the project already has a loop, keep its structure and copy only the span code: `invoke_agent` around one agent run, `chat` around each model call, `execute_tool` around each tool call, `to_semconv` for messages.

```bash
pip install "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Existing provider (`opentelemetry-instrument`, Sentry, Logfire, Datadog): do not create `tracing.py`; add `BatchSpanProcessor(OTLPSpanExporter())` to it with `add_span_processor`.

## tracing.py

```py
# tracing.py: import this first in every entry point
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider(
    resource=Resource.create(
        {"service.name": "support-agent", "deployment.environment.name": "production"}
    )
)
# Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
```

- `OTLPSpanExporter()` reads `OTEL_*` when it is constructed. If the app uses python-dotenv, call `load_dotenv()` at the top of `tracing.py`, before the exporter is built; otherwise it silently targets `localhost:4318` with no key.
- No env convention in the repo: pass the values inline, `OTLPSpanExporter(endpoint="https://ingest.maple.dev/v1/traces", headers={"Authorization": "Bearer <key>"})`. Never build the header from `os.environ[...]` (bare `KeyError` on import) or `os.getenv(...)` (`Bearer None`, opaque 401) without failing fast with a clear message.

## agent.py

```py
# agent.py
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from openai import OpenAI, omit
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode

tracer = trace.get_tracer("support-agent")
client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"])
PROVIDER = "openrouter"  # gen_ai.provider.name: who you send the request to


@dataclass
class Tool:
    definition: dict[str, Any]
    run: Callable[..., Any]


@dataclass
class Agent:
    name: str
    model: str
    instructions: str
    tools: dict[str, Tool] = field(default_factory=dict)


def parse_arguments(text: str | None) -> Any:
    """Model-generated arguments are not always valid JSON; keep the raw text then."""
    try:
        return json.loads(text or "{}")
    except json.JSONDecodeError:
        return text


def to_semconv(message: dict[str, Any]) -> dict[str, Any]:
    """OpenAI message -> GenAI semconv message: {role, parts: [...]}."""
    if message["role"] == "tool":
        part = {"type": "tool_call_response", "id": message["tool_call_id"], "response": message["content"]}
        return {"role": "tool", "parts": [part]}
    parts: list[dict[str, Any]] = []
    if message.get("content"):
        parts.append({"type": "text", "content": message["content"]})
    for call in message.get("tool_calls") or []:
        fn = call["function"]
        parts.append({"type": "tool_call", "id": call["id"], "name": fn["name"], "arguments": parse_arguments(fn["arguments"])})
    return {"role": message["role"], "parts": parts}


def mark_failed(span: trace.Span, error: Exception) -> None:
    span.set_status(Status(StatusCode.ERROR, str(error)))
    span.set_attribute("error.type", type(error).__qualname__)


def chat(agent: Agent, messages: list[dict[str, Any]], on_text: Callable[[str], None] | None = None) -> dict[str, Any]:
    """One model call = one `chat` span. Streams, so time to first chunk is recorded too."""
    attributes = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": PROVIDER,
        "gen_ai.request.model": agent.model,
        "gen_ai.system_instructions": json.dumps([{"type": "text", "content": agent.instructions}]),
        "gen_ai.input.messages": json.dumps([to_semconv(m) for m in messages]),
    }
    with tracer.start_as_current_span(f"chat {agent.model}", kind=SpanKind.CLIENT, attributes=attributes) as span:
        try:
            started = time.perf_counter()
            stream = client.chat.completions.create(
                model=agent.model,
                messages=[{"role": "system", "content": agent.instructions}, *messages],
                tools=[tool.definition for tool in agent.tools.values()] or omit,
                stream=True,
                stream_options={"include_usage": True},  # without it, streamed calls report no tokens
            )
            response_id, model, text, finish_reason, usage = "", agent.model, "", "stop", None
            calls: dict[int, dict[str, Any]] = {}
            for chunk in stream:
                if not response_id:
                    span.set_attribute("gen_ai.response.time_to_first_chunk", time.perf_counter() - started)
                response_id, model = chunk.id, chunk.model
                usage = chunk.usage or usage
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                finish_reason = choice.finish_reason or finish_reason
                if choice.delta.content:
                    text += choice.delta.content
                    if on_text:
                        on_text(choice.delta.content)
                for delta in choice.delta.tool_calls or []:
                    call = calls.setdefault(delta.index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                    call["id"] = delta.id or call["id"]
                    if delta.function:
                        call["function"]["name"] += delta.function.name or ""
                        call["function"]["arguments"] += delta.function.arguments or ""
            reply: dict[str, Any] = {"role": "assistant", "content": text}
            if calls:
                reply["tool_calls"] = [calls[i] for i in sorted(calls)]
            span.set_attributes({
                "gen_ai.response.id": response_id,
                "gen_ai.response.model": model,
                "gen_ai.response.finish_reasons": [finish_reason],
                "gen_ai.output.messages": json.dumps([{**to_semconv(reply), "finish_reason": finish_reason}]),
            })
            if usage:
                span.set_attributes({
                    "gen_ai.usage.input_tokens": usage.prompt_tokens,
                    "gen_ai.usage.output_tokens": usage.completion_tokens,
                    "gen_ai.usage.cache_read.input_tokens": getattr(usage.prompt_tokens_details, "cached_tokens", None) or 0,
                    "gen_ai.usage.reasoning.output_tokens": getattr(usage.completion_tokens_details, "reasoning_tokens", None) or 0,
                })
                cost = getattr(usage, "cost", None)  # OpenRouter returns USD cost
                if cost is not None:
                    span.set_attribute("gen_ai.usage.cost", cost)
            return reply
        except Exception as error:
            mark_failed(span, error)
            raise


def run_tool(agent: Agent, call: dict[str, Any]) -> str:
    """One tool call = one `execute_tool` span. A failure is marked on the span and returned to the model."""
    name, arguments = call["function"]["name"], call["function"]["arguments"] or "{}"
    attributes = {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name,
        "gen_ai.tool.type": "function",
        "gen_ai.tool.call.id": call["id"],
        "gen_ai.tool.call.arguments": arguments,
    }
    with tracer.start_as_current_span(f"execute_tool {name}", kind=SpanKind.INTERNAL, attributes=attributes) as span:
        try:
            result = agent.tools[name].run(**json.loads(arguments))
            output = result if isinstance(result, str) else json.dumps(result)
            span.set_attribute("gen_ai.tool.call.result", output)
            return output
        except Exception as error:
            mark_failed(span, error)
            return json.dumps({"error": str(error)})


def run_agent(
    agent: Agent,
    messages: list[dict[str, Any]],
    conversation_id: str | None = None,
    on_text: Callable[[str], None] | None = None,
) -> str:
    """One agent run = one `invoke_agent` span. For a user turn it is the root of the trace."""
    attributes = {"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": agent.name}
    if conversation_id:
        attributes["gen_ai.conversation.id"] = conversation_id
    if messages:
        attributes["gen_ai.input.messages"] = json.dumps([to_semconv(messages[-1])])
    with tracer.start_as_current_span(f"invoke_agent {agent.name}", kind=SpanKind.INTERNAL, attributes=attributes) as span:
        try:
            for _ in range(10):
                reply = chat(agent, messages, on_text)
                messages.append(reply)
                if not reply.get("tool_calls"):
                    span.set_attribute("gen_ai.output.messages", json.dumps([to_semconv(reply)]))
                    return reply["content"]
                for call in reply["tool_calls"]:
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": run_tool(agent, call)})
            raise RuntimeError("agent exceeded 10 steps")
        except Exception as error:
            mark_failed(span, error)
            raise
```

## main.py (chat backend entry point)

```py
# main.py
from tracing import provider  # first import: sets up the provider

from agent import Agent, Tool, run_agent

get_weather = Tool(
    definition={
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Current weather for a city",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
        },
    },
    run=lambda city: {"city": city, "temperature_c": 21, "condition": "partly cloudy"},
)
assistant = Agent("support", "openai/gpt-4o-mini", "You are a concise assistant.", {"get_weather": get_weather})

# One history per conversation. Store it in your database in a real backend.
histories: dict[str, list[dict]] = {}


def handle_message(chat_id: str, text: str, on_text=None) -> str:
    history = histories.setdefault(chat_id, [])
    history.append({"role": "user", "content": text})
    return run_agent(assistant, history, conversation_id=chat_id, on_text=on_text)


if __name__ == "__main__":
    # In a script: two messages of one conversation, then flush
    try:
        handle_message("chat_42", "Hi! Briefly introduce yourself.")
        handle_message("chat_42", "What's the weather in Berlin?", on_text=lambda d: print(d, end="", flush=True))
    finally:
        provider.shutdown()
```

## Sub-agent (delegation through a tool)

```py
weather_worker = Agent("weather_worker", "openai/gpt-4o-mini", "Answer weather questions with get_weather.", {"get_weather": get_weather})
orchestrator = Agent(
    "orchestrator",
    "openai/gpt-4o-mini",
    "Delegate weather questions to the weather worker.",
    {
        "ask_weather_worker": Tool(
            definition={
                "type": "function",
                "function": {
                    "name": "ask_weather_worker",
                    "description": "Ask the weather worker a question",
                    "parameters": {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]},
                },
            },
            # No conversation_id: the sub-agent's spans are in this trace, so it inherits the session
            run=lambda question: run_agent(weather_worker, [{"role": "user", "content": question}]),
        )
    },
)
```

## Context across threads and async

- asyncio: `start_as_current_span` context survives `await`; an async variant only needs `AsyncOpenAI` and `async for`.
- Threads (`ThreadPoolExecutor`, `run_in_executor`): context is empty in the worker. Submit `contextvars.copy_context().run, fn, *args` so tool spans stay in the turn's trace.

## Flush

- Script/CLI: `provider.shutdown()` in `finally`.
- Lambda/Cloud Functions: `trace.get_tracer_provider().force_flush()` in `finally` of the handler.
- Celery/RQ workers, notebooks: `force_flush()` after each task/cell.

