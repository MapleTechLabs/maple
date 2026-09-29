---
title: "Trace OpenAI Agents SDK runs with OpenTelemetry"
description: "Send OpenAI Agents SDK runs to Maple as one Agent Session per conversation, with the transcript, tool calls and tokens."
group: "AI Agents"
order: 12
navLabel: "OpenAI Agents SDK"
icon: "openai"
---

OpenInference's `openinference-instrumentation-openai-agents` exports OpenAI Agents SDK runs to Maple. Wrap each run in its `using_session` helper, or every message shows up as its own session.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-openai-agents](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-openai-agents) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for the OpenAI Agents SDK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-openai-agents -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is under **Settings → Ingestion**. EU organizations should say EU region.

## Install the bridge and point it at Maple

```bash
pip install "openai-agents>=0.22" "openinference-instrumentation-openai-agents>=2.5" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

EU organizations use `https://ingest.eu.maple.dev`. If you pass `endpoint=` to `OTLPSpanExporter` in code, give the full URL ending in `/v1/traces`.

## Register the bridge

Add a `tracing.py` and import it at the top of your entry point, before the first `Runner.run`:

```py
# tracing.py
from agents import set_trace_processors
from agents.tracing import TracingProcessor
from agents.tracing.span_data import FunctionSpanData, GenerationSpanData, HandoffSpanData
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def _chat_message(response: dict) -> dict:
    """The assistant message inside a Responses-shaped dict, as a Chat Completions message."""
    text, calls = "", []
    for item in response.get("output") or []:
        if item.get("type") == "message":
            text += "".join(c.get("text", "") for c in item.get("content") or [] if c.get("type") == "output_text")
        elif item.get("type") == "function_call":
            calls.append({"id": item["call_id"], "type": "function",
                          "function": {"name": item["name"], "arguments": item["arguments"]}})
    return {"role": "assistant", "content": text or None, "tool_calls": calls or None}


class MapleSpanFixes(TracingProcessor):
    """Fills three gaps in what OpenInference exports. Must run before the OpenInference processor."""

    def on_span_end(self, span):
        data = span.span_data
        current = trace.get_current_span()  # the matching OpenTelemetry span, still open here
        if isinstance(data, FunctionSpanData) and data.input and getattr(current, "name", None) == data.name:
            # Real arguments; OpenInference would copy the tool's JSON schema.
            current.set_attribute("gen_ai.tool.call.arguments", data.input)
        elif isinstance(data, HandoffSpanData) and data.to_agent:
            # Handoff spans carry no tool name.
            current.set_attribute("gen_ai.tool.name", f"transfer_to_{data.to_agent}")
        elif isinstance(data, GenerationSpanData) and data.output and data.output[0].get("object") == "response":
            # Streamed Chat Completions calls record a Responses object OpenInference can't read.
            data.output = [_chat_message(data.output[0])]

    def on_trace_start(self, t): pass
    def on_trace_end(self, t): pass
    def on_span_start(self, span): pass
    def shutdown(self): pass
    def force_flush(self): pass


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

# Replaces the SDK's default processor (which uploads to OpenAI) with MapleSpanFixes,
# then appends the OpenInference processor after it.
set_trace_processors([MapleSpanFixes()])
OpenAIAgentsInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
    exclusive_processor=False,
)
```

Without `enable_genai_semconv=True`, the session page is empty.

`MapleSpanFixes` fixes tool arguments, handoff tool names and streamed replies. It has to run before the OpenInference processor, so keep the order shown.

`set_trace_processors` already stops the upload to OpenAI. Don't use `set_tracing_disabled(True)` or `OPENAI_AGENTS_DISABLE_TRACING=1` for that, or you get no spans.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or another library), add the OTLP exporter to it and pass it to `instrument()` instead of creating a second one.

If an agent uses `OpenAIChatCompletionsModel` with a non-OpenAI base URL (OpenRouter, LiteLLM, vLLM, Ollama), give it `model_settings=ModelSettings(include_usage=True)`. Otherwise streamed turns report zero tokens.

## Group each conversation into one session

Wrap every run in `using_session` with the conversation's id:

```py
from agents import RunConfig, Runner, SQLiteSession
from openinference.instrumentation import using_session


async def handle_message(conversation_id: str, text: str) -> str:
    with using_session(conversation_id):
        result = await Runner.run(
            agent,
            text,
            session=SQLiteSession(conversation_id, "chats.db"),
            run_config=RunConfig(workflow_name="support workflow"),
        )
    return result.final_output
```

Use the id your app already stores the chat under, and give the SDK session the same one. A new UUID per request gives you one session per message.

For streaming, call `Runner.run_streamed` inside the `with` block.

Keep `chat`, `completion` and `tool` out of `workflow_name`, or Maple counts a phantom model or tool call per run.

## Flush in short-lived processes

In serverless functions and notebooks, flush explicitly:

```py
from tracing import provider

try:
    asyncio.run(handle_message("conv-42", "What's the weather in Berlin?"))
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

The SDK's `flush_traces()` doesn't flush these spans.

## Check that it works

Send two or three messages with the same conversation id, one using a tool, then open **Agent Sessions**. You should see one session with the framework **OpenAI Agents SDK**, one turn per `Runner.run`, tool calls with their arguments, and tokens on every model call. Cost shows as unpriced.

## TypeScript

The TypeScript bridge, `@arizeai/openinference-instrumentation-openai-agents`, gives less detail: the framework shows as **Unidentified**, model replies are missing from the transcript, and there are no agent lanes. It takes the session id as `gen_ai.conversation.id`. The [skill](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-openai-agents) has the setup. For the full session page, emit the GenAI attributes yourself as in the [provider SDKs guide](/docs/agent-tracing/provider-sdks).

## Troubleshooting

- **No spans at all.** Tracing is disabled somewhere (`set_tracing_disabled`, `OPENAI_AGENTS_DISABLE_TRACING`, `RunConfig(tracing_disabled=True)`), or `tracing.py` ran after the first `Runner.run`.
- **One session per message.** The run isn't inside `using_session(...)`, or the id changes per request. `group_id` and `SQLiteSession` ids don't reach Maple.
- **Tokens in the list, empty session page.** Pass `TraceConfig(enable_genai_semconv=True)` and use bridge 2.5 or later.
- **Streamed turns have zero tokens.** Add `ModelSettings(include_usage=True)` to agents on a non-OpenAI base URL.
- **Every model call appears twice.** Another instrumentation (`openinference-instrumentation-openai`, Logfire, Langfuse) is also active. Keep one.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Tracing in the OpenAI Agents SDK](https://openai.github.io/openai-agents-python/tracing/): the switch that turns off prompt and reply capture.
- [OpenRouter](/docs/agent-tracing/openrouter) and [LiteLLM](/docs/agent-tracing/litellm): if your models go through either gateway.
