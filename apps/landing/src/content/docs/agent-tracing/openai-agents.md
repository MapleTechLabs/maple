---
title: "Trace OpenAI Agents SDK runs with OpenTelemetry"
description: "Send OpenAI Agents SDK runs to Maple as Agent Sessions, one per conversation, with the transcript, model and tool calls, tokens, failed tools, handoffs and agents as tools."
group: "AI Agents"
order: 12
navLabel: "OpenAI Agents SDK"
icon: "openai"
---

The OpenAI Agents SDK traces every run out of the box, but not with OpenTelemetry. Its tracing pipeline builds its own traces and spans (agent, generation, function, handoff, guardrail) and uploads them to the OpenAI dashboard. To get them into Maple you swap that uploader for OpenInference's `openinference-instrumentation-openai-agents`, which turns each SDK span into an OpenTelemetry span as it ends.

The SDK's own way to tie the traces of one chat together, `group_id`, never reaches OpenTelemetry. The bridge drops it, so a ten-message conversation shows up in Maple as ten one-turn sessions until you wrap each run in OpenInference's `using_session`. A few more defaults need changing: the bridge writes OpenInference attributes that Maple's session page doesn't decode for this framework, and streamed calls to any provider other than OpenAI lose their tokens and their reply.

This guide covers `openai-agents` 0.22 with `openinference-instrumentation-openai-agents` 2.5 on Python 3.10 to 3.14. TypeScript (`@openai/agents`) works with less detail; see [TypeScript](#typescript-openaiagents).

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-openai-agents](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-openai-agents) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for the OpenAI Agents SDK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-openai-agents -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the bridge and export to Maple

```bash
pip install "openai-agents>=0.22" "openinference-instrumentation-openai-agents>=2.5" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Point the exporter at Maple with the standard OpenTelemetry variables:

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

EU organizations use `https://ingest.eu.maple.dev`. `OTLPSpanExporter()` with no arguments appends `/v1/traces` to that base URL and sends `http/protobuf`. If you pass `endpoint=` in code instead, it's used as is, so it has to end in `/v1/traces`.

Then add a `tracing.py` and import it at the top of your entry point:

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

What each part does:

- **`enable_genai_semconv=True`** makes OpenInference write the OpenTelemetry GenAI attributes (`gen_ai.operation.name`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.*`, `gen_ai.agent.name`, `gen_ai.tool.*`) next to its own `llm.*` attributes when each span ends. Without it, the Agent Sessions list shows token counts but the session page has no transcript. `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` does the same, but only if it's set before `TraceConfig` is built; passing it in code avoids that trap.
- **`MapleSpanFixes`** fills three gaps in what the bridge exports. The GenAI dual-write fills `gen_ai.tool.call.arguments` from `tool.parameters`, which is the tool's JSON schema, so every tool call would show `{"properties": {"city": ...}}` instead of `{"city": "Berlin"}`; the dual-write never overwrites a key that's already set, so the processor sets the real arguments first. Handoff spans get no tool name, so it names them `transfer_to_<agent>`, the tool the model called. And a streamed Chat Completions call records its reply as a Responses API object the bridge can't parse, so without the fix the streamed turn has no reply in the transcript; the processor rewrites it into a Chat Completions message before the bridge reads it.
- **`set_trace_processors([...])` plus `exclusive_processor=False`** puts `MapleSpanFixes` ahead of the OpenInference processor, which the ordering requires. It also removes the SDK's default processor, so nothing is uploaded to the OpenAI dashboard and you don't need an OpenAI key for tracing. To keep that upload too, pass `set_trace_processors([MapleSpanFixes(), default_processor()])` with `default_processor` from `agents.tracing.processors`.

The bridge hooks into the SDK's processor list rather than patching imports, so import order only matters in one way: `tracing.py` has to run before the first `Runner.run`.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or another library), don't create a second one. Add the OTLP exporter to the existing provider and pass that provider to `instrument()`.

Don't call `set_tracing_disabled(True)`, set `OPENAI_AGENTS_DISABLE_TRACING=1` or pass `RunConfig(tracing_disabled=True)` to stop the upload to OpenAI. Those switch off the SDK's whole tracing pipeline, which is where the bridge gets its data, and you get zero spans.

### Models from other providers

With an `OPENAI_API_KEY`, agents use OpenAI's Responses API and need nothing extra. To use another provider through an OpenAI-compatible endpoint (OpenRouter, LiteLLM, vLLM, Ollama), give the agent a `OpenAIChatCompletionsModel` and turn on `include_usage`:

```py
import os

from agents import Agent, ModelSettings, OpenAIChatCompletionsModel
from openai import AsyncOpenAI

client = AsyncOpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"])

agent = Agent(
    name="assistant",
    instructions="You are a helpful assistant. Be brief.",
    model=OpenAIChatCompletionsModel(model="openai/gpt-4o-mini", openai_client=client),
    model_settings=ModelSettings(include_usage=True),
)
```

The SDK only asks for token usage on streamed Chat Completions calls when the client points at `api.openai.com`. For any other base URL it sends no `stream_options`, the provider returns no usage chunk, and every `Runner.run_streamed` turn has zero tokens. `include_usage=True` sends `stream_options={"include_usage": true}`; non-streamed calls report usage either way.

## Group a conversation into one session

Each `Runner.run` is its own trace. The SDK has two ids that look like the answer, and neither reaches OpenTelemetry: `RunConfig(group_id=...)` and the `session_id` of a `SQLiteSession` stay inside the SDK. Maple groups this framework's traces by the `session.id` attribute, and the bridge only sets it inside OpenInference's `using_session`:

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

Use your app's own conversation id, the one it already stores the chat under, and give the SDK session the same one. A new UUID per request gives you one session per message again, and a constant gives every user one shared session.

`using_session` stores the id in a Python contextvar. The bridge copies it onto every span it creates inside the block, including tool calls that run concurrently and agents called as tools, because asyncio tasks inherit the context. For streaming, call `Runner.run_streamed` inside the block; the SDK starts its background task there, so iterating `stream_events()` afterwards is fine:

```py
with using_session(conversation_id):
    result = Runner.run_streamed(agent, text, session=SQLiteSession(conversation_id, "chats.db"))
    async for event in result.stream_events():
        ...
```

`workflow_name` names the trace's root span. The default is `Agent workflow`, which is the same for every run in your app. Keep `chat`, `completion` and `tool` out of the name. The bridge also gives each run a bookkeeping span with that name and no operation, and Maple classifies such spans by name: `support chat` would add one phantom LLM call per run, and `tool` in the name a phantom tool call. A name ending in `workflow` or `agent` is safe.

If you skip `using_session`, every run shows up in **Agent Sessions** as its own one-turn session named after its trace id. Setting `gen_ai.conversation.id` yourself doesn't help either: Maple reads `session.id` first for this framework, and the dual-write already copies it to `gen_ai.conversation.id`.

## Record prompts, responses and tool calls

Content capture is on by default, in two places. The SDK records model inputs and outputs and tool arguments and results on its spans (`trace_include_sensitive_data`, default `True`), and OpenInference copies them onto the OpenTelemetry span. With the dual-write on, each model span carries the content three times: as flattened `llm.input_messages.N.*` keys, as the `input.value` JSON, and as `gen_ai.input.messages`, which is the one Maple renders. Every model span also repeats the whole conversation so far. Maple has no per-attribute limit and accepts requests up to 20 MiB, so this costs bandwidth rather than data.

To keep prompts and outputs out of your traces, turn capture off at the source:

```bash
export OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA=false
```

or per run with `RunConfig(trace_include_sensitive_data=False)`. The session still shows turns, models, tool names, tokens and failures, with an empty transcript. Tool error messages are replaced by `Tool execution failed. Error details are redacted.`

OpenInference's own switches (`TraceConfig(hide_inputs=True, hide_outputs=True)` or `OPENINFERENCE_HIDE_INPUTS` / `OPENINFERENCE_HIDE_OUTPUTS`) redact at the bridge instead, and also empty the transcript, because the GenAI messages are derived from the attributes they hide. For partial redaction, such as masking emails, drop or rewrite attributes in an OpenTelemetry Collector with the `transform` or `redaction` processor.

## Tools, errors, handoffs and agents as tools

Each function tool call is a span named after the tool, with `gen_ai.operation.name` `execute_tool`, `gen_ai.tool.name`, the tool's description, its arguments (with `MapleSpanFixes`) and its result in `gen_ai.tool.call.result`.

A tool that raises is marked failed without extra code. The SDK catches the exception, sends the model `An error occurred while running the tool. Please try again. Error: ...` as the tool result, and records the error on its span. The bridge turns that into status `ERROR` with a message like `Error running tool (non-fatal): {'tool_name': 'fetch_transport_data', 'error': 'transport data service unavailable (503)'}`, and Maple counts the call as failed on the session and on the tool's page. A tool that returns an error string instead of raising counts as a success.

Every agent the run enters gets a span named after it, with `gen_ai.agent.name`, and Maple opens a lane for each agent whose name differs from its caller's. Give every `Agent` a distinct `name`. The spans in between are the bridge's bookkeeping: a `CHAIN` span named after the workflow per `Runner.run`, and a `turn` span per step of the agent loop.

The two multi-agent idioms look different in a trace:

- **Agents as tools** (`agent.as_tool(tool_name=..., tool_description=...)`): the calling agent's tool span contains the whole nested run, with the sub-agent's model and tool calls inside. The tool's arguments and result are the sub-agent's input and output.
- **Handoffs** (`handoffs=[...]`): the model calls a `transfer_to_<agent>` tool, which shows up as a `handoff to <agent>` span with the source and target agent names as input and output. The target agent's span is a sibling of the source agent's, not a child, and the conversation continues there. Maple counts each handoff as a tool call, named `transfer_to_<agent>` by `MapleSpanFixes`.

Parallel sub-agents work if every run is inside one SDK trace and one `using_session` block, so they share a trace id:

```py
import asyncio

from agents import trace

with using_session(conversation_id), trace("amsterdam briefing"):
    weather, budget = await asyncio.gather(
        Runner.run(weather_worker, "Weather in Amsterdam?"),
        Runner.run(budget_worker, "3-day budget for Amsterdam?"),
    )
```

Without the `trace()` block, each `Runner.run` starts its own trace, and the briefing shows up as several turns of the session instead of one.

Tools that need approval (`@function_tool(needs_approval=True)`) show up twice for one approved call. The run that pauses records a tool span with arguments but no result, and the resumed `Runner.run(agent, state)` records the real execution. The resume is its own trace, so the session shows two turns for the approval: the pause and the resumed run, both labelled with the user's message. Wrap the resume in the same `using_session` id or it becomes a separate session.

Two gaps remain. Tool spans have no `gen_ai.tool.call.id`, because the SDK's function span doesn't carry the model's call id, so Maple can't tie a tool span to the exact call in the model's reply. And on the Chat Completions path, model spans have no `gen_ai.response.id`; the Responses API path has one.

## Tokens and cost

Every model span carries input and output tokens from the provider's reply, as `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` plus the OpenInference `llm.token_count.*` originals. On the Responses API, cached input tokens are recorded too, and reasoning tokens as `llm.token_count.completion_details.reasoning`. Streamed Chat Completions calls need `include_usage=True`, as above.

Model spans are named `generation` on the Chat Completions path and `response` on the Responses path. On the Chat Completions path the model is the id you configured (`openai/gpt-4o-mini`). On the Responses path it's the name OpenAI returns, which is usually a dated snapshot such as `gpt-4o-mini-2024-07-18`. The provider is `openai` for both, even for an Anthropic model behind OpenRouter, because the SDK only speaks the OpenAI API. Maple uses the OpenAI token convention for it, where cached tokens are part of the input total, which is also what OpenRouter returns.

The SDK also totals usage per run and per turn, but the bridge doesn't export those totals, so nothing is counted twice.

Maple shows cost only when a span carries one, and neither the SDK nor the bridge records cost. Sessions show as **unpriced**, with token counts. If you route through OpenRouter, its [Broadcast traces](/docs/agent-tracing/openrouter) carry the cost of each call. Chat Completions model spans have no `gen_ai.response.id`, so nest the Broadcast spans under them as described in [Join Broadcast to your own traces](/docs/agent-tracing/openrouter#join-broadcast-to-your-own-traces), or each call is counted twice.

Don't add `openinference-instrumentation-openai` next to the Agents bridge. It patches the `openai` client the SDK calls, so every model call gets a second model span under the `generation` span. The same goes for Logfire's `instrument_openai_agents()`, Langfuse's or Traceloop's Agents instrumentation, and the OpenTelemetry project's `opentelemetry-instrumentation-genai-openai-agents`: pick one.

## Flush spans before the process exits

`BatchSpanProcessor` exports every 5 seconds. The `TracerProvider` registers an `atexit` handler that flushes on a normal interpreter exit, which covers most scripts and CLIs. It doesn't run when the process is killed, calls `os._exit`, or is frozen between serverless invocations, and a notebook never exits. Flush yourself in those cases:

```py
from tracing import provider

try:
    asyncio.run(handle_message("conv-42", "What's the weather in Berlin?"))
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

Call `provider.shutdown()` instead when the process is about to exit. The SDK's own `flush_traces()` doesn't help here: the bridge's `force_flush()` is a no-op, and the spans wait in the OpenTelemetry batch processor.

## Check that it works

Run one conversation of two or three messages through `handle_message` with the same conversation id, including one that uses a tool, then open **Agent Sessions** in Maple. You should see:

- **One session** for the conversation, framework **OpenAI Agents SDK**, with one turn per `Runner.run`. Each turn's trace starts at a span named after your `workflow_name`.
- **The transcript**: the agent's instructions as the system message, your messages, the model's replies (streamed ones included) and its tool calls.
- **Model calls** named `generation` (Chat Completions) or `response` (Responses API), as many as the app made, each with a model and input and output tokens, streamed turns included.
- **Tool calls** named after your tools, such as `get_weather`, with arguments and results. A tool that raised is marked failed.
- **Agents**: one lane per agent name, such as `assistant`, plus sub-agents and handoff targets.
- **Cost**: unpriced.

A second conversation with a different id is a second session. If a turn is missing, check that the process flushed.

## TypeScript (`@openai/agents`)

The same bridge exists for the TypeScript SDK as `@arizeai/openinference-instrumentation-openai-agents`. We ran it with `@openai/agents` 0.18 and bridge 0.2.15, and it works with Maple with three differences. Maple doesn't identify it as the OpenAI Agents SDK, so the framework shows as **Unidentified**. The TypeScript bridge has no GenAI dual-write: the transcript is built from the OpenInference `input.value` and `output.value` JSON, so model replies show as the raw API response, tool calls have no separate arguments and result fields, and there's no `gen_ai.agent.name` for lanes. And the session id has to be `gen_ai.conversation.id`, because Maple doesn't read `session.id` for unidentified OpenInference spans:

```ts
import * as agents from "@openai/agents"
import { context } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { detectResources, envDetector } from "@opentelemetry/resources"
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { setAttributes } from "@arizeai/openinference-core"
import { OpenAIAgentsInstrumentation } from "@arizeai/openinference-instrumentation-openai-agents"

export const provider = new NodeTracerProvider({
	resource: detectResources({ detectors: [envDetector] }), // OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES
	spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())], // OTEL_EXPORTER_OTLP_* variables
})
provider.register()
new OpenAIAgentsInstrumentation({ tracerProvider: provider }).manuallyInstrument(agents)

export function handleMessage(conversationId: string, text: string) {
	const ctx = setAttributes(context.active(), { "gen_ai.conversation.id": conversationId })
	return context.with(ctx, () => agents.run(agent, text, { session }))
}
```

The `envDetector` line matters: the 2.x `NodeTracerProvider` doesn't read `OTEL_SERVICE_NAME` on its own, and every span arrives as `unknown_service:node`. The same environment variables as above configure the exporter. In a script, `await provider.forceFlush()` before exiting.

Models, tokens and tool names come through as in Python. If you need the full session page in TypeScript today, the [provider SDKs guide](/docs/agent-tracing/provider-sdks) shows how to emit the GenAI attributes yourself.

## Troubleshooting

- **No spans at all.** `set_tracing_disabled(True)`, `OPENAI_AGENTS_DISABLE_TRACING=1` or `RunConfig(tracing_disabled=True)` is set somewhere, or `tracing.py` ran after the first `Runner.run`. Remove the switch and import `tracing` first.
- **Exports fail with 404.** `OTLPSpanExporter(endpoint=...)` doesn't append `/v1/traces`. Use `OTEL_EXPORTER_OTLP_ENDPOINT` with the base URL, or pass the full path.
- **Tokens in the list, empty session page.** The GenAI dual-write is off. Pass `TraceConfig(enable_genai_semconv=True)`, or set `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` before `instrument()` runs. Also check the bridge is 2.5 or later: older versions don't record agent names.
- **One session per message.** The run isn't inside `using_session(...)`, or the id changes per request. `group_id` and `SQLiteSession` ids don't reach Maple.
- **Streamed turns have zero tokens.** The model goes through a non-OpenAI base URL without `ModelSettings(include_usage=True)`.
- **Tool arguments show the tool's JSON schema.** `MapleSpanFixes` isn't registered, or it runs after the OpenInference processor. Call `set_trace_processors([MapleSpanFixes()])` before `instrument(..., exclusive_processor=False)`.
- **A streamed turn has tokens but no reply in the transcript.** Same cause: `MapleSpanFixes` isn't first. The streamed Chat Completions reply is otherwise only in `output.value` as a Responses object.
- **More LLM calls than the app made.** `workflow_name` contains `chat` or `completion`, so Maple counts each run's bookkeeping span as a model call. Rename it, for example to `support workflow`.
- **`UserError: Unknown prefix: anthropic`, or OpenRouter gets `gpt-4o-mini` without its prefix.** `Agent(model="vendor/model")` strings go through the SDK's provider prefixes. Pass `OpenAIChatCompletionsModel(model=..., openai_client=...)` instead.
- **`Tracing client error 401` in the logs.** The SDK's default processor is still uploading to OpenAI without a valid key. `set_trace_processors` in `tracing.py` removes it; make sure nothing calls `add_trace_processor` or re-adds `default_processor()` without a key.
- **Every model call appears twice.** `openinference-instrumentation-openai`, Logfire or another Agents instrumentation is also active. Keep one.
- **A multi-agent run is split over several turns.** Parallel `Runner.run` calls outside an SDK `trace()` block each start a trace. Wrap them in one `with trace("...")`.
- **Tool errors show as redacted.** `OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA=false` also redacts error details. That's the privacy switch working.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for every other framework.
- [Tracing in the OpenAI Agents SDK](https://openai.github.io/openai-agents-python/tracing/): the SDK's span types, `trace()`, and the sensitive-data switch.
- [openinference-instrumentation-openai-agents](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-openai-agents): the bridge's source.
- [OpenRouter](/docs/agent-tracing/openrouter) and [LiteLLM](/docs/agent-tracing/litellm): if your models go through either gateway.
