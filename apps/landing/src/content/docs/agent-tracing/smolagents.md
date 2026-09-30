---
title: "Trace Hugging Face smolagents with OpenTelemetry"
description: "Send smolagents runs to Maple through the OpenInference instrumentor so each conversation shows up as one Agent Session."
group: "AI Agents"
order: 25
navLabel: "smolagents"
icon: "huggingface"
---

smolagents is traced with OpenInference's `openinference-instrumentation-smolagents`. Turn on its GenAI attributes and wrap each run in `using_session(...)`. Without `using_session(...)`, every message becomes its own session.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-smolagents](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-smolagents) skill and follows it.

```text
Set up Maple agent tracing for smolagents in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-smolagents -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the instrumentor and export to Maple

```bash
pip install "smolagents[openai]>=1.26" "openinference-instrumentation-smolagents>=0.1.40" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Use `[litellm]` instead of `[openai]` if you run `LiteLLMModel`. Skip the `smolagents[telemetry]` extra, which installs the Arize Phoenix server.

Point the exporter at Maple. For an EU organization, use `https://ingest.eu.maple.dev`. Set the base URL only; the exporter appends `/v1/traces`.

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

Add a `tracing.py` and import it at the top of your entry point, before the first `agent.run()`:

```py
# tracing.py
import json

from openinference.instrumentation import TraceConfig
from openinference.instrumentation.smolagents import SmolagentsInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


class SmolagentsForMaple(SpanProcessor):
    """Fixes agent names, tool names and tool arguments for Maple."""

    def on_start(self, span, parent_context=None):
        if span.instrumentation_scope.name != "openinference.instrumentation.smolagents":
            return
        attrs = span.attributes
        if span.name.endswith(".run"):
            span.set_attribute("gen_ai.agent.name", span.name.removesuffix(".run"))
        elif "tool.name" in attrs:
            span.update_name(f"execute_tool {attrs['tool.name']}")
            if attrs.get("input.value", "").startswith("{"):
                call = json.loads(attrs["input.value"])
                span.set_attribute("gen_ai.tool.call.arguments", json.dumps(call["kwargs"] or call["args"]))


provider = TracerProvider()
provider.add_span_processor(SmolagentsForMaple())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

SmolagentsInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

Copy `SmolagentsForMaple` as is. It gives each agent its own lane and fixes tool names and arguments.

If your app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or another library), add `SmolagentsForMaple()` and the exporter to that provider and pass it to `instrument()` instead of creating a second one.

## Wrap each run in the conversation id

Wrap every `agent.run()` in OpenInference's `using_session` with the id your app already stores the chat under:

```py
from openinference.instrumentation import using_session
from smolagents import OpenAIServerModel, ToolCallingAgent

# One agent per conversation. In a long-running server, evict idle ones or rebuild them from stored history.
agents: dict[str, ToolCallingAgent] = {}


def handle_message(conversation_id: str, text: str) -> str:
    agent = agents.get(conversation_id)
    if agent is None:
        agent = agents[conversation_id] = ToolCallingAgent(
            tools=[get_weather, calculate],
            model=OpenAIServerModel(model_id="gpt-4o-mini"),
            name="assistant",
        )
    with using_session(conversation_id):
        return str(agent.run(text, reset=False))
```

The id must stay the same across the conversation and differ between conversations.

Keep one agent object per conversation, as above. A single shared agent with `reset=False` mixes every user's memory into one conversation.

Give every agent, including managed agents, a `name`. Unnamed agents share one lane.

## Flush before the process exits

Serverless functions, killed workers and notebooks don't exit normally, so flush after each run:

```py
from tracing import provider

try:
    handle_message("conv-42", "What's the weather in Berlin?")
finally:
    provider.force_flush()
```

## Check that it works

Run two or three messages through `handle_message` with the same conversation id, including one that uses a tool, then open **Agent Sessions**. You should see one session with framework **smolagents**, one turn per `agent.run()`, a transcript, `OpenAIModel.generate` model calls with token counts, and `execute_tool <name>` tool calls. Each run ends with an `execute_tool final_answer` call.

Cost shows as unpriced.

## Troubleshooting

- **One session per message.** Wrap every `agent.run()` in `using_session(...)` with the stored conversation id.
- **Exports fail with 404.** `OTLPSpanExporter(endpoint=...)` doesn't append `/v1/traces`. Use the environment variable with the base URL, or pass the full path.
- **Every model call appears twice.** Remove `openinference-instrumentation-openai` or `openinference-instrumentation-litellm`; the smolagents instrumentor already covers model calls.
- **No tool spans with `CodeAgent`.** A remote executor (`e2b`, `docker`, `modal`) runs tools outside your process. Only the local executor produces tool spans.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [LiteLLM](/docs/agent-tracing/litellm) and [OpenRouter](/docs/agent-tracing/openrouter), if your models go through either gateway
