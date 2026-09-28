---
title: "Trace LlamaIndex agents with OpenTelemetry"
description: "Send LlamaIndex FunctionAgent, AgentWorkflow and Workflow runs to Maple as Agent Sessions, one per conversation, with the transcript, model and tool calls, tokens, failed tools and sub-agent lanes."
group: "AI Agents"
order: 23
navLabel: "LlamaIndex"
icon: "llamaindex"
---

LlamaIndex reports what it does through its own instrumentation dispatcher: every agent run, workflow step, model call and tool call opens a dispatcher span and fires events. Two packages turn those into OpenTelemetry spans. LlamaIndex's own `llama-index-observability-otel` copies the span tree but puts the payload in span events, and it loses the model's reply and token usage on every streamed call. OpenInference's `openinference-instrumentation-llama-index` writes model, tokens, messages and tool results as span attributes, which is what Maple reads. Use the OpenInference one.

It needs four adjustments before a chat looks right in Maple. The instrumentor writes OpenInference attribute names unless you turn on its GenAI output, it never sets a conversation id, it doesn't record agent names, and it opens two or three "LLM" spans for every model call, so Maple would count each call two or three times. This guide covers all four for llama-index-core 0.14.25 with `openinference-instrumentation-llama-index` 4.5.2 on Python 3.10 or later, using `FunctionAgent`, `AgentWorkflow` and custom `Workflow` classes.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-llamaindex](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-llamaindex) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for LlamaIndex in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-llamaindex -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Why not llama-index-observability-otel

LlamaIndex's docs point to `LlamaIndexOpenTelemetry` from `llama-index-observability-otel` (0.7.0). It's a bridge: it mirrors dispatcher spans into OpenTelemetry spans and dispatcher events into span events. In Maple that gives you structure and nothing else:

- **No model, tokens or transcript.** Model settings and the prompt sit inside an `LLMChatStartEvent` span event, and Maple never reads span events. The matching end event, with the reply and the usage, is dropped because the streamed `astream_chat` span closes before the stream is consumed.
- **Every call appears twice.** Each model call has two nested `OpenRouter.astream_chat` spans (or `OpenAI.astream_chat`, after your model class).
- **It ignores the standard exporter variables.** `OTEL_EXPORTER_OTLP_ENDPOINT` does nothing; the default exporter is `ConsoleSpanExporter`, so without an explicit `span_exporter=` everything goes to stdout.

If you already run it and only want sessions, `instrument_tags({"gen_ai.conversation.id": conversation_id})` around `agent.run()` groups the traces; dotted tag keys become span attributes verbatim. For transcripts and tokens, switch to OpenInference. Don't run both, or every span exists twice.

## Install the instrumentor and export to Maple

```bash
pip install "llama-index-core>=0.14.25" "openinference-instrumentation-llama-index>=4.5.2" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Add your model package (`llama-index-llms-openai`, `llama-index-llms-anthropic`, `llama-index-llms-openrouter`, ...) as usual. The instrumentor requires llama-index-core 0.14.19 or later. On anything older it logs a dependency conflict and instruments nothing.

Point the exporter at Maple with the standard OpenTelemetry variables:

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

EU organizations use `https://ingest.eu.maple.dev`. Set the base URL: `OTLPSpanExporter()` with no arguments appends `/v1/traces`. If you pass `endpoint=` in code instead, it's used as is and has to end in `/v1/traces`.

Then add a `tracing.py` and import it at the top of your entry point, before the first `agent.run()`:

