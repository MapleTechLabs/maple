---
title: "Trace LangChain and LangGraph agents with OpenTelemetry"
description: "Send LangChain and LangGraph runs to Maple with OpenInference, one Agent Session per thread."
group: "AI Agents"
order: 13
navLabel: "LangChain & LangGraph"
icon: "langchain"
---

OpenInference's `openinference-instrumentation-langchain` sends LangChain and LangGraph runs to Maple. Pass the conversation's `thread_id` on every call so a chat becomes one session.

This guide covers Python 3.10 or later. LangChain.js isn't covered yet.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-langchain](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-langchain) skill and follows it.

```text
Set up Maple agent tracing for LangChain & LangGraph in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-langchain -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the instrumentor

```bash
pip install "langchain>=1.4" "langgraph>=1.2" "langchain-openai>=1.6" \
  "openinference-instrumentation-langchain>=0.1.76" "openinference-instrumentation>=0.1.66" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Keep the explicit `openinference-instrumentation` pin. Older versions don't work with this setup.

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
# Your tool node and prompt templates
STEP_NAMES = {"tools", "ChatPromptTemplate"}


class AgentSpans(SpanProcessor):
    def on_start(self, span, parent_context=None):
        if span.instrumentation_scope.name != "openinference.instrumentation.langchain":
            return
        if span.name in AGENT_NAMES:
            span.set_attribute("gen_ai.operation.name", "invoke_agent")
            span.set_attribute("gen_ai.agent.name", span.name)
        elif span.name in STEP_NAMES:
            span.set_attribute("gen_ai.operation.name", "invoke_workflow")


provider = TracerProvider()
provider.add_span_processor(AgentSpans())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

LangChainInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

Keep `enable_genai_semconv=True`. Without it, sessions don't group and the transcript shows as raw JSON.

Put every agent's `name=` in `AGENT_NAMES`, sub-agents included, so each gets its own lane. If your tool node isn't called `tools`, add its name to `STEP_NAMES`.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or Sentry), add `AgentSpans()` and the exporter to it and pass it to `instrument()`.

## Group a conversation with thread_id

Pass your app's conversation id as `thread_id` on every `invoke()`, `stream()` and `Command(resume=...)`:

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

Use the id your app stores the chat under. A new UUID per request gives you one session per message. A plain chain (`prompt | model`, no graph) ignores `configurable`, so pass `{"metadata": {"thread_id": conversation_id}}` instead.

Keep `stream_usage=True` if `ChatOpenAI` uses a custom `base_url`, vLLM or a gateway. Without it, streamed replies have no tokens.

## Flush in short-lived processes

Long-running servers need nothing. In serverless handlers, notebooks and task workers, flush after each run:

```py
from tracing import provider

try:
    handle_message("conv-42", "What's the weather in Berlin?")
finally:
    provider.force_flush()
```

On LangGraph Server (`langgraph dev` or self-hosted), import `tracing` at the top of the graph module that `langgraph.json` points to, and set the `OTEL_*` variables in the server's environment. Server threads group into sessions without extra code.

## Check that it works

Send two or three messages with the same conversation id, one of them using a tool, then open **Agent Sessions**. Within a minute you should see one session with one turn per `invoke()`, a readable transcript, `ChatOpenAI` model calls with tokens, and tool calls named after your tools.

The framework shows as **Unidentified** and cost as **unpriced**, which is expected. With a checkpointer, every turn is labeled with the conversation's first message. The transcript inside each turn is still correct.

## Troubleshooting

- **No spans at all.** Import `tracing` before the first `invoke()`, pass `tracer_provider=provider`, and check the logs for `OTLPSpanExporter` errors.
- **One session per message.** The `thread_id` is missing or changes per request (plain chains need it in `metadata`). If it's set, check for `enable_genai_semconv=True`.
- **Streamed replies have no tokens.** Set `stream_usage=True` on `ChatOpenAI`.
- **Every model call appears twice.** Remove `LANGSMITH_OTEL_ENABLED` and any provider instrumentor such as `openinference-instrumentation-openai`. Plain `LANGSMITH_TRACING=true` is fine.
- **Extra tool calls, or a tool shown as an agent.** Add tool nodes to `STEP_NAMES`, and don't put "agent" in tool names.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [OpenRouter](/docs/agent-tracing/openrouter): if your models go through OpenRouter.
