---
title: "Trace LangChain and LangGraph agents with OpenTelemetry"
description: "Send LangChain and LangGraph runs to Maple as Agent Sessions, one per thread, with a readable transcript, model and tool calls, tokens, failed tools and sub-agent lanes."
group: "AI Agents"
order: 13
navLabel: "LangChain & LangGraph"
icon: "langchain"
---

LangChain and LangGraph report every run through their callback system: each graph node, chat model call and tool call starts and ends a run. Two libraries turn those runs into OpenTelemetry spans. OpenInference's `openinference-instrumentation-langchain` adds its own callback handler, and LangSmith's SDK can export its runs over OTLP instead of to smith.langchain.com. Both work with Maple, and this guide uses OpenInference with its GenAI dual-write, because that's the one that gives Maple a transcript it can render.

The default that goes wrong is the conversation. Every `invoke()` of an agent or graph is a new trace, so a chat of ten messages arrives as ten traces, and nothing links them until you pass a `thread_id`. The same `thread_id` a LangGraph checkpointer already needs is the one Maple groups sessions by. This guide covers Python: LangChain 1.4 (`create_agent`) and LangGraph 1.2 (`StateGraph`) with `openinference-instrumentation-langchain` 0.1.76, on Python 3.10 or later.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-langchain](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-langchain) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for LangChain & LangGraph in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-langchain -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the instrumentor and export to Maple

```bash
pip install "langchain>=1.4" "langgraph>=1.2" "langchain-openai>=1.6" \
  "openinference-instrumentation-langchain>=0.1.76" "openinference-instrumentation>=0.1.66" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Pin `openinference-instrumentation` explicitly. The LangChain instrumentor accepts versions back to 0.1.61, and the GenAI dual-write this guide depends on isn't in the oldest of them.

Point the exporter at Maple with the standard OpenTelemetry variables:

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

EU organizations use `https://ingest.eu.maple.dev`. `OTLPSpanExporter()` with no arguments appends `/v1/traces` to the base URL. If you pass `endpoint=` in code instead, it's used as is and has to end in `/v1/traces`.

Then add a `tracing.py` and import it at the top of your entry point:

```py
# tracing.py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.langchain import LangChainInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

# The name= you gave create_agent(), and graph nodes that act as agents
AGENT_NAMES = {"assistant"}


class AgentSpans(SpanProcessor):
    """Marks your agents' spans as agent invocations, so Maple can name them and give each a lane."""

    def on_start(self, span, parent_context=None):
        if span.instrumentation_scope.name != "openinference.instrumentation.langchain":
            return
        if span.name in AGENT_NAMES:
            span.set_attribute("gen_ai.operation.name", "invoke_agent")
            span.set_attribute("gen_ai.agent.name", span.name)


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(AgentSpans())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

LangChainInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

What each part does:

- **`enable_genai_semconv=True`** makes the instrumentor write `gen_ai.operation.name`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.*`, `gen_ai.tool.*` and `gen_ai.conversation.id` next to its OpenInference attributes when each span ends. Without it, Maple reads the spans as generic OpenInference: the transcript is a raw JSON blob and the `thread_id` is ignored, so every turn is its own session. `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` does the same, as long as it's set before `TraceConfig` is built.
- **`AgentSpans`** fills the one thing the instrumentor leaves out. It names agent spans only by the word "agent": a `create_agent(name="support_agent")` span becomes an agent, `name="assistant"` stays a plain chain, and neither gets `gen_ai.agent.name`, which Maple needs to name agents and open a lane per sub-agent. The processor runs at span start, and the dual-write never overwrites a key that's already set.

The instrumentor hooks LangChain's callback manager, so import order doesn't matter, as long as `instrument()` runs before the first `invoke()`. It traces every LangChain runnable in the process: agents, graphs, chains, chat models, tools and retrievers.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or Sentry), don't create a second one. Add `AgentSpans()` and the OTLP exporter to the existing provider and pass that provider to `instrument()`.