```py
# tracing.py
from llama_index.core.instrumentation.dispatcher import active_instrument_tags
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.llama_index import LlamaIndexInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

LLM_METHODS = (".chat", ".achat", ".stream_chat", ".astream_chat",
               ".complete", ".acomplete", ".stream_complete", ".astream_complete")


class LlamaIndexForMaple(SpanProcessor):
    """Sits in front of the exporter: one span per model call, agent names, no false HITL failures."""

    def __init__(self, exporter_processor: SpanProcessor):
        self._next = exporter_processor
        self._open_llm_spans = {}

    def on_start(self, span, parent_context=None):
        # instrument_tags({"gen_ai.agent.name": ...}) becomes an attribute, so sub-agents get lanes
        agent_name = active_instrument_tags.get().get("gen_ai.agent.name")
        if agent_name:
            span.set_attribute("gen_ai.agent.name", agent_name)
        if span.name.endswith(LLM_METHODS):
            self._open_llm_spans[span.context.span_id] = span
        self._next.on_start(span, parent_context)

    def on_end(self, span):
        self._open_llm_spans.pop(span.context.span_id, None)
        if span.name.endswith("._prepare_chat_with_tools"):
            return  # builds the request; never calls the model
        if (span.status.description or "").startswith("WaitingForEvent"):
            return  # ctx.wait_for_event() suspends the tool and replays it later; not a failure
        outer = self._open_llm_spans.get(span.parent.span_id) if span.parent else None
        if outer is not None and outer.name == span.name:
            outer.set_attributes(span.attributes)  # the inner twin holds the messages and usage
            return
        self._next.on_end(span)

    def shutdown(self):
        self._next.shutdown()

    def force_flush(self, timeout_millis=30000):
        return self._next.force_flush(timeout_millis)


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(LlamaIndexForMaple(BatchSpanProcessor(OTLPSpanExporter())))
trace.set_tracer_provider(provider)

LlamaIndexInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

What each part does:

- **`enable_genai_semconv=True`** makes the instrumentor write `gen_ai.operation.name`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.*`, `gen_ai.tool.*` and `gen_ai.conversation.id` next to its OpenInference attributes when each span ends. Without it, Maple can count tokens but the session page has no transcript. `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` does the same, but only if it's set before `TraceConfig` is built.
- **`LlamaIndexForMaple`** wraps the exporting processor and fixes what the instrumentor gets wrong for LlamaIndex. The next sections explain each fix.
- **One `TracerProvider`.** If the app already has one (from `opentelemetry-instrument`, Logfire or Sentry), don't create a second. Add `LlamaIndexForMaple(BatchSpanProcessor(OTLPSpanExporter()))` to the existing provider and pass that provider to `instrument()`.

### Why each model call opens three spans

LlamaIndex's dispatcher wraps every method that implements an abstract base method, and the instrumentor marks every span on an LLM object as kind `LLM`. A single `FunctionAgent` step with an OpenAI-compatible model (`OpenRouter`, `OpenAILike` and the others built on it) produces:

```text
BaseWorkflowAgent.run_agent_step
├── OpenRouter._prepare_chat_with_tools   kind LLM, builds the request, ~1 ms
└── OpenRouter.astream_chat               kind LLM, OpenAILike's override
    └── OpenRouter.astream_chat           kind LLM, OpenAI's method: messages, usage
```

Maple counts every inference span without usage from a reporting ancestor as a model call, so this one call would count three times. A class that implements the call itself, such as `OpenAI`, produces two spans, the helper and the call. Tokens are not doubled, since only the innermost span carries usage.

`LlamaIndexForMaple` drops the `_prepare_chat_with_tools` helper, copies the inner span's attributes onto its same-named parent and drops the inner span, leaving one `OpenRouter.astream_chat` span per call with the messages and usage. It only merges spans with identical names that nest directly, so a chat engine's `CondensePlusContextChatEngine.chat` calling `OpenAI.chat` is left alone.

## Group a conversation into one session

LlamaIndex keeps a conversation in a workflow `Context` (`Context(agent)`, or the chat memory you pass), and every `agent.run()` starts a new root span and a new trace. Nothing in those spans says which conversation they belong to, so without a conversation id every message becomes its own one-turn session in Maple, named after its trace id.

Wrap each `agent.run()` call in OpenInference's `using_session` with your app's conversation id:

```py
from llama_index.core.agent.workflow import AgentStream, FunctionAgent
from llama_index.core.instrumentation.dispatcher import instrument_tags
from llama_index.core.workflow import Context
from openinference.instrumentation import using_session

agent = FunctionAgent(name="assistant", llm=llm, tools=[get_weather, calculate],
                      system_prompt="You are a helpful assistant.")
contexts: dict[str, Context] = {}


async def handle_message(conversation_id: str, text: str):
    if conversation_id not in contexts:
        contexts[conversation_id] = Context(agent)
    ctx = contexts[conversation_id]
    with using_session(conversation_id), instrument_tags({"gen_ai.agent.name": agent.name}):
        handler = agent.run(user_msg=text, ctx=ctx)
    async for event in handler.stream_events():
        if isinstance(event, AgentStream):
            yield event.delta
    await handler
```

