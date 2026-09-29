---
title: "Trace LangChain and LangGraph agents with OpenTelemetry"
description: "Send LangChain and LangGraph runs to Maple with OpenInference, one Agent Session per thread."
group: "AI Agents"
order: 13
navLabel: "LangChain & LangGraph"
icon: "langchain"
---

LangChain and LangGraph report every run through callbacks, and OpenInference's `openinference-instrumentation-langchain` turns those runs into OpenTelemetry spans. Every `invoke()` starts a new trace, so you have to pass the conversation's `thread_id` for Maple to group a chat into one session.

Tested with LangChain 1.4 (`create_agent`), LangGraph 1.2 and `openinference-instrumentation-langchain` 0.1.76 on Python 3.10 or later. LangChain.js isn't covered yet.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-langchain](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-langchain) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for LangChain & LangGraph in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-langchain -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. EU organizations should say EU region.

## Install the instrumentor

```bash
pip install "langchain>=1.4" "langgraph>=1.2" "langchain-openai>=1.6" \
  "openinference-instrumentation-langchain>=0.1.76" "openinference-instrumentation>=0.1.66" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Pin `openinference-instrumentation` explicitly. Older versions lack the GenAI output this setup depends on.

## Point the exporter at Maple

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

EU organizations use `https://ingest.eu.maple.dev`. If you pass `endpoint=` to `OTLPSpanExporter` in code instead, it has to end in `/v1/traces`.

## Initialize tracing

Add a `tracing.py` and import it at the top of your entry point, before the first `invoke()`:

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
# LangGraph's tool node and prompt templates: steps, not tool or model calls
STEP_NAMES = {"tools", "ChatPromptTemplate"}


class AgentSpans(SpanProcessor):
    """Names your agents' spans for Maple (one lane per agent) and keeps graph steps out of the tool and model counts."""

    def on_start(self, span, parent_context=None):
        if span.instrumentation_scope.name != "openinference.instrumentation.langchain":
            return
        if span.name in AGENT_NAMES:
            span.set_attribute("gen_ai.operation.name", "invoke_agent")
            span.set_attribute("gen_ai.agent.name", span.name)
        elif span.name in STEP_NAMES:
            span.set_attribute("gen_ai.operation.name", "invoke_workflow")


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(AgentSpans())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

LangChainInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

`enable_genai_semconv=True` is required. Without it, Maple ignores the `thread_id` and shows the transcript as raw JSON.

`AgentSpans` names your agents so Maple gives each one its own lane. Put every agent's `name=` in `AGENT_NAMES`, sub-agents included. `STEP_NAMES` keeps graph steps out of the tool and model counts; if your tool node has another name containing "tool", like `run_tools`, add it there.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or Sentry), add `AgentSpans()` and the exporter to that provider and pass it to `instrument()`.

## Group a conversation with thread_id

Maple groups turns into a session by `gen_ai.conversation.id`, which the instrumentor fills from the run's `thread_id`. Pass your app's conversation id on every `invoke()`, `stream()` and `Command(resume=...)`:

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

This works with or without a checkpointer. A plain chain (`prompt | model`, no graph) doesn't read `configurable`, so pass `{"metadata": {"thread_id": conversation_id}}` instead. Agents called from inside a tool inherit the caller's id.

Use the id your app stores the chat under. A new UUID per request gives you one session per message.

`stream_usage=True` makes `ChatOpenAI` report tokens on streamed replies when it talks to a server other than api.openai.com, such as a custom `base_url`, vLLM or a gateway.

## Flush in short-lived processes

The SDK flushes on a normal interpreter exit, and long-running servers need nothing. In serverless handlers, notebooks and task workers, flush after each run:

```py
from tracing import provider

try:
    handle_message("conv-42", "What's the weather in Berlin?")
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

On LangGraph Server (`langgraph dev` or self-hosted), import `tracing` at the top of the graph module that `langgraph.json` points to, and set the `OTEL_*` variables in the server's environment. Each server thread already carries its `thread_id`.

## Check that it works

Send two or three messages with the same conversation id, one of them using a tool, then open **Agent Sessions**. Within a minute you should see one session with one turn per `invoke()`, a readable transcript, `ChatOpenAI` model calls with tokens, and tool calls named after your tools.

The framework shows as **Unidentified** and cost as **unpriced**. Both are expected. With a checkpointer, every turn's label repeats the conversation's first message, but the transcript inside each turn is correct.

## Troubleshooting

- **No spans at all.** Import `tracing` before the first `invoke()`, pass `tracer_provider=provider`, and check the logs for `OTLPSpanExporter` errors.
- **One session per message.** The `thread_id` is missing or changes per request (plain chains need it in `metadata`). If it's set, check for `enable_genai_semconv=True`.
- **Streamed replies have no tokens.** Set `stream_usage=True` on `ChatOpenAI`.
- **Every model call appears twice.** Remove `LANGSMITH_OTEL_ENABLED` and any provider instrumentor such as `openinference-instrumentation-openai`. Plain `LANGSMITH_TRACING=true` is fine.
- **Extra tool calls, or a tool shown as an agent.** Add tool nodes to `STEP_NAMES`, and don't put "agent" in tool names.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for every other framework.
- [openinference-instrumentation-langchain](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-langchain): the instrumentor's source.
- [Trace with OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry): LangSmith's OpenTelemetry export.
- [OpenRouter](/docs/agent-tracing/openrouter): if your models go through OpenRouter.
