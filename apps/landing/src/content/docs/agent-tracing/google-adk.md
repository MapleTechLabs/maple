---
title: "Trace Google ADK agents with OpenTelemetry"
description: "Send Google Agent Development Kit (ADK) traces to Maple with the full transcript, tool arguments and results, tokens, and one session per ADK session."
group: "AI Agents"
order: 22
navLabel: "Google ADK"
icon: "googleadk"
---

Google's Agent Development Kit (ADK) creates OpenTelemetry spans itself, with no instrumentation package: one span per run, per agent, per model call and per tool call, under the instrumentation scope `gcp.vertex.agent`. Every span carries the ADK session id as `gen_ai.conversation.id`, so a multi-turn chat groups into one Maple session without any extra code.

What goes wrong by default is the transcript. ADK writes prompts, replies and tool payloads into its own `gcp.vertex.agent.llm_request`, `llm_response`, `tool_call_args` and `tool_response` attributes, which Maple doesn't read, so the session shows models and tokens next to an empty conversation. Two environment variables switch ADK to the OpenTelemetry GenAI message format that Maple renders. The other trap: with a plain `Runner`, nothing exports at all until you register a tracer provider yourself.

This guide covers ADK for Python 2.10 and later. ADK for Go and Kotlin emit the same span names, but their setup isn't covered here.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-google-adk](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-google-adk) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Google ADK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-google-adk -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install ADK and the OTLP exporter

```bash
pip install "google-adk>=2.10" litellm opentelemetry-exporter-otlp-proto-http
```

`litellm` is only needed for non-Gemini models through ADK's `LiteLlm` wrapper. ADK 2.10 pins `opentelemetry-sdk` to 1.42.1 or lower, so let pip pick the exporter version that matches instead of pinning a newer one.

### Configure the export with environment variables

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

- The `%20` is an encoded space. OpenTelemetry header values are URL-encoded, and the Python SDK decodes it back to `Bearer YOUR_INGEST_KEY`.
- The exporter appends `/v1/traces` to `OTEL_EXPORTER_OTLP_ENDPOINT`. If you set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` instead, give the full `https://ingest.maple.dev/v1/traces`.
- The `proto-http` exporter always sends OTLP over HTTP with protobuf, which is what Maple ingests. Don't install the gRPC exporter.
- For an EU organization, use `https://ingest.eu.maple.dev`.