The instrumentor copies the id onto every span it creates as `session.id`, and the GenAI output repeats it as `gen_ai.conversation.id`, the key Maple reads for these spans. `using_session` sets a contextvar, and `agent.run()` starts the workflow's tasks immediately, so the id reaches every step, tool and model call of the run, including parallel workflow steps and the replay after a human-in-the-loop approval. Only the `agent.run()` call has to be inside the `with`; consuming the stream outside it is fine, which keeps the context manager out of your streaming generator.

Use the id your app already stores the chat under. A new UUID per request gives you one session per message again, and a constant puts every user in one session. Keep one `Context` per conversation too: a shared `Context` shares the chat memory, and the traces would look like one long conversation.

`llama_index.core.workflow.Context` is not a session id: it never reaches a span. Neither is the per-run `llamaindex.run_id` of the native package.

## Record prompts, responses and tool calls

Content capture is on by default. Every model span carries the full message list sent to the model as `gen_ai.input.messages` (system prompt, chat history, tool results) and the reply as `gen_ai.output.messages`, including tool call parts with their ids and arguments. Maple renders these as the session transcript, with the last user message as the turn label.

The input list grows with the conversation: with a persistent `Context`, every model span repeats the whole chat so far. Maple has no per-attribute limit, and ingest accepts requests up to 20 MiB.

To keep prompts and outputs out of your traces:

```py
config = TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)
```

`hide_inputs` drops the input messages and replaces `input.value` with `__REDACTED__`; `hide_outputs` does the same for outputs and tool results. The session still shows turns, model and tool calls, tokens and failures, with an empty transcript. `hide_input_text` and `hide_output_text` keep the message structure and redact only the text. Each switch also has an `OPENINFERENCE_HIDE_*` environment variable. For pattern-based redaction (emails, card numbers), use the `redaction` processor in an OpenTelemetry Collector.

## Tools, errors and sub-agents

Each tool call is a `FunctionTool.acall` span of kind `TOOL`, with `gen_ai.operation.name` `execute_tool`, the tool's name in `gen_ai.tool.name`, its description, and its return value (LlamaIndex's `ToolOutput`, with `raw_input` and `raw_output`) in `gen_ai.tool.call.result`. It sits under a `BaseWorkflowAgent.call_tool` step span.

A tool that raises is marked failed without extra code. `FunctionTool.acall` ends with status `ERROR` and the exception as the status message, for example `RuntimeError: transport data service unavailable (503)`, and Maple counts it on the session and on the tool's page. The `call_tool` step stays `OK`, because `FunctionAgent` catches the error and hands it to the model as the tool result. A tool that returns an error string instead of raising looks like a success.

Two gaps remain on tool spans. `gen_ai.tool.call.arguments` holds the tool's parameter schema, not the call's arguments, because the GenAI output copies OpenInference's `tool.parameters` there; the real arguments are in the model's tool call part in the transcript and in `raw_input` inside the result. And tool spans carry no `gen_ai.tool.call.id`, so Maple can't link a tool span to the exact call in the model's reply.

Human-in-the-loop tools that call `ctx.wait_for_event(...)` run twice: the first call raises LlamaIndex's `WaitingForEvent` to suspend the step, and the step replays once the `HumanResponseEvent` arrives. The instrumentor records the first attempt as a failed tool call. `LlamaIndexForMaple` drops it, so an approved call shows as one successful tool call.

### Name your agents

The instrumentor doesn't record which agent a span belongs to, and without `gen_ai.agent.name` Maple has no agent facet and no lanes. `LlamaIndexForMaple` copies a `gen_ai.agent.name` tag from LlamaIndex's `instrument_tags` onto every span started inside it. Put the tag around each agent's `run()`:

