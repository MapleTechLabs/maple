---
title: "Trace Pydantic AI agents with OpenTelemetry"
description: "Send Pydantic AI's built-in OpenTelemetry spans to Maple so each conversation is one Agent Session with its transcript, tool calls, sub-agents and tokens, with or without Logfire."
group: "AI Agents"
order: 20
navLabel: "Pydantic AI"
icon: "pydantic"
---

Pydantic AI has its own OpenTelemetry instrumentation, and it's good. Every `agent.run()` emits an `invoke_agent` span, a `chat` span per model request with the prompt, the reply and the token counts, and an `execute_tool` span per tool call with its arguments and result. All of it follows the GenAI semantic conventions Maple reads, so you don't need Logfire or an extra instrumentation package. You give Pydantic AI a `TracerProvider` that exports to Maple.

The part that goes wrong is the conversation id. Every span carries `gen_ai.conversation.id`, so the traces look grouped, but unless you pass an id, Pydantic AI generates a new UUID7 for each run. A chat backend that handles one message per request gets one session per message, and an agent that delegates to other agents gets a different id for every delegate.

This guide covers Pydantic AI 2.x on Python 3.10 or newer. It was tested with `pydantic-ai-slim` 2.51.0 and the OpenTelemetry Python SDK 1.45.0, and with Logfire 5.1.1 for the Logfire setup.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-pydantic-ai](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-pydantic-ai) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Pydantic AI in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-pydantic-ai -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Export Pydantic AI spans to Maple

Install the OpenTelemetry SDK and the OTLP/HTTP exporter next to Pydantic AI:

```bash
pip install "pydantic-ai-slim[openai]>=2.51" "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Swap `[openai]` for the extras of the providers you use (`anthropic`, `google`, `openrouter`, ...). The full `pydantic-ai` package works the same way.

Point the exporter at Maple with the standard OpenTelemetry variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself.

Then set up tracing once, when your process starts:

```py
# tracing.py
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from pydantic_ai import Agent, InstrumentationSettings

provider = TracerProvider(
    resource=Resource.create(
        {"service.name": "support-agent", "deployment.environment.name": "production"}
    )
)
# Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

Agent.instrument_all(
    InstrumentationSettings(
        tracer_provider=provider,
        include_content=True,
        include_binary_content=False,
    )
)
```

Import `tracing` at the top of your entry point (`main.py`, the FastAPI app module, the worker). `Agent.instrument_all()` sets the default for every agent, including agents created before it runs, so the order relative to your agent modules doesn't matter. What matters is that it runs before the first `agent.run()`.

If your app already has a `TracerProvider` (from `opentelemetry-instrument`, Sentry or your own setup), don't create a second one. Add the `BatchSpanProcessor` above to the existing provider and call `Agent.instrument_all(InstrumentationSettings(include_content=True, include_binary_content=False))` without `tracer_provider`, so Pydantic AI uses the global one.

Leave `version` at its default. Pydantic AI's instrumentation format is versioned separately from the package: 5 is the default, 2 to 4 are deprecated and emit a warning, and 6 is an opt-in that sends tool results with `role: "tool"`. Version 2 used different span names; this guide was tested with 5.

### Already using Logfire

Logfire sets up the same instrumentation and can export to any OTLP backend. It brings its own OpenTelemetry SDK and OTLP exporter, so skip the `pip install` line above: Logfire 5.1 requires `opentelemetry-sdk` below 1.45, and the `>=1.45` pins make the install fail to resolve. Keep the three `OTEL_EXPORTER_OTLP_*` variables and configure Logfire like this:

```py
import logfire

logfire.configure(service_name="support-agent", environment="production", send_to_logfire=False)
logfire.instrument_pydantic_ai()
```

Logfire adds an OTLP exporter whenever `OTEL_EXPORTER_OTLP_ENDPOINT` is set. With `send_to_logfire=True` (or a Logfire token in the environment), spans go to both Logfire and Maple.

Logfire scrubs attributes by default, which changes what reaches Maple. The conversation id and the prompt and reply messages are exempt, but tool arguments, tool results and the run's `final_result` are not. A tool result that contains `session`, `auth`, `password`, `cookie` or `secret` anywhere in its text arrives as `[Scrubbed due to 'session']`. See [Record prompts, responses and tool calls](#record-prompts-responses-and-tool-calls) for how to keep it.

## Group every turn of a conversation into one session

Maple groups traces into sessions by `gen_ai.conversation.id`. Pydantic AI puts it on every span it emits, and picks the value in this order:

1. the `conversation_id=` you pass to `run()`, `run_stream()` or `iter()`;
2. the id stamped on the last message of `message_history`;
3. a new UUID7.

So a chat backend that stores the message history and passes it back keeps one id, as long as the first run of the conversation got one. A backend that starts each request without history, or that rebuilds the history from its own database, gets a new session for every message. Pass your own id on every run, from the chat or thread id your app already has:

```py
from pydantic_ai import Agent

support = Agent("openai:gpt-4o-mini", name="support")


