---
title: "Trace Agno agents and teams with OpenTelemetry"
description: "Send Agno agent, team and tool spans to Maple as one Agent Session per conversation, with transcript, tokens and failed tools."
group: "AI Agents"
order: 26
navLabel: "Agno"
icon: "agno"
---

`openinference-instrumentation-agno` traces every Agno agent and team run, model call and tool call. Agno's own `setup_tracing()` uses the same instrumentor but writes spans to your AgentOS database, so to reach Maple you install it yourself with an OTLP exporter.

The one thing to get right is `session_id`. Without it, Agno generates an id once per `Agent` object, and a server with one shared agent puts every user's conversation into the same Maple session.

Tested with Agno 3.0.11 and `openinference-instrumentation-agno` 1.0.10 on Python 3.10 to 3.14.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-agno](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-agno) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Agno in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-agno -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is under **Settings → Ingestion**.

## Install and point the exporter at Maple

```bash
pip install -U "agno>=3.0" "openinference-instrumentation-agno>=1.0.10" \
  opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export AGNO_TELEMETRY=false
```

EU organizations use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself. `AGNO_TELEMETRY=false` only turns off Agno's anonymous usage pings.

## Initialize tracing

Create one tracer provider in `tracing.py` and import it at the top of your entry point, before you build agents or an `AgentOS`:

```py
# tracing.py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.agno import AgnoInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

AgnoInstrumentor().instrument(
    tracer_provider=provider,
    # Also write gen_ai.* attributes, which Maple's session detail page reads
    config=TraceConfig(enable_genai_semconv=True),
)
```

Keep `enable_genai_semconv=True`. Without it the sessions list still shows tokens, but the session page has no transcript. If you can't change the `instrument()` call, set `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` instead.

### Keep the AgentOS traces view

`AgentOS(tracing=True)` and `setup_tracing(db=...)` skip their setup once `tracing.py` has registered a provider, so the AgentOS traces view stops filling. To keep it, add Agno's database exporter to your provider, with the same `db` you give AgentOS:

```py
from agno.tracing.exporter import DatabaseSpanExporter

provider.add_span_processor(BatchSpanProcessor(DatabaseSpanExporter(db=db)))
```

## Pass session_id on every run

Each `run()` or `arun()` starts a new trace. Maple joins them into a session by the `session.id` Agno puts on the run span, taken from the `session_id` argument:

```py
from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.models.openrouter import OpenRouter

# Built once at import time and shared by every request
agent = Agent(
    name="support_agent",
    model=OpenRouter(id="openai/gpt-4o-mini"),
    db=SqliteDb(db_file="tmp/agno.db"),
    tools=[get_weather, calculate],
    add_history_to_context=True,
)


def chat(conversation_id: str, user_id: str, message: str) -> str:
    response = agent.run(message, session_id=conversation_id, user_id=user_id)
    return response.content


async def chat_stream(conversation_id: str, user_id: str, message: str):
    async for event in agent.arun(
        message, stream=True, session_id=conversation_id, user_id=user_id
    ):
        if getattr(event, "content", None):
            yield event.content
```

Use the conversation id your app already stores. Agno uses the same id to load history from the agent's `db`, so tracing and memory stay in sync. Pass it to `team.run()`, workflows and `continue_run()` as well. Team members inherit the team's id, and a resumed human-in-the-loop run shows up as a second turn in the same session.

## Teams, failed tools and content

Give every `Agent` and `Team` a `name=`. Maple opens a lane for each named team member, and unnamed ones show up as `Agent.run` or `Team.run` with no lane.

A tool that raises is marked failed, even though Agno hands the error back to the model and the run continues. A tool that returns an error string counts as a success.

To keep content out of Maple, set `OPENINFERENCE_HIDE_INPUT_MESSAGES`, `OPENINFERENCE_HIDE_OUTPUT_MESSAGES`, `OPENINFERENCE_HIDE_INPUTS` and `OPENINFERENCE_HIDE_OUTPUTS` to `true` before the instrumentor starts. Tool arguments are still exported; removing them needs a `redaction` processor in an OpenTelemetry Collector.

## Flush before short-lived processes exit

`BatchSpanProcessor` exports every 5 seconds. Long-running servers flush on shutdown, but scripts, CLIs, notebooks, workers and serverless handlers need an explicit flush:

```py
from tracing import provider

try:
    agent.run("Summarize today's tickets", session_id=conversation_id)
finally:
    provider.force_flush()  # serverless: flush at the end of every invocation
    provider.shutdown()     # scripts: flush and stop at the end of the process
```

On AWS Lambda and similar platforms, call only `force_flush()`, since the next invocation reuses the process.

## Check that it works

Run a conversation of two or three turns with one `session_id`, including a tool call, and open **Agent Sessions** filtered by your service name. You should see one session with your `session_id` as its id, framework **Agno**, one turn per `run()`, a transcript, and model calls such as `OpenRouter.invoke` with tokens. A session named `trace:...` means the run span had no `session.id`.

Cost appears in the sessions list when your provider returns one (OpenRouter does). The session page shows it as not reported for Agno, and providers without prices show as **unpriced**.

## Troubleshooting

- **Nothing arrives in Maple.** `setup_tracing()` or `AgentOS(tracing=True)` ran before `tracing.py` and the spans went to the AgentOS database. Import `tracing` first.
- **Every user is in one giant session.** The shared `Agent` runs without `session_id=`. Pass it on every `run()`, `arun()` and `continue_run()`.
- **Every turn is its own session.** You pass a new id per request, often a fresh `uuid4()`. Use the stored conversation id.
- **Tokens in the list, no transcript on the session page.** `enable_genai_semconv` is off, or other code called `instrument()` first (the second call is ignored).
- **An agent run lands inside the previous team run's trace.** Instrumentor 1.0.10 leaves the team span attached to the thread or task. In scripts and workers, run each team run in its own context with `asyncio.create_task(...)` or `contextvars.copy_context().run(...)`.
- **Every model call appears twice.** Remove the second instrumentor, usually `openinference-instrumentation-openai`, OpenLIT or Phoenix's `register(auto_instrument=True)`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Agent tracing guides](/docs/agent-tracing)
- [Agno tracing documentation](https://docs.agno.com/agent-os/tracing/overview)
- [openinference-instrumentation-agno on PyPI](https://pypi.org/project/openinference-instrumentation-agno/)
- [OpenInference configuration variables](https://arize.com/docs/phoenix/tracing/how-to-tracing/advanced/masking-span-attributes)