```py
from llama_index.core.workflow import Context, Event, StartEvent, StopEvent, Workflow, step


class WeatherTask(Event):
    city: str


class TransportTask(Event):
    city: str


class WorkerDone(Event):
    text: str


async def run_agent(agent: FunctionAgent, message: str) -> str:
    with instrument_tags({"gen_ai.agent.name": agent.name}):
        handler = agent.run(user_msg=message)
    return str(await handler)


class Briefing(Workflow):
    @step
    async def plan(self, ctx: Context, ev: StartEvent) -> WeatherTask | TransportTask | None:
        ctx.send_event(WeatherTask(city=ev.city))
        ctx.send_event(TransportTask(city=ev.city))

    @step(num_workers=2)
    async def weather(self, ev: WeatherTask) -> WorkerDone:
        return WorkerDone(text=await run_agent(weather_worker, f"Weather in {ev.city}?"))

    @step(num_workers=2)
    async def transport(self, ev: TransportTask) -> WorkerDone:
        return WorkerDone(text=await run_agent(transport_worker, f"Transport in {ev.city}?"))

    @step
    async def summarize(self, ctx: Context, ev: WorkerDone) -> StopEvent | None:
        done = ctx.collect_events(ev, [WorkerDone, WorkerDone])
        if done is None:
            return None
        return StopEvent(result=await run_agent(summary_agent, "\n\n".join(d.text for d in done)))
```

Run the whole workflow inside `using_session(conversation_id)`. The workflow is one trace: `Briefing.run` at the root, one span per step, and each worker's `FunctionAgent.run` under its step with its own `gen_ai.agent.name`. Maple opens a lane for every agent span whose name differs from its caller's. Parallel steps (`num_workers`) stay in the same trace and keep the session and agent tags.

The same works for agents called as tools: put `instrument_tags` inside the tool function around the sub-agent's `run()`. The tool span with one `FunctionAgent.run` child then shows as a delegation, with the tool's arguments and result as the lane's input and output.

`AgentWorkflow` handoffs are different. The whole multi-agent run is one `AgentWorkflow.run` span, and LlamaIndex switches the active agent inside it without a span per agent, so there is nothing to tag. Handoffs show as one agent in Maple. If you need lanes, run each agent as its own `FunctionAgent.run()` from a workflow step or a tool, as above.

## Tokens and cost

The model span carries input and output tokens from the provider's reply as `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus cached input tokens when the provider reports them, next to the OpenInference `llm.token_count.*` originals. The model is the one you configured (`gen_ai.request.model`, for example `openai/gpt-4o-mini`); the instrumentor doesn't record the model name the provider returns, or a response id.

`FunctionAgent` streams every model call by default, even when you never read `AgentStream` events, and usage on a stream arrives only in the last chunk. OpenRouter always sends it. OpenAI's API sends it only when asked, so pass `stream_options` on OpenAI-compatible models:

```py
from llama_index.llms.openai import OpenAI

llm = OpenAI(model="gpt-4o-mini", additional_kwargs={"stream_options": {"include_usage": True}})
```

LlamaIndex strips the option from non-streaming requests, so it's safe to set once.

The provider comes from the model class: `OpenRouter` and every `OpenAILike` model report `openai`, even for an Anthropic model behind OpenRouter.

Maple shows cost only when a span carries one, and neither LlamaIndex nor the instrumentor records cost. Sessions show as **unpriced**, with token counts. If you route through OpenRouter, its [Broadcast traces](/docs/agent-tracing/openrouter) carry the cost of each call, and Maple joins them to the same session.

Don't add `openinference-instrumentation-openai` (or another provider instrumentor) next to the LlamaIndex one. It wraps the same HTTP call and gives every model call a second span with its own usage.

## Flush spans before the process exits

`BatchSpanProcessor` exports every 5 seconds, and the `TracerProvider` flushes on a normal interpreter exit. That doesn't happen when the process is killed, calls `os._exit`, or is frozen between serverless invocations, and a notebook never exits. Flush yourself in those cases:

```py
from tracing import provider

try:
    result = await workflow.run(city="Amsterdam")
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

Call `provider.shutdown()` instead when the process is about to exit and won't trace anything else.

## Check that it works

Run one conversation of two or three messages through `handle_message` with the same conversation id, including one that uses a tool, then open **Agent Sessions** in Maple. You should see:

- **One session** for the conversation, with one turn per `agent.run()`. Each turn's trace starts at `FunctionAgent.run` (or `AgentWorkflow.run`, or your workflow class's `.run`).
- **Framework: Unidentified.** Maple doesn't recognise the OpenInference LlamaIndex scope as LlamaIndex yet, so the session is filed under the generic GenAI bucket. Everything else on this list still works.
- **The transcript**: your messages, the model's replies and the tool calls it made.
- **Model calls** named after your model class and method, for example `OpenRouter.astream_chat` or `OpenAI.achat`, one per call, each with a model and input and output tokens.
- **Tool calls** named `FunctionTool.acall`, with the tool's name and result.
- **Agents**: `assistant`, plus one lane per tagged sub-agent.
- **Cost**: unpriced.

A second conversation with a different id is a second session. If a turn is missing, check that the process flushed.

## Troubleshooting

- **No spans at all.** `instrument()` never ran, or llama-index-core is older than 0.14.19 and the instrumentor skipped itself (look for `DependencyConflict` in the logs). Import `tracing` first in the entry point and look for an `OTLPSpanExporter` error in the logs.
- **Spans print to the console instead of reaching Maple.** You're running `LlamaIndexOpenTelemetry` without `span_exporter=`. Switch to the OpenInference setup above.
- **Exports fail with 404.** `OTLPSpanExporter(endpoint=...)` doesn't append `/v1/traces`. Use `OTEL_EXPORTER_OTLP_ENDPOINT` with the base URL, or pass the full path.
- **Tokens in the list, empty session page.** The GenAI output is off. Pass `TraceConfig(enable_genai_semconv=True)`.
- **One session per message.** `agent.run()` isn't inside `using_session(...)`, or the id changes per request. `Context` and `llamaindex.run_id` are not session ids.
- **Each model call counted two or three times.** `LlamaIndexForMaple` isn't in front of the exporter. Add the exporter through it, not directly with `add_span_processor(BatchSpanProcessor(...))`.
- **Model calls take 1 ms.** Streamed model spans end when LlamaIndex hands back the stream, not when the last token arrives, so their duration isn't the model's latency. The enclosing `BaseWorkflowAgent.run_agent_step` span has the real time. If you don't stream tokens to users, `FunctionAgent(..., streaming=False)` records model spans with their full duration.
- **No tokens on streamed calls.** The provider didn't send usage on the stream. Add `stream_options={"include_usage": True}` through `additional_kwargs`.
- **Tool arguments show the tool's schema.** A known gap in the instrumentor's GenAI output; see [Tools, errors and sub-agents](#tools-errors-and-sub-agents).
- **An approved tool call shows as failed first.** `wait_for_event()` suspends the tool by raising `WaitingForEvent`. `LlamaIndexForMaple` drops that attempt; check it's installed.
- **No lanes, no agent names.** Wrap each agent's `run()` in `instrument_tags({"gen_ai.agent.name": agent.name})`, with `LlamaIndexForMaple` installed. `AgentWorkflow` handoffs can't be split into lanes.
- **Tool calling silently doesn't happen.** `OpenAILike` and `OpenRouter` default to `is_function_calling_model=False`, so the agent falls back to prose and emits no tool spans. Pass `is_function_calling_model=True`.
- **Streaming query engine spans land in separate traces.** llama-index-core 0.14.25 defers the model call of a `StreamingResponse` until you consume it, after the query span has ended. OpenInference is fixing this in [PR #3841](https://github.com/Arize-ai/openinference/pull/3841); until it ships, pin `llama-index-core<0.14.25` if you trace streaming query engines. Agents are not affected.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for every other framework.
- [LlamaIndex observability](https://developers.llamaindex.ai/python/framework/module_guides/observability/): LlamaIndex's own page on tracing.
- [openinference-instrumentation-llama-index](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-llama-index): the instrumentor's source and `TraceConfig` options.
- [OpenRouter](/docs/agent-tracing/openrouter): cost per call if your models go through OpenRouter.
