---
title: "Trace CrewAI crews and flows with OpenTelemetry"
description: "Send CrewAI crews and flows to Maple with OpenInference, one Agent Session per conversation."
group: "AI Agents"
order: 21
navLabel: "CrewAI"
icon: "crewai"
---

CrewAI needs two OpenInference instrumentors: `openinference-instrumentation-crewai` for crews, agents and tools, and one for your model provider, which records prompts and tokens. You also wrap every `kickoff()` in a conversation id so a chat becomes one session.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-crewai](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-crewai) skill and follows it.

```text
Set up Maple agent tracing for CrewAI in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-crewai -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the instrumentors

```bash
pip install "crewai>=1.15" "openinference-instrumentation-crewai>=1.1.18" \
  "openinference-instrumentation-openai>=0.1.61" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Pick the model instrumentor by the model string you pass to `LLM(...)`:

| Model string | Instrumentor |
| --- | --- |
| `openai/…`, `openrouter/…`, `deepseek/…`, `ollama/…`, `custom_openai=True`, or a bare name like `gpt-4.1-mini` | `openinference-instrumentation-openai` |
| `anthropic/…` or a bare `claude-…` | `openinference-instrumentation-anthropic` |
| `gemini/…` or a bare `gemini-…` | `openinference-instrumentation-google-genai` |
| `bedrock/…` | `openinference-instrumentation-bedrock` |
| Anything else (needs `crewai[litellm]`) | `openinference-instrumentation-litellm` |

Install only the ones your crews use. The LiteLLM instrumentor records nothing for the first four rows.

## Point the exporter at Maple

```bash
export OTEL_SERVICE_NAME=support-crew
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export CREWAI_DISABLE_TELEMETRY=true
export CREWAI_TRACING_ENABLED=false
```

EU organizations use `https://ingest.eu.maple.dev`. If you pass `endpoint=` to `OTLPSpanExporter` in code instead, it has to end in `/v1/traces`.

The last two turn off CrewAI's own telemetry and a first-run prompt that blocks the process at exit. Don't use `OTEL_SDK_DISABLED=true` instead, because it disables your Maple traces too.

## Initialize tracing

Add a `tracing.py` and import it at the top of your entry point, before the first `kickoff()`:

```py
# tracing.py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.crewai import CrewAIInstrumentor
from openinference.instrumentation.openai import OpenAIInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


class CrewAIAgentNames(SpanProcessor):
    def on_start(self, span, parent_context=None):
        parent = trace.get_current_span(parent_context)
        attrs = getattr(parent, "attributes", None) or {}
        role = attrs.get("graph.node.id")
        if role and "gen_ai.agent.name" not in attrs and parent.is_recording():
            parent.set_attribute("gen_ai.agent.name", role)


provider = TracerProvider()
provider.add_span_processor(CrewAIAgentNames())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

config = TraceConfig(enable_genai_semconv=True)
CrewAIInstrumentor().instrument(tracer_provider=provider, config=config, skip_dep_check=True)
OpenAIInstrumentor().instrument(tracer_provider=provider, config=config, skip_dep_check=True)
```

Pass `config` to every instrumentor. Keep `skip_dep_check=True`, or an instrumentor can silently skip itself.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or Sentry), add `CrewAIAgentNames()` and the exporter to it and pass it to `instrument()`.

## Group a conversation into one session

CrewAI has no conversation id, so wrap every `kickoff()` in OpenInference's `using_session` with the id your app stores the chat under:

```py
import tracing  # noqa: F401  (first import)

from crewai import LLM, Agent, Crew, Task
from openinference.instrumentation import using_session

llm = LLM(model="openai/gpt-4o-mini", temperature=0)


def build_crew(text: str, history: str, stream: bool = False) -> Crew:
    assistant = Agent(
        role="assistant",
        goal="Answer the user's questions",
        backstory="You are a concise, helpful assistant.",
        llm=llm,
        tools=[get_weather, calculate],
    )
    task = Task(
        description=f"{text}\n\nConversation so far:\n{history}",
        expected_output="A short, direct reply to the user.",
        agent=assistant,
        name="reply",
    )
    return Crew(name="support", agents=[assistant], tasks=[task], stream=stream)


def handle_message(conversation_id: str, text: str, history: str) -> str:
    with using_session(conversation_id):
        return build_crew(text, history).kickoff().raw
```

Put the user's message first in the task description, because Maple labels each turn with its first line. Give the crew a `name=`. `crew_id` and `crew_key` don't work as conversation ids.

For conversational flows, wrap `flow.handle_turn(text, session_id=conversation_id)` in the same `using_session` and set `name = "support_flow"` on the flow class.

Use `kickoff()` or `await crew.kickoff_async()`, never `akickoff()`, which isn't traced as one run.

## Streaming crews

`Crew(stream=True)` adds an empty turn to every message. Wrap the streamed turn in one span of your own:

```py
from opentelemetry import trace

tracer = trace.get_tracer("chat")


def stream_message(conversation_id: str, text: str, history: str, send) -> None:
    with using_session(conversation_id), tracer.start_as_current_span(
        "invoke_agent support",
        attributes={
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.conversation.id": conversation_id,
        },
    ):
        for chunk in build_crew(text, history, stream=True).kickoff():
            send(chunk.content)
```

`LLM(stream=True)` without `Crew(stream=True)` doesn't need this.

## Flush in short-lived processes

Servers and `crewai run` need nothing. In serverless handlers and notebooks, import `provider` from `tracing` and call `provider.force_flush()` in a `finally` after each run.

## Check that it works

Send two or three messages with the same conversation id, one of them using a tool, then open **Agent Sessions**. Within a minute you should see one session labeled **CrewAI**, with one turn per `kickoff()` starting at `support.kickoff`, `ChatCompletion` model calls with tokens, tool calls like `get_weather.run`, and one lane per agent role.

Cost shows as **unpriced** unless your models go through LiteLLM, which is expected.

## Troubleshooting

- **Agent and tool spans, but no model calls or tokens.** The instrumentor for your model's SDK is missing. Match it to the model string with the table above.
- **No spans at all.** Import `tracing` before the first kickoff, keep `skip_dep_check=True`, make sure `OTEL_SDK_DISABLED` isn't set, and check the logs for exporter errors.
- **One session per message.** The kickoff isn't inside `using_session(...)`, or the id changes per request.
- **Every model and tool call is its own trace.** Replace `akickoff()` with `kickoff()` or `kickoff_async()`.
- **The process hangs at exit asking about traces.** Set `CREWAI_TRACING_ENABLED=false`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [LiteLLM](/docs/agent-tracing/litellm) and [OpenRouter](/docs/agent-tracing/openrouter): if your models go through either gateway.