async def handle_message(chat_id: str, text: str, history: list) -> str:
    result = await support.run(text, conversation_id=chat_id, message_history=history)
    return result.output
```

The id must be stable for the whole conversation and different between conversations. A per-process constant merges every user into one session.

If you skip this, each request shows up in **Agent Sessions** as its own one-turn session, named after a UUID.

Streaming works the same way. Pass `conversation_id=` to `run_stream()`, and keep the `async with` block open until the stream is finished, because the `invoke_agent` span ends when the block exits:

```py
async def stream_reply(chat_id: str, text: str, history: list):
    async with support.run_stream(text, conversation_id=chat_id, message_history=history) as run:
        async for delta in run.stream_text(delta=True):
            yield delta
```

## Record prompts, responses and tool calls

Content capture is on by default in Pydantic AI (`include_content=True`). Each `chat` span carries `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions` as JSON in the GenAI message format, and each `execute_tool` span carries `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Maple builds the transcript from those attributes.

Two settings are worth changing:

- `include_binary_content=False` keeps images, audio and documents out of the spans. With it on, a single uploaded PDF can put megabytes of base64 into every later `chat` span of that run, since each request repeats the history.
- `include_content=False` drops prompts, replies, tool arguments and tool results. The messages keep their roles and part types, so the transcript shows the shape of the conversation with no text. Turns, models, tool names, tokens and errors are unaffected. Exception messages are dropped too; only the exception type is kept.

To turn content off for one agent only, set it on that agent:

```py
from pydantic_ai import Agent, InstrumentationSettings
from pydantic_ai.capabilities import Instrumentation

billing = Agent(
    "openai:gpt-4o-mini",
    name="billing",
    capabilities=[Instrumentation(settings=InstrumentationSettings(include_content=False))],
)
```

An agent with its own `Instrumentation` capability ignores `Agent.instrument_all()`, and without `tracer_provider=` it uses the global provider you set in `tracing.py`.

Logfire's scrubbing does not protect prompts. The message attributes are exempt from it, so a user who types a password into the chat sends it to Maple either way. If you need pattern-based redaction of message content, run it in an OpenTelemetry Collector between your app and Maple.

With Logfire, keep tool content intact by letting those attributes through the scrubber:

```py
import logfire

TOOL_CONTENT = {"gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "final_result"}


def keep_tool_content(match: logfire.ScrubMatch):
    if len(match.path) > 1 and match.path[1] in TOOL_CONTENT:
        return match.value  # keep; returning None redacts


logfire.configure(
    service_name="support-agent",
    send_to_logfire=False,
    scrubbing=logfire.ScrubbingOptions(callback=keep_tool_content),
)
```

## Tools, errors and sub-agents

Every tool call is an `execute_tool <tool name>` span with `gen_ai.tool.name`, the provider's `gen_ai.tool.call.id`, and the arguments and result. Maple matches each call to the model reply that requested it by that id.

How a tool fails decides what Maple shows:

| In your tool | Span status | Run continues | In Maple |
| --- | --- | --- | --- |
| `raise ToolFailed("...")` | ERROR | yes, the model sees the message | failed call, message as its result |
| `raise ModelRetry("...")` | ERROR | yes, the model retries | one failed call per retry |
| any other exception | ERROR | no, the run raises | failed call and failed turn |
| `return {"error": "..."}` | UNSET | yes | successful call |

For an upstream error the model should work around, raise `ToolFailed` (Pydantic AI 2.16 or newer). It marks the span failed, records the message as the tool result, and doesn't use up the tool's retry budget:

```py
from pydantic_ai import ToolFailed


@support.tool_plain
def fetch_transport_data(city: str) -> dict:
    """Fetch live public-transport data for a city."""
    raise ToolFailed("transport data service unavailable (503)")
```

Returning an error payload keeps the span green, and Maple counts the call as a success.

Approval-gated tools (`requires_approval=True`) pause the run without a tool span. The call only gets an `execute_tool` span when the resumed run executes it, so pass the same `conversation_id=` to the run that sends `DeferredToolResults`.

### Sub-agents: pass the conversation id down

The common multi-agent pattern in Pydantic AI is delegation: a tool on the orchestrator calls `worker.run()`. The worker's run is nested in the orchestrator's trace, under the tool span, but it resolves its own conversation id, and with no history and no explicit id, that is a new UUID7. One trace then carries several ids. Maple uses one of them for the whole trace, and not necessarily yours, and it can split the turn into one turn per id.

Pass the caller's id and usage to every delegate:

```py
from pydantic_ai import Agent, RunContext

weather_worker = Agent("openai:gpt-4o-mini", name="weather_worker", tools=[get_weather])
orchestrator = Agent("openai:gpt-4o-mini", name="orchestrator")


@orchestrator.tool
async def research_weather(ctx: RunContext[None], city: str) -> str:
    """Delegate to the weather worker."""
    result = await weather_worker.run(
        f"What is the current weather in {city}?",
        usage=ctx.usage,
        conversation_id=ctx.conversation_id,
    )
    return result.output
```