The content variables are explained [below](#record-prompts-responses-and-tool-calls).

### Register a tracer provider when you run ADK with a Runner

`adk web` and `adk api_server` build a tracer provider from the `OTEL_EXPORTER_OTLP_*` variables on startup. A `Runner` in your own FastAPI app, worker or script does not: ADK's spans go to OpenTelemetry's no-op default and nothing is exported, with no warning. Register one yourself:

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

Import it as the first line of your entry point, before your agents and before the first `runner.run_async()`:

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

If your app already sets up OpenTelemetry (Logfire, Sentry, a platform agent), don't create a second provider. Add the `SkipDuplicateToolSpans(OTLPSpanExporter())` processor to the existing one, since only the first provider set globally wins.

Under `adk web` or `adk api_server`, skip `telemetry.py`'s provider and rely on the environment variables. Register the plugin on your `App`, which is where the CLI looks for plugins: `App(name="support", root_agent=agent, plugins=[ToolCallAttributes()])`. The `SkipDuplicateToolSpans` processor can't be added there, since ADK owns that provider, so parallel calls and approval pauses add extra tool spans.

## Group turns into one session with the ADK session id

ADK stamps `session.id` as `gen_ai.conversation.id` on every `invoke_agent` and `generate_content` span, and Maple groups traces by it. Each `runner.run_async()` call is one trace and one turn, so a conversation is one Maple session as long as every turn uses the same ADK session:

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

Use your own thread or chat id as the ADK session id. With `auto_create_session=True`, the runner creates the session on the first turn under that id. A persistent session service (`DatabaseSessionService`, `VertexAiSessionService`) keeps it across restarts.

The common mistake is calling `create_session()` on every request without a `session_id`. ADK then mints a fresh UUID per turn, the model forgets the conversation, and Maple shows one single-turn session per message. Use `run_async()` rather than the synchronous `runner.run()` in servers.

## Record prompts, responses and tool calls

ADK has two content paths, and only one of them reaches Maple:

| Setting | What it does | Default |
| --- | --- | --- |
| `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` | Switches `generate_content` spans to the current GenAI conventions | off |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY` | Puts `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` and `gen_ai.tool.definitions` on the `generate_content` span | no content |
| `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` | ADK's own `gcp.vertex.agent.*` JSON attributes on `call_llm` and `execute_tool` spans | on |

With both OpenTelemetry settings, every `generate_content` span carries the full request history and the reply as `[{role, parts}]` JSON: user text, assistant text, `tool_call` parts with arguments and `tool_call_response` parts with results. That's the shape Maple's transcript renders.

- Without the stability opt-in, content goes to OpenTelemetry log records as `<elided>`, and Maple reads neither.
- A value of `true` for the capture variable means `EVENT_ONLY` for backward compatibility: log records, not spans. Use `SPAN_ONLY`.
- `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` only removes ADK's legacy copies, which Maple ignores. Without it, each model call sends its full history twice.

Tool spans don't get arguments or results from ADK in any mode yet. The `ToolCallAttributes` plugin from the setup adds them as `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`, so the tool pages in Maple show what each call received and returned. ADK runs tool callbacks inside the tool's span, which is why `trace.get_current_span()` is the right span there.

Both settings are read per run, so you can also set them per request with `RunConfig(telemetry=TelemetryConfig(genai_semconv_stability_opt_in="experimental", capture_message_content=ContentCapturingMode.SPAN_ONLY))` from `google.adk.telemetry.context`.

### Privacy

Everything a user types and every tool result is stored in Maple once content capture is on. To keep the structure, tokens and tool names but no content, leave `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` unset and delete the two `gen_ai.tool.call.*` lines from the `ToolCallAttributes` plugin. Keep the plugin itself, since it also marks approval pauses. To redact instead, scrub values in a tool callback or in an OpenTelemetry Collector with the `redaction` or `transform` processor before the data leaves your network.

## Tool errors, sub-agents and agents as tools

Tool spans are `execute_tool {tool name}` with `gen_ai.tool.name`, `gen_ai.tool.description` and `gen_ai.tool.call.id` matching the model's tool call. ADK 2.7 and later mark a failed tool call with span status ERROR and `error.type` in two cases:

- **The tool raises.** The exception is recorded on the span, and the whole run fails unless something handles it.
- **The tool returns a dict with a non-empty `"error"` key.** ADK sets `error.type=TOOL_ERROR`. This is the way to report an expected failure to the model and still see it in Maple.

ADK's tutorials often return `{"status": "error", "error_message": "..."}`. ADK doesn't recognize that shape, so those calls show as successful. Use `{"error": "..."}`.

If a tool raising should not end the run, let the model see the error instead with an `on_tool_error_callback`. The span keeps its ERROR status because the returned dict has an `error` key:

```py
class ToolErrorsAsResults(BasePlugin):
    def __init__(self):
        super().__init__(name="tool_errors_as_results")

    async def on_tool_error_callback(self, *, tool, tool_args, tool_context, error):
        return {"error": str(error)}
```

A tool that asks for confirmation (`FunctionTool(func, require_confirmation=True)`) gets two `execute_tool` spans with the same call id: one when ADK pauses the call, and one when the approved call runs in the next `run_async()`. The pause span isn't marked failed, but Maple would count it as a second call. The plugin marks it and `SkipDuplicateToolSpans` drops it, so each approved call counts once, in the trace where it ran. Send the approval with the same `session_id` and it stays in the same session. If the user rejects the call, the span is marked failed with ADK's "This tool call is rejected" result.

### Sub-agents

Every agent run is an `invoke_agent {agent name}` span with `gen_ai.agent.name`, and each model call's `generate_content` span repeats the agent name, so Maple opens one lane per agent. `SequentialAgent`, `ParallelAgent` and `LoopAgent` nest their children's `invoke_agent` spans, and `ParallelAgent` children run concurrently as sibling spans.

To call an agent like a tool, add it to `sub_agents` with `mode="single_turn"`. ADK runs it inside the parent's session. Each delegation produces an `execute_tool {agent name}` span, with the sub-agent's reply as its result, and a sibling `invoke_agent {agent name}` span. Both sit directly under the parent agent, so Maple opens a lane for the sub-agent and counts the `execute_tool` span as one tool call. When the model delegates to several agents in one response, they run in parallel.

Avoid wrapping agents in `AgentTool`. It runs the sub-agent in a new in-memory session with a new id, so its spans carry a second `gen_ai.conversation.id` inside your trace. Maple keeps one id per trace and picks the larger of the two, which can move that turn into a session of its own. ADK's API docs also discourage `AgentTool` in favor of `mode="single_turn"`.

## Tokens and cost

`generate_content` spans carry `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.reasoning.output_tokens` when the model reports them. ADK counts cached tokens inside the input and thinking tokens inside the output, which is how Maple adds them up.

- Streamed turns (`RunConfig(streaming_mode=StreamingMode.SSE)`) report usage too. `LiteLlm` requests it with `stream_options.include_usage`.
- The `call_llm` span above each `generate_content` repeats the same usage. Maple nets a parent's usage against its children, so each call is counted once.
- ADK doesn't record cost, and Maple doesn't price tokens, so ADK sessions show as **unpriced**. LiteLLM computes a cost, but it never reaches ADK's spans.

## Flush spans before a short-lived process exits

`BatchSpanProcessor` sends spans every 5 seconds. A script, CLI, notebook cell or job that exits sooner loses the last turn. Flush and shut down the provider when the work ends:

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

In a long-running server, call `provider.shutdown()` from your shutdown hook (FastAPI `lifespan`, for example). On Cloud Run or another platform that freezes the CPU between requests, call `provider.force_flush()` before the response returns, or background export stalls until the next request.

## Check that it works

Run one conversation of two or three turns, one of which calls a tool, then open **Agent Sessions** in Maple. Spans leave the process within 5 seconds and usually show up within a minute. You should see:

- **One session per ADK session id**, with the framework shown as **Google ADK** and one turn per `run_async()` call.
- **A transcript** on the session page: the user messages, the assistant replies, and each tool call with its arguments and result.
- **LLM calls and tokens** for each `generate_content {model}` span, with the model from `gen_ai.request.model` (for LiteLLM, the full id such as `openrouter/openai/gpt-4o-mini`).
- **Tool calls** named after your functions, with failed ones counted as errors.
- **Cost** shown as unpriced.

In the trace view, a turn looks like this:

```text
invocation
└─ invoke_agent assistant
   ├─ call_llm
   │  └─ generate_content openrouter/openai/gpt-4o-mini
   ├─ execute_tool get_weather
   └─ call_llm
      └─ generate_content openrouter/openai/gpt-4o-mini
```

## Troubleshooting

- **No spans at all.** You run ADK through a `Runner` and never registered a tracer provider. Only `adk web` and `adk api_server` build one from the environment. Import `telemetry.py` first.
- **Sessions show tokens but an empty transcript.** `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY` is missing, or the capture variable is `true`, which means log records only. Both must be in the process environment before the run starts.
- **Every message is its own session.** Each request creates a new ADK session. Pass your conversation id as `session_id` on every turn.
- **One turn lands in a different session.** An `AgentTool` ran a sub-agent under its own session id. Use `sub_agents` with `mode="single_turn"`.
- **A tool named `(merged tools)`.** ADK's summary span for parallel tool calls. Add the `SkipDuplicateToolSpans` processor.
- **A confirmation-gated tool counts twice.** ADK records the paused call and the approved call as separate spans. Register `ToolCallAttributes` and `SkipDuplicateToolSpans` together: the plugin marks the pause and the processor drops it.
- **A failing tool shows as successful.** It returned `{"status": "error", ...}` or a string. Return a dict with an `"error"` key, or raise.
- **The streamed reply appears twice in the transcript, once in pieces.** With `StreamingMode.SSE`, ADK records every streamed chunk in `gen_ai.output.messages` and then the complete reply. The tokens are right; the transcript repeats the text.
- **Every model call appears twice, with doubled tokens.** Another instrumentor wraps the same calls: `litellm.callbacks = ["otel"]`, `openinference-instrumentation-google-adk`, or an OpenAI or LiteLLM instrumentor. ADK's own spans are enough; remove the others.
- **`gen_ai.system` says `gemini` for an OpenAI model.** ADK before 2.7 hardcoded it. Upgrade. With the settings in this guide, `generate_content` spans carry no provider attribute, which doesn't affect grouping, tokens or the transcript.
- **The model name has a provider prefix.** ADK records the requested model (`openrouter/openai/gpt-4o-mini`), never the model that served the response. It also records no `gen_ai.response.id`, so Maple can't merge a call that a second instrumentor reports again. That's one more reason to keep ADK's spans as the only ones.
- **401 from the exporter.** The header must read `Authorization=Bearer%20<key>`, with the key from **Settings → Ingestion** for the right region.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): how Maple builds sessions, turns and checks.
- [Agent tracing guides](/docs/agent-tracing): every framework.
- [ADK agent activity traces](https://google.github.io/adk-docs/observability/traces/): ADK's span reference and export setup.
- [LiteLLM](/docs/agent-tracing/litellm): tracing LiteLLM on its own, outside ADK.
- [OpenTelemetry for any agent](/docs/agent-tracing/opentelemetry): the GenAI attributes Maple reads.
