---
title: "Trace LlamaIndex agents with OpenTelemetry"
description: "Send LlamaIndex agent and workflow runs to Maple with OpenInference, one Agent Session per conversation."
group: "AI Agents"
order: 23
navLabel: "LlamaIndex"
icon: "llamaindex"
---

OpenInference's `openinference-instrumentation-llama-index` sends LlamaIndex agents and workflows to Maple. You add a small span processor and wrap every `agent.run()` in a conversation id so a chat becomes one session.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-llamaindex](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-llamaindex) skill and follows it.

```text
Set up Maple agent tracing for LlamaIndex in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-llamaindex -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the instrumentor

```bash
pip install "llama-index-core>=0.14.25" "openinference-instrumentation-llama-index>=4.5.2" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Add your model package (`llama-index-llms-openai`, `llama-index-llms-openrouter`, ...) as usual.

If the app uses LlamaIndex's own `llama-index-observability-otel`, remove it. Maple can't read its transcripts, and running both doubles every span.

## Point the exporter at Maple

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

EU organizations use `https://ingest.eu.maple.dev`. If you pass `endpoint=` to `OTLPSpanExporter` in code instead, it has to end in `/v1/traces`.

## Initialize tracing

Add a `tracing.py` and import it at the top of your entry point, before the first `agent.run()`:

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
    def __init__(self, exporter_processor: SpanProcessor):
        self._next = exporter_processor
        self._open_llm_spans = {}

    def on_start(self, span, parent_context=None):
        agent_name = active_instrument_tags.get().get("gen_ai.agent.name")
        if agent_name:
            span.set_attribute("gen_ai.agent.name", agent_name)
        if span.name.endswith((".call_tool", ".aggregate_tool_results")):
            span.set_attribute("gen_ai.operation.name", "invoke_workflow")
        if span.name.endswith(LLM_METHODS):
            self._open_llm_spans[span.context.span_id] = span
        self._next.on_start(span, parent_context)

    def on_end(self, span):
        self._open_llm_spans.pop(span.context.span_id, None)
        if span.name.endswith("._prepare_chat_with_tools"):
            return
        if (span.status.description or "").startswith("WaitingForEvent"):
            return
        outer = self._open_llm_spans.get(span.parent.span_id) if span.parent else None
        if outer is not None and outer.name == span.name:
            outer.set_attributes(span.attributes)
            return
        self._next.on_end(span)

    def shutdown(self):
        self._next.shutdown()

    def force_flush(self, timeout_millis=30000):
        return self._next.force_flush(timeout_millis)


provider = TracerProvider()
provider.add_span_processor(LlamaIndexForMaple(BatchSpanProcessor(OTLPSpanExporter())))
trace.set_tracer_provider(provider)

LlamaIndexInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

Always add the exporter through `LlamaIndexForMaple`, never directly.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or Sentry), add `LlamaIndexForMaple(BatchSpanProcessor(OTLPSpanExporter()))` to it and pass it to `instrument()`.

## Group a conversation into one session

Wrap each `agent.run()` call in `using_session` with the conversation id your app stores the chat under, and tag it with the agent's name:

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

Only the `agent.run()` call needs to be inside the `with`. Consume the stream outside it.

Keep one `Context` per conversation. A new UUID per request gives you one session per message.

For multi-agent workflows, run the whole workflow inside `using_session(conversation_id)` and wrap each sub-agent's `run()` in its own `instrument_tags({"gen_ai.agent.name": agent.name})` to give each agent its own lane. `AgentWorkflow` handoffs show as a single agent.

## Get tokens on streamed calls

`FunctionAgent` streams its model calls, and OpenAI only reports tokens on a stream when asked. Pass `stream_options` on OpenAI and OpenAI-compatible models:

```py
from llama_index.llms.openai import OpenAI

llm = OpenAI(model="gpt-4o-mini", additional_kwargs={"stream_options": {"include_usage": True}})
```

With `OpenAILike` or `OpenRouter`, also pass `is_function_calling_model=True`, or the agent never calls tools.

## Flush in short-lived processes

Long-running servers need nothing. In serverless handlers, notebooks and task workers, import `provider` from `tracing` and call `provider.force_flush()` in a `finally` after each run.

## Check that it works

Send two or three messages with the same conversation id, one of them using a tool, then open **Agent Sessions**. Within a minute you should see one session labeled **LlamaIndex**, with one turn per `agent.run()`, a transcript, one model call per request with tokens, and `FunctionTool.acall` tool calls.

Cost shows as **unpriced** and streamed model calls last about 1 ms. Both are expected.

## Troubleshooting

- **No spans at all.** Import `tracing` before the first `agent.run()`, check the logs for `DependencyConflict` (upgrade llama-index-core) and exporter errors.
- **One session per message.** `agent.run()` isn't inside `using_session(...)`, or the id changes per request.
- **Each model or tool call counted two or three times.** The exporter was added directly. Add it through `LlamaIndexForMaple`.
- **No tokens on streamed calls.** Add `stream_options={"include_usage": True}` through `additional_kwargs`.
- **No lanes or agent names.** Wrap each agent's `run()` in `instrument_tags({"gen_ai.agent.name": agent.name})`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [OpenRouter](/docs/agent-tracing/openrouter): cost per call if your models go through OpenRouter.