Give every agent an explicit `name=`. It becomes `gen_ai.agent.name` on all of its spans, and Maple draws a lane per agent name. An `execute_tool research_weather` span whose only child is `invoke_agent weather_worker` shows as a delegation, with the tool's arguments and result as the lane's input and output. When several delegation tools are called in one model reply, Pydantic AI runs them concurrently and the lanes overlap in time.

A pipeline of separate top-level runs (orchestrator, then a summary agent) produces one trace per run. With the same `conversation_id=` on each, they land in one session as consecutive turns.

## Tokens and cost

Each `chat` span carries `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens` when the provider reports caching. Maple sums them per model call.

One exception: with Anthropic models on Pydantic AI's `anthropic` provider and prompt caching, Maple currently counts cached input tokens twice. Pydantic AI reports input tokens including the cache for every provider, and Maple applies Anthropic's own convention, where they're separate. OpenAI, OpenRouter and Gemini calls aren't affected.

The `invoke_agent` span reports the run's own total under `gen_ai.aggregated_usage.*`, which Maple doesn't add to the session total, so nothing is counted twice. A delegate's tokens stay on the delegate's spans.

Streaming needs nothing extra. Pydantic AI requests usage on OpenAI-compatible streams (`stream_options.include_usage`), so streamed calls have token counts too. The streamed `chat` span also records time to first chunk, under a key Maple doesn't read yet.

Cost shows as unpriced. Pydantic AI prices each call and writes the result to `operation.cost` on the `chat` span, but Maple reads cost only from `gen_ai.usage.cost` and never prices tokens itself. Tokens, models and call counts are complete.

## Short-lived processes

`BatchSpanProcessor` exports every few seconds, and the SDK flushes on a normal interpreter exit. That doesn't cover a Lambda that freezes after the handler returns, a worker killed by its supervisor, `os._exit()`, or a notebook kernel that never exits. Flush explicitly in those cases:

```py
import asyncio

from opentelemetry import trace


def handler(event, context):
    try:
        return asyncio.run(handle_message(event["chat_id"], event["text"], []))
    finally:
        trace.get_tracer_provider().force_flush()
```

In a script or CLI, call `provider.shutdown()` at the end. With Logfire, use `logfire.force_flush()` and `logfire.shutdown()`.

## Check that it works

Before you look in Maple, check the console. Pydantic AI prints an `observability: off` banner on the first run when no instrumentation is set up. If it's still there, `tracing.py` didn't run before your first `agent.run()`.

Run one conversation with at least two messages and a tool call, then open **Agent Sessions** in Maple. Spans take a few seconds to arrive. You should see:

- one session per conversation, with the id you passed as `conversation_id`, and framework **Pydantic AI**;
- one turn per `run()`, each labeled with the user's message, and a transcript with the prompts, replies and tool calls;
- `chat <model>` spans for model calls, `execute_tool <tool>` spans for tool calls, and `invoke_agent <agent name>` spans for runs;
- a lane per sub-agent, named after its `name=`;
- token counts on every model call, including streamed ones;
- failed tool calls marked as failed, with the `ToolFailed` message as the result;
- cost shown as unpriced.

## Troubleshooting

- **Every message is its own session.** No `conversation_id=` was passed and the history didn't carry one. Pass it on every `run()`, `run_stream()` and `iter()`.
- **A multi-agent run shows several turns, or lands in another session.** Delegates minted their own ids. Pass `conversation_id=ctx.conversation_id` to every nested `run()`.
- **All sub-agents share one lane called `agent`.** The agents have no `name=`. Set one on each.
- **Nothing arrives from a script or Lambda.** The process ended before the batch was exported. Call `force_flush()` or `shutdown()` in a `finally`.
- **The transcript has messages but no text.** `include_content=False` is set, in `instrument_all()` or in that agent's `Instrumentation` capability.
- **Tool arguments or results read `[Scrubbed due to ...]`.** Logfire's scrubbing matched a word in them. Add a scrubbing callback or set `scrubbing=False`.
- **A failed tool shows as successful.** The tool returned an error value instead of raising. Raise `ToolFailed`.
- **`chat` spans are huge or exports fail with 413.** Images or documents are being recorded as base64. Set `include_binary_content=False`.
- **Spans show up twice.** Pydantic AI and a second instrumentor (Logfire's `instrument_openai()`, OpenInference, OpenLLMetry) both trace the same model calls. Keep Pydantic AI's instrumentation and remove the other one for the model client.
- **The install fails to resolve `logfire` and `opentelemetry-sdk`.** Logfire 5.1 pins the SDK below 1.45. On the Logfire path, don't add the OpenTelemetry packages yourself; Logfire installs them.
- **A `PydanticAIDeprecationWarning` about instrumentation versions 2, 3 and 4.** Remove `version=` from `InstrumentationSettings` to use the default.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [All agent tracing guides](/docs/agent-tracing)
- [Pydantic AI: debugging and monitoring with OpenTelemetry](https://pydantic.dev/docs/ai/integrations/logfire/)
- [Instrument a Python application](/docs/guides/instrumentation-python)
