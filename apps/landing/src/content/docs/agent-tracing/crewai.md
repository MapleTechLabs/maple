---
title: "Trace CrewAI crews and flows with OpenTelemetry"
description: "Send CrewAI crews and flows to Maple with OpenInference, one Agent Session per conversation."
group: "AI Agents"
order: 21
navLabel: "CrewAI"
icon: "crewai"
---

CrewAI doesn't export traces to your backend on its own. OpenInference's `openinference-instrumentation-crewai` records crews, agents and tools, and a second instrumentor for the SDK CrewAI calls records the model calls, prompts and tokens. Without that second instrumentor you get no transcript, and without a session id every `kickoff()` is its own session.

Tested with CrewAI 1.15, `openinference-instrumentation-crewai` 1.1.18 and `openinference-instrumentation-openai` 0.1.61 on Python 3.10 to 3.13.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-crewai](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-crewai) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for CrewAI in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-crewai -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. EU organizations should say EU region.

## Install the instrumentors

```bash
pip install "crewai>=1.15" "openinference-instrumentation-crewai>=1.1.18" \
  "openinference-instrumentation-openai>=0.1.61" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Pick the model instrumentor by the model string you pass to `LLM(...)`:

| Model string | SDK CrewAI calls | Instrumentor |
| --- | --- | --- |
| `openai/…`, `openrouter/…`, `deepseek/…`, `ollama/…`, `custom_openai=True`, or a bare name like `gpt-4.1-mini` | `openai` | `openinference-instrumentation-openai` |
| `anthropic/…` or a bare `claude-…` | `anthropic` | `openinference-instrumentation-anthropic` |
| `gemini/…` or a bare `gemini-…` | `google-genai` | `openinference-instrumentation-google-genai` |
| `bedrock/…` | `boto3` | `openinference-instrumentation-bedrock` |
| Anything else (needs `crewai[litellm]`) | `litellm` | `openinference-instrumentation-litellm` |

Install only the ones your crews use. The LiteLLM instrumentor records nothing for the native providers in the first four rows.

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

The last two variables turn off CrewAI's anonymous analytics and its own trace uploader, whose first-run prompt waits for input at the end of a run. Don't use `OTEL_SDK_DISABLED=true` for this, because it disables your Maple traces too.

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
    """Copies each CrewAI agent's role to gen_ai.agent.name, which Maple uses for agent lanes."""

    def on_start(self, span, parent_context=None):
        # The instrumentor records the role (graph.node.id) just after the agent span starts,
        # so name the agent span when its first child starts, while it's still open.
        parent = trace.get_current_span(parent_context)
        attrs = getattr(parent, "attributes", None) or {}
        role = attrs.get("graph.node.id")
        if role and "gen_ai.agent.name" not in attrs and parent.is_recording():
            parent.set_attribute("gen_ai.agent.name", role)


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(CrewAIAgentNames())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

config = TraceConfig(enable_genai_semconv=True)
CrewAIInstrumentor().instrument(tracer_provider=provider, config=config, skip_dep_check=True)
OpenAIInstrumentor().instrument(tracer_provider=provider, config=config, skip_dep_check=True)
```

Pass `config` with `enable_genai_semconv=True` to every instrumentor, or the session page has no transcript and no tool details. `CrewAIAgentNames` gives each agent role its own lane. `skip_dep_check=True` stops an instrumentor from silently skipping itself when its version check disagrees with your installed packages.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or Sentry), add `CrewAIAgentNames()` and the exporter to that provider and pass it to `instrument()`.

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

Put the user's message first in the task description, because Maple labels each turn with the first line of the prompt. Name the crew, or its root span gets a new `Crew_<uuid>` name on every request. `crew_id` and `crew_key` don't work as conversation ids.

For conversational flows, wrap `flow.handle_turn(text, session_id=conversation_id)` in the same `using_session` and set `name = "support_flow"` on the flow class.

Use `kickoff()` or `await crew.kickoff_async()`. The instrumentor doesn't patch `akickoff()`, so with it every model and tool call becomes its own trace.

## Streaming crews

`Crew(stream=True)` calls `kickoff()` twice, which gives each message an extra empty turn. Wrap the streamed turn in one span of your own:

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

The SDK flushes on a normal interpreter exit, which covers servers and `crewai run`. In serverless handlers and notebooks, import `provider` from `tracing` and call `provider.force_flush()` in a `finally` after each run.

## Check that it works

Send two or three messages with the same conversation id, one of them using a tool, then open **Agent Sessions**. Within a minute you should see one session labeled **CrewAI**, with one turn per `kickoff()` starting at `support.kickoff`, `ChatCompletion` model calls with tokens, tool calls like `get_weather.run`, and one lane per agent role.

Cost shows as **unpriced** unless your models go through LiteLLM. That's expected.

## Troubleshooting

- **Agent and tool spans, but no model calls or tokens.** The instrumentor for your model's SDK is missing. Match it to the model string with the table above.
- **No spans at all.** Import `tracing` before the first kickoff, keep `skip_dep_check=True`, make sure `OTEL_SDK_DISABLED` isn't set, and check the logs for exporter errors.
- **One session per message.** The kickoff isn't inside `using_session(...)`, or the id changes per request.
- **Every model and tool call is its own trace.** Replace `akickoff()` with `kickoff()` or `kickoff_async()`.
- **The process hangs at exit asking about traces.** Set `CREWAI_TRACING_ENABLED=false`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for every other framework.
- [CrewAI telemetry](https://docs.crewai.com/en/telemetry): what CrewAI's own analytics collect and how to turn them off.
- [openinference-instrumentation-crewai](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-crewai): the instrumentor's source.
- [LiteLLM](/docs/agent-tracing/litellm) and [OpenRouter](/docs/agent-tracing/openrouter): if your models go through either gateway.
