# Python: install, init, helper, loop

Tested: Python 3.10+, `opentelemetry-sdk` 1.45.0, `opentelemetry-exporter-otlp-proto-http` 1.45.0, `opentelemetry-instrumentation-genai-openai` / `-genai-anthropic` / `opentelemetry-instrumentation-google-genai` 1.2b0 (pull `opentelemetry-util-genai` 1.2b0), `openai` 3.20.0, `anthropic` 1.8.0, `google-genai` 2.25.0.

## Install

Add with the repo's package manager (uv/poetry/pip). Only the instrumentation(s) for SDKs the service imports:

```bash
pip install "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45" \
  "opentelemetry-instrumentation-genai-openai>=1.2b0"        # openai
# "opentelemetry-instrumentation-genai-anthropic>=1.2b0"     # anthropic
# "opentelemetry-instrumentation-google-genai>=1.2b0"        # google-genai
```

Package names matter: `opentelemetry-instrumentation-openai` / `-anthropic` are OpenLLMetry (Traceloop), not these.

## tracing.py

```py
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.genai.openai import OpenAIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider(resource=Resource.create({"service.name": "support-agent"}))
# Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

OpenAIInstrumentor().instrument()
# from opentelemetry.instrumentation.genai.anthropic import AnthropicInstrumentor; AnthropicInstrumentor().instrument()
# from opentelemetry.instrumentation.google_genai import GoogleGenAiSdkInstrumentor; GoogleGenAiSdkInstrumentor().instrument()
```

- Import `tracing` first in the entry point (app module, `main.py`, worker).
- The exporter reads `OTEL_*` when it is built, and `agent_tracing` reads the capture switch when it is imported. If the app uses python-dotenv, call `load_dotenv()` at the top of `tracing.py`; otherwise the exporter silently targets `localhost:4318` with no key.
- No env convention in the repo: pass the values inline, `OTLPSpanExporter(endpoint="https://ingest.maple.dev/v1/traces", headers={"Authorization": "Bearer <key>"})`, rather than a lookup that can come out empty.
- Existing provider → don't create one; add the processor to it and just call `.instrument()`.
- Using `opentelemetry-instrument` (zero-code)? It already calls every installed instrumentor; don't call `.instrument()` again, and make sure no other GenAI instrumentation package is installed.

## agent_tracing.py (copy verbatim, rename the tracer)

```py
import json
import os
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

tracer = trace.get_tracer("support-agent")

CAPTURE_CONTENT = os.environ.get(
    "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", ""
).upper() in ("SPAN_ONLY", "SPAN_AND_EVENT")


@contextmanager
def agent_span(agent_name: str, conversation_id: str | None = None):
    """One agent run. With a conversation id, it's the turn Maple files under that session."""
    attributes = {"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": agent_name}
    if conversation_id:
        attributes["gen_ai.conversation.id"] = conversation_id
    with tracer.start_as_current_span(f"invoke_agent {agent_name}", attributes=attributes) as span:
        yield span


def run_tool(call_id: str, name: str, arguments: str, tool) -> str:
    """One tool call. A failing tool returns its error to the model, and the span still says it failed."""
    with tracer.start_as_current_span(
        f"execute_tool {name}",
        attributes={
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name,
            "gen_ai.tool.call.id": call_id,
        },
    ) as span:
        if CAPTURE_CONTENT:
            span.set_attribute("gen_ai.tool.call.arguments", arguments)
        try:
            result = json.dumps(tool(**json.loads(arguments)))
        except Exception as exc:
            # The exception never leaves this block, so mark the span failed by hand.
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.set_attribute("error.type", type(exc).__qualname__)
            result = json.dumps({"error": str(exc)})
        if CAPTURE_CONTENT:
            span.set_attribute("gen_ai.tool.call.result", result)
        return result
```

Async tools: make an `async def run_tool_async` with the same body and `await tool(...)`.

## Loop (OpenAI Chat Completions)

```py
def chat_turn(conversation_id: str, history: list, user_text: str) -> str:
    with agent_span("support_agent", conversation_id):
        history.append({"role": "user", "content": user_text})
        while True:
            response = client.chat.completions.create(model=MODEL, messages=history, tools=TOOL_SCHEMAS)
            message = response.choices[0].message
            history.append(message.model_dump(include={"role", "content", "tool_calls"}, exclude_none=True))
            if not message.tool_calls:
                return message.content or ""
            for call in message.tool_calls:
                result = run_tool(call.id, call.function.name, call.function.arguments, TOOLS[call.function.name])
                history.append({"role": "tool", "tool_call_id": call.id, "content": result})
```

Adapt the existing loop; don't rewrite the app's logic. The tracing is the `with agent_span(...)` and the `run_tool(...)` call.

Streaming (OpenAI):

```py
stream = client.chat.completions.create(
    model=MODEL, messages=history, stream=True, stream_options={"include_usage": True}
)
reply = "".join(chunk.choices[0].delta.content or "" for chunk in stream if chunk.choices)
```

## Anthropic loop shape

```py
with agent_span("support_agent", conversation_id):
    history.append({"role": "user", "content": user_text})
    while True:
        response = client.messages.create(model=MODEL, max_tokens=1024, system=SYSTEM, messages=history, tools=TOOL_SCHEMAS)
        history.append({"role": "assistant", "content": response.content})
        calls = [b for b in response.content if b.type == "tool_use"]
        if not calls:
            return "".join(b.text for b in response.content if b.type == "text")
        history.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": b.id, "content": run_tool(b.id, b.name, json.dumps(b.input), TOOLS[b.name])}
            for b in calls
        ]})
```

`client.messages.stream(...)` is instrumented too (`with client.messages.stream(**kw) as s: response = s.get_final_message()`); usage arrives without extra options.

Anthropic SDK through OpenRouter: `anthropic.Anthropic(base_url="https://openrouter.ai/api", api_key=OPENROUTER_API_KEY)` (no `/v1`; `auth_token=` also works), model ids like `anthropic/claude-haiku-4.5`. Spans say `gen_ai.provider.name=anthropic`.

## Gemini

- Automatic function calling (Python functions passed in `tools=`): wrap the turn in `agent_span` only; the instrumentation emits `execute_tool` spans for the SDK-run functions.
- Model spans are named `generate_content <model>`.