LangSmith keeps working next to this. With `LANGSMITH_TRACING=true` and a LangSmith key, runs still go to smith.langchain.com over LangSmith's own API, and nothing is sent twice to Maple. Don't also set `LANGSMITH_OTEL_ENABLED`, which would add a second copy of every span to your provider (see [the LangSmith exporter](#langsmiths-opentelemetry-exporter-instead) below).

## Group a conversation into one session with thread_id

Maple groups traces into a session by `gen_ai.conversation.id`. The instrumentor sets it on every span of a run from the run's metadata, taking the first of `session_id`, `conversation_id` and `thread_id`. LangGraph copies `configurable` values into that metadata, so the `thread_id` you already pass for a checkpointer is enough:

```py
import tracing  # first, before the first invoke()

from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver

agent = create_agent(
    ChatOpenAI(model="gpt-4o-mini", stream_usage=True),
    tools=[get_weather, calculate],
    name="assistant",
    checkpointer=InMemorySaver(),
)


def handle_message(conversation_id: str, text: str) -> str:
    result = agent.invoke(
        {"messages": [{"role": "user", "content": text}]},
        {"configurable": {"thread_id": conversation_id}},
    )
    return result["messages"][-1].content
```

The checkpointer isn't what sets the session. A graph compiled without one still gets `gen_ai.conversation.id` from `configurable.thread_id`, so a stateless pipeline, like a multi-agent graph run once per request, can pass a `thread_id` only for tracing. A plain LangChain chain (a `prompt | model` pipeline, no graph) doesn't copy `configurable` into the instrumentor's metadata, so pass the id as metadata instead: `chain.invoke(inputs, {"metadata": {"thread_id": conversation_id}})`.

Use your app's own conversation id, the one it stores the chat under. A new UUID per request gives you one session per message again, and a constant puts every user in one session.

If you skip it, every `invoke()` shows up in **Agent Sessions** as its own one-turn session named after its trace id. A human-in-the-loop resume (`Command(resume=...)`) is a new `invoke()` and a new trace too, and the shared `thread_id` is the only thing that puts it back in the same session as the turn it interrupted.

## Record prompts, responses and tool calls

Content capture is on by default. Every chat model span carries the full message list sent to the model and the reply, as `gen_ai.input.messages` and `gen_ai.output.messages` in `{role, parts}` form, and Maple renders them as the session transcript, with the user's message as the turn's label. The system prompt is the first input message. Tool spans carry the tool's result in `gen_ai.tool.call.result`.

With a checkpointer, every model span repeats the thread's whole history, so a long conversation gets large. Maple has no per-attribute limit, and ingest accepts requests up to 20 MiB.

To keep prompts and outputs out of your traces:

```py
config = TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)
```

`hide_inputs` and `hide_outputs` drop the messages and replace `input.value` and `output.value` with `__REDACTED__`. The GenAI attributes are built from the masked values, so they're empty too. The session still shows its turns, model and tool calls, tokens and failures, with an empty transcript. Each switch has an `OPENINFERENCE_HIDE_*` environment variable, and narrower ones exist: `hide_input_text` and `hide_output_text` keep the message structure but redact the text. For pattern-based redaction, use the `redaction` processor in an OpenTelemetry Collector.

## Tools, errors and sub-agents

Each tool call is a span named after the tool, with `gen_ai.operation.name` `execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.description` and the result. The arguments aren't on the tool span, and neither is `gen_ai.tool.call.id`, because the instrumentor doesn't record them there. The arguments are still in the transcript, in the model's tool call just before.

A tool that raises is marked failed without extra code: its span ends with status `ERROR` and the exception as the status message, for example `RuntimeError('transport data service unavailable (503)')`, and Maple counts it on the session and on the tool's page.

What happens to the run next is up to LangChain. `create_agent` re-raises any exception from a tool by default, so one broken tool fails the whole `invoke()`. To hand the error to the model and keep going, add a `wrap_tool_call` middleware:

```py
from langchain.agents.middleware import wrap_tool_call
from langchain_core.messages import ToolMessage


@wrap_tool_call
def tool_errors_to_model(request, handler):
    try:
        return handler(request)
    except Exception as e:
        return ToolMessage(content=f"Tool error: {e}", tool_call_id=request.tool_call["id"], status="error")


agent = create_agent(model, tools=tools, name="assistant", middleware=[tool_errors_to_model])
```

The tool span is still marked failed, because the tool's own run ends with the exception before the middleware catches it. In a `StateGraph` with LangGraph's `ToolNode`, `ToolNode(tools, handle_tool_errors=True)` does the same.

Human-in-the-loop interrupts aren't errors. `interrupt()` and `HumanInTheLoopMiddleware` pause the graph by raising `GraphInterrupt`, and the instrumentor ends that span with status `OK`. The pause ends the turn's trace, and the resume starts a new one, so an approved action shows as two turns in the same session: the request, then the resumed tool call and reply.

Sub-agents need the `AgentSpans` processor from the setup. Add every agent's name to `AGENT_NAMES`, and Maple shows each one in its own lane with its model and tool calls. The common LangChain pattern, a worker agent called from a tool of the orchestrator, looks like this:

```py
AGENT_NAMES = {"orchestrator", "weather_worker"}  # in tracing.py

weather_worker = create_agent(model, tools=[get_weather], name="weather_worker")


@tool
def ask_weather_worker(city: str) -> str:
    """Ask the weather worker for the current weather in a city."""
    result = weather_worker.invoke({"messages": [{"role": "user", "content": f"Weather in {city}?"}]})
    return result["messages"][-1].content


orchestrator = create_agent(model, tools=[ask_weather_worker], name="orchestrator")
```

The worker's run nests under the tool span and inherits the orchestrator's `thread_id`, so it lands in the same trace and session without passing anything. Maple shows the `ask_weather_worker` call as a delegation to `weather_worker`, with the tool's argument and result as the lane's input and output. In a `StateGraph` where each worker is a node, list the node names instead.

Don't put "agent" in a tool's name. The instrumentor names a span of any kind an agent when its name contains the word, so a tool called `ask_weather_agent` loses its tool kind and Maple doesn't count it as a tool call.

Two gaps remain in what Maple shows for LangGraph tools. LangGraph runs tools inside a node, named `tools` in `create_agent` and wherever you add a `ToolNode` under that name, and Maple currently counts that node's span as an extra, unnamed tool call, because its name contains "tool". So a turn with one tool call shows two. The real tool calls are the ones with a name. The missing `gen_ai.tool.call.id` means Maple matches tool spans to the model's calls by name, which works unless one reply calls the same tool twice.

## Tokens and cost

Every chat model span carries input and output tokens from LangChain's `usage_metadata`, as `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` next to the OpenInference `llm.token_count.*` originals. The model is the one you configured, in `gen_ai.request.model`, and the provider comes from the LangChain integration: `ChatOpenAI` is `openai`, even for an Anthropic model behind OpenRouter or another OpenAI-compatible gateway.

Streaming is where tokens go missing. `ChatOpenAI` only asks for usage on streamed responses (`stream_options.include_usage`) when it talks to api.openai.com. With a `base_url`, or `OPENAI_BASE_URL` set, it doesn't, and every streamed call arrives with no token counts. Set `stream_usage=True` on the model, as in the example above.

Maple shows cost only when a span carries one, and neither LangChain nor the instrumentor records cost. Sessions show as **unpriced**, with token counts.

A `ChatPromptTemplate` in a chain produces a span named `ChatPromptTemplate`, and Maple currently counts it as a model call because the name contains "chat". It has no model or tokens, so totals are right, but the call count is one too high per template. `create_agent` and LangGraph nodes that call a model directly don't use templates.

Don't add `openinference-instrumentation-openai`, `-anthropic` or OpenLLMetry's LangChain instrumentor next to this one. Each wraps the same model request again, and every call gets a second model span with its own tokens.

## Flush spans before the process exits

The instrumentor ends each span when the run's callback fires, and `BatchSpanProcessor` exports every 5 seconds. The `TracerProvider` registers an `atexit` handler that flushes on a normal interpreter exit, which covers most scripts and CLIs. It doesn't run when the process is killed, calls `os._exit`, or is frozen between serverless invocations, and a notebook never exits. Flush yourself in those cases:

```py
from tracing import provider

try:
    handle_message("conv-42", "What's the weather in Berlin?")
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

Call `provider.shutdown()` instead when the process is about to exit and won't trace anything else.

Context survives LangGraph's parallel nodes, `ainvoke`, and agents called from inside tools on Python 3.11 and later. On Python 3.10, asyncio doesn't carry context into tasks, so pass the node's `config` to every nested `ainvoke()` or its runs start new traces. If you run LangChain code in your own thread pool, use `ContextThreadPoolExecutor` from `langchain_core.runnables.config` instead of the standard library's.

## LangGraph Server deployments

On LangGraph's Agent Server (`langgraph dev` or a self-hosted server), the server imports the module that defines your graph, the one `langgraph.json` points to. Import `tracing` at the top of that module and set the `OTEL_*` variables in the server's environment (the `env` file in `langgraph.json`, or the container). The server is long-running, so `BatchSpanProcessor` exports on its own schedule and no flush is needed.

Every run on a server thread already carries that thread's id as `configurable.thread_id`, so each LangGraph thread becomes one Maple session with no extra code.

## LangSmith's OpenTelemetry exporter instead

LangSmith's SDK can write its runs as OTLP spans (`LANGSMITH_OTEL_ENABLED`). Maple recognizes those spans and labels them **LangChain**, and reads the session from `langsmith.metadata.thread_id`, the same `configurable.thread_id`. It's the only path that shows the framework name, and it records `gen_ai.tool.call.id`. It gives Maple less to work with everywhere else:

- The prompt and completion are LangChain's serialized objects (`{"lc":1,"type":"constructor",...}`) in `gen_ai.prompt` and `gen_ai.completion`, so the transcript is one raw JSON blob per model call, with no turn labels.
- An interrupt marks the interrupted node's span `ERROR`, with `GraphInterrupt(...)` as an `exception` event, so human-in-the-loop pauses read as failures.
- Middleware wrappers such as `HumanInTheLoopMiddleware.wrap_tool_call` get their own spans, and Maple counts them as extra tool calls. A failing tool's error passes through the ones inside your error handler, so one failure counts more than once.
- Prompt templates get `gen_ai.operation.name` `chat`, and `gen_ai.system` is guessed from the model name: `anthropic/claude-haiku-4.5` through OpenRouter reads as `anthropic`.
- There are no agent names. `create_agent`'s name is only in `langsmith.metadata.lc_agent_name`, which Maple doesn't read, and the `AgentSpans` trick doesn't work because LangSmith overwrites `gen_ai.operation.name` after the span starts.

If you want it anyway, set the variables and the provider before anything imports LangChain. LangSmith looks for a global provider when its client is created, and if there isn't one it builds its own, pointed at smith.langchain.com:

```py
import os

os.environ["LANGSMITH_TRACING"] = "true"
os.environ["LANGSMITH_OTEL_ENABLED"] = "true"
os.environ["LANGSMITH_OTEL_ONLY"] = "true"  # OTLP only, no LangSmith account or key needed

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

# Only now import langchain, langgraph and your agents
```

Install `langsmith[otel]>=0.14`. Flushing takes two steps, because LangSmith converts runs to spans on a background thread and the provider has nothing to export until it's done. `provider.force_flush()` on its own exports nothing:

```py
from langchain_core.tracers.langchain import wait_for_all_tracers

wait_for_all_tracers()
provider.force_flush()
```

Don't combine it with the OpenInference instrumentor; you'd get every run twice.

## LangChain.js and LangGraph.js

This guide doesn't cover JavaScript yet. LangSmith's OpenTelemetry mode in JS is experimental and its `initializeOTEL()` setup is deprecated, and the JS OpenInference instrumentor has no GenAI dual-write, so Maple ignores its `session.id` and shows one session per trace. For a TypeScript agent today, see [Trace your AI agent](/docs/agent-tracing) for the frameworks that are covered.

## Check that it works

Run one conversation of two or three messages through `handle_message` with the same conversation id, including one that uses a tool, then open **Agent Sessions** in Maple. Spans usually show up within a minute. You should see:

- **One session** for the conversation, with one turn per `invoke()`. A second conversation with a different id is a second session.
- **Framework: Unidentified.** Maple recognizes LangChain by LangSmith's exporter, and the OpenInference spans read as generic GenAI spans. Everything else on the session page works.
- **The transcript**: your messages as turn labels, the model's replies, and its tool calls.
- **Agents**: `assistant`, plus one lane per sub-agent in `AGENT_NAMES`. Each turn's trace starts at the agent span, with `model` and `tools` node spans below it.
- **Model calls** named `ChatOpenAI` (or `ChatAnthropic`, and so on), each with a model, input and output tokens, including streamed ones.
- **Tool calls** named after your tools, like `get_weather`, with results, and a failing tool marked failed with its message.
- **Cost**: unpriced.

If a turn is missing, check that the process flushed.

## Troubleshooting

- **No spans at all.** `instrument()` never ran, or ran with a different provider than the one exporting. Import `tracing` first, pass `tracer_provider=provider`, and look for `OTLPSpanExporter` errors in the logs.
- **Exports fail with 404.** `OTLPSpanExporter(endpoint=...)` doesn't append `/v1/traces`. Use `OTEL_EXPORTER_OTLP_ENDPOINT` with the base URL, or pass the full path.
- **One session per message.** No `thread_id` reached the run, or it changes per request. Pass `{"configurable": {"thread_id": conversation_id}}` to every `invoke()`, `stream()` and resume, or `{"metadata": {"thread_id": ...}}` for plain chains.
- **Sessions work but the session page is a JSON blob, or tokens show only in the list.** The GenAI dual-write is off. Pass `TraceConfig(enable_genai_semconv=True)`.
- **Streamed replies have no tokens.** `ChatOpenAI` with a custom `base_url` doesn't request streamed usage. Set `stream_usage=True`.
- **One failing tool ends the whole run.** `create_agent` re-raises tool exceptions. Add the `wrap_tool_call` middleware, or `handle_tool_errors=True` on your `ToolNode`.
- **A tool shows up as an agent, not a tool call.** Its name contains "agent". Rename it.
- **Twice as many tool calls as the agent made.** The `tools` node span is counted as a tool call, as described above. It's a known gap in how Maple classifies LangGraph node spans.
- **Every model call appears twice.** A provider instrumentor or `LANGSMITH_OTEL_ENABLED` is also active. Keep one.
- **No lanes for sub-agents.** Their names aren't in `AGENT_NAMES`, or two agents share a name.
- **Turns split into several traces on Python 3.10.** Pass `config` to nested async calls, or upgrade to Python 3.11.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for every other framework.
- [openinference-instrumentation-langchain](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-langchain): the instrumentor's source.
- [Trace with OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry): LangSmith's OpenTelemetry export.
- [OpenRouter](/docs/agent-tracing/openrouter): if your models go through OpenRouter.
