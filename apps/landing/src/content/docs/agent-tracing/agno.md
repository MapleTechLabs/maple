---
title: "Trace Agno agents and teams with OpenTelemetry"
description: "Send Agno agent, team and tool spans to Maple with the OpenInference instrumentor, grouped into one Agent Session per conversation with transcripts, tokens and failed tools."
group: "AI Agents"
order: 26
navLabel: "Agno"
icon: "agno"
---

Agno's tracing is built on OpenInference. The `openinference-instrumentation-agno` package wraps every agent and team run, every model call and every tool call, and Agno's own `setup_tracing()` uses the same instrumentor. The catch is where `setup_tracing()` sends the spans: into your AgentOS database, not to an OpenTelemetry endpoint. To get them into Maple you install the instrumentor yourself with an OTLP exporter.

The thing that goes wrong by default is the session id. Agno always stamps `session.id` on the run span, but when you don't pass `session_id=`, it generates one and keeps it on the `Agent` instance. A chat server with one module-level agent then puts every user's conversation into the same Maple session.

This guide covers Agno 3.0 (tested with 3.0.11) and `openinference-instrumentation-agno` 1.0.10 on Python 3.10 to 3.14.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-agno](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-agno) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Agno in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-agno -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the instrumentor and export to Maple

```bash
pip install -U "agno>=3.0" "openinference-instrumentation-agno>=1.0.10" \
  opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

Version 1.0.8 of the instrumentor is the first that traces resumed human-in-the-loop runs, and 1.0.10 adds cost. Older versions work, with the gaps listed under [Troubleshooting](#troubleshooting).

Configure the exporter with the standard OpenTelemetry variables:

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export AGNO_TELEMETRY=false
```

EU organizations use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` to the endpoint itself. `AGNO_TELEMETRY=false` turns off Agno's anonymous usage pings to agno.com, which have nothing to do with your traces.

Then create one tracer provider at startup:

```py
# tracing.py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.agno import AgnoInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

# Resource comes from OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES,
# endpoint and key from OTEL_EXPORTER_OTLP_*.
provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

AgnoInstrumentor().instrument(
    tracer_provider=provider,
    # Also write gen_ai.* attributes, which Maple's session detail page reads
    config=TraceConfig(enable_genai_semconv=True),
)
```

Import `tracing` at the top of your entry point, before you build agents or an `AgentOS`. The instrumentor patches Agno's run functions and every model class in `agno.models`, so agents created later are traced without further changes.

`enable_genai_semconv=True` is not optional for Maple. Without it the spans only carry OpenInference attributes (`llm.input_messages.0.message.content`, `llm.token_count.prompt`). The Agent Sessions list still shows tokens and models from those, but the session detail page shows no transcript. With it, each span also gets `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.*`, `gen_ai.tool.*` and `gen_ai.agent.name`. The environment variable `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` does the same thing if you can't change the `instrument()` call.

### If you use AgentOS tracing

`AgentOS(tracing=True)` and `agno.tracing.setup_tracing(db=...)` install the same instrumentor with a `DatabaseSpanExporter`, which is what feeds the AgentOS traces view. Both skip their setup when a real `TracerProvider` is already registered. So if `tracing.py` runs first, AgentOS stops writing traces to its database.

To keep both, add Agno's database exporter to your provider next to the OTLP one, with the same `db` you give AgentOS:

```py
from agno.tracing.exporter import DatabaseSpanExporter

provider.add_span_processor(BatchSpanProcessor(DatabaseSpanExporter(db=db)))
```

Don't call `AgnoInstrumentor().instrument()` twice. The second call logs "Attempting to instrument while already instrumented" and does nothing, so its `config` is ignored.

## Group each conversation into one session

Every `agent.run()`, `team.run()` and their async versions start a new trace. Maple joins those traces into a session using the `session.id` attribute on the run span (`support_agent.run`). Agno sets it from the `session_id` argument, so pass your conversation id on every call:

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

If you leave it out, Agno generates a UUID on the first run and assigns it to `agent.session_id`, and every later run of that `Agent` object reuses it. That's right for a script that creates one agent per conversation. It's wrong for a server that builds the agent once at import time, where every user's messages land in a single Maple session that grows forever.

`session_id` is also how Agno finds the conversation's history in the agent's `db`, so the id you pass for tracing is the same one you need for memory. Members of a `Team` inherit the team's session id, and `continue_run()` takes `session_id=` too.

Maple reads `session.id` for Agno spans. With `enable_genai_semconv=True` the root span also carries `gen_ai.conversation.id` with the same value, which Maple ignores for Agno. You don't need `using_session()` from `openinference.instrumentation`: Agno already sets the id on the run span, and one span per trace is enough.

## Record prompts, responses and tool calls

The OpenInference instrumentor records content by default. Each model span carries the full message list sent to the model (system prompt, history, tool results) and the model's reply, including tool calls. Each tool span carries the arguments and the result. With `enable_genai_semconv=True` they are written as `gen_ai.input.messages` and `gen_ai.output.messages` in the `[{role, parts}]` format Maple renders as a transcript.

Maple reads span attributes only. The instrumentor emits no span events or OTLP logs, so nothing else needs enabling.

To keep content out of Maple, set OpenInference's masking variables before the instrumentor starts:

```bash
export OPENINFERENCE_HIDE_INPUT_MESSAGES=true   # prompts sent to the model
export OPENINFERENCE_HIDE_OUTPUT_MESSAGES=true  # model replies
export OPENINFERENCE_HIDE_INPUTS=true           # run and tool inputs
export OPENINFERENCE_HIDE_OUTPUTS=true          # run and tool outputs
```

Masked values are replaced with `__REDACTED__` before the span is exported, so they never leave your process. Sessions still show models, tokens, tools and failures, with an empty transcript. One exception: tool arguments (`tool.parameters` and `gen_ai.tool.call.arguments`) are not covered by any of these variables and are still exported. To drop them, or for finer control such as redacting emails but keeping the rest, run an OpenTelemetry Collector with a `redaction` or `transform` processor between your app and Maple.

Tool results are recorded as `str(result)`, which is also what Agno sends back to the model. A tool that returns a `dict` shows up as a Python repr (`{'city': 'Berlin'}`), which isn't valid JSON, so Maple shows it as plain text. Return a JSON string from tools that produce structured data:

```py
import json

from agno.tools import tool


@tool
def get_weather(city: str) -> str:
    """Get the current weather for a city."""
    return json.dumps({"city": city, "temperature_c": 21, "condition": "partly cloudy"})
```

## Tools, errors and team members

Each tool call is its own span, named after the function (`get_weather`), with `gen_ai.operation.name=execute_tool` and `gen_ai.tool.name`. When a tool raises, Agno catches the exception and hands the message back to the model, but the instrumentor still marks the tool span as failed with status `ERROR` and the exception text as its message. Maple counts it as a failed tool call and groups repeated failures by that message. The run span stays OK because the run itself continued.

A tool that returns an error string instead of raising looks like a success. If you want a failure to count, raise.

A `Team` delegates to its members through a `delegate_task_to_member` tool:

```py
from agno.team import Team, TeamMode

weather_worker = Agent(name="weather_worker", model=primary, tools=[get_weather])
budget_worker = Agent(name="budget_worker", model=secondary, tools=[calculate])
transport_worker = Agent(name="transport_worker", model=primary, tools=[fetch_transport_data])

team = Team(
    name="travel_team",
    mode=TeamMode.coordinate,
    model=primary,
    members=[weather_worker, budget_worker, transport_worker],
)

await team.arun("Produce a mini briefing about Amsterdam.", session_id=conversation_id)
```

The whole team run is one trace. The members' runs sit directly under the leader's run, next to the `delegate_task_to_member` tool spans rather than inside them:

```text
travel_team.arun                      invoke_agent  (team leader)
├─ OpenRouter.ainvoke                 chat
├─ delegate_task_to_member            execute_tool
├─ delegate_task_to_member            execute_tool
├─ weather_worker.arun                invoke_agent
│  ├─ OpenRouter.ainvoke              chat
│  ├─ get_weather                     execute_tool
│  └─ OpenRouter.ainvoke              chat
├─ transport_worker.arun              invoke_agent
│  ├─ OpenRouter.ainvoke              chat
│  ├─ fetch_transport_data            execute_tool  (ERROR)
│  └─ OpenRouter.ainvoke              chat
└─ OpenRouter.ainvoke                 chat          (leader's final answer)
```

Maple opens a lane for each member because each member span has its own `gen_ai.agent.name`. The `delegate_task_to_member` calls show up as ordinary tool calls on the leader, with the member id and task as arguments. Give every `Agent` and `Team` a `name=`. Unnamed ones produce spans called `Agent.run` or `Team.run` with no agent name, and Maple can't give them a lane. With `team.arun()` in `coordinate` mode, members the leader calls in one step run concurrently, and their spans overlap in time. The sync `team.run()` runs them one after another.

Instrumentor 1.0.10 leaves the team's span attached to the current context after `team.run()` or `team.arun()` returns. Any agent run that follows in the same thread or asyncio task becomes a child of the finished team run, in its trace. Web frameworks that handle each request in its own task or copied context, such as FastAPI, are not affected. In scripts, workers and loops, give each team run its own context:

```py
import asyncio
import contextvars

# async
result = await asyncio.create_task(team.arun(prompt, session_id=conversation_id))

# sync
result = contextvars.copy_context().run(team.run, prompt, session_id=conversation_id)
```

### Human-in-the-loop approvals

Agno's confirmation flow pauses the run, and `continue_run()` resumes it. Pass the same `session_id` to both:

```py
@tool(requires_confirmation=True)
def delete_file(path: str) -> str:
    """Delete a file from disk. Destructive: requires user approval."""
    ...


response = agent.run(message, session_id=conversation_id)
if response.is_paused:
    for requirement in response.active_requirements:
        requirement.confirm()  # or requirement.reject(note="...")
    response = agent.continue_run(
        run_id=response.run_id,
        requirements=response.requirements,
        session_id=conversation_id,
    )
```

The paused run and the resumed run are two traces, `support_agent.run` and `support_agent.continue_run`, both carrying the conversation's `session.id`. Maple shows them as two turns of the same session, and the approved tool call appears once, in the second. `continue_run()` needs a `db` on the agent.

Workflows (`agno.workflow`) are instrumented too and accept `session_id=` the same way.

## Tokens and cost

Every model span carries input and output tokens, plus cache read and cache write tokens when the provider reports them. Streaming runs (`stream=True`) record usage as well, because Agno reads it from the final chunk. The run span has no token counts of its own, so nothing is counted twice.

Reasoning tokens are not broken out into their own attribute, so Maple can't show them separately. Model spans also carry no `gen_ai.response.id` and no time-to-first-token, and tool spans carry no `gen_ai.tool.call.id` (the id is only inside the message parts). Maple still links tool results to calls through the conversation history, but it can't show streaming latency for Agno.

Cost appears when the model provider returns a price with the response. OpenRouter does, and the instrumentor records it as `llm.cost.total` in USD. Maple never prices tokens itself, so calls to providers that don't return a cost, such as OpenAI or Anthropic called directly, show as unpriced.

For now, only the **Agent Sessions** list shows that cost. The session's own page doesn't read `llm.cost.total` yet and shows the cost as not reported. Tokens, models and call counts match on both.

## Flush before short-lived processes exit

`BatchSpanProcessor` exports every 5 seconds. A long-running server needs nothing extra: the SDK flushes on normal shutdown. Scripts, CLIs, notebooks, queue workers and serverless handlers need an explicit flush, or the last spans are lost:

```py
from tracing import provider

try:
    agent.run("Summarize today's tickets", session_id=conversation_id)
finally:
    provider.force_flush()  # serverless: flush at the end of every invocation
    provider.shutdown()     # scripts: flush and stop at the end of the process
```

In a Jupyter notebook, call `provider.force_flush()` after the cell that runs the agent. On AWS Lambda and similar platforms, call `force_flush()` before returning from the handler and never `shutdown()`, since the next invocation reuses the process.

## Check that it works

Run one conversation of two or three turns with the same `session_id`, including one tool call. Within a minute, open **Agent Sessions** in Maple and filter by your service name. You should see:

- **One session per conversation**, with your `session_id` as its id and **Agno** as the framework. A session called `trace:...` means the run span had no `session.id`.
- **One turn per `run()` call**, labelled with the user's message.
- **A transcript** with the system prompt, user messages, assistant replies and tool calls. An empty transcript with non-zero tokens means `enable_genai_semconv` is off.
- **Model calls** named after the Agno model class (`OpenRouter.invoke`, `OpenAIChat.ainvoke`, `Claude.invoke_stream`), with the model id (`openai/gpt-4o-mini`) as the model.
- **Tool calls** named after your functions, with arguments and results, and failed ones marked.
- **Agents** named after your `Agent(name=...)` and `Team(name=...)`, with a lane per team member.
- **Tokens** on every model call, and a cost in the sessions list if your provider returns one. The session page shows cost as not reported for Agno.

A human-in-the-loop approval shows up as two turns in the same session: the run that paused (`support_agent.run`) and the resumed run (`support_agent.continue_run`), each in its own trace.

## Troubleshooting

- **Nothing arrives in Maple.** The spans went to AgentOS's database instead. You called `setup_tracing()` or created `AgentOS(tracing=True)` before `tracing.py` ran, so the global provider is Agno's, and `set_tracer_provider` in `tracing.py` logged "Overriding of current TracerProvider is not allowed". Run `tracing.py` first. If only the last few runs are missing, see [Flush before short-lived processes exit](#flush-before-short-lived-processes-exit).
- **Every user's conversation is in one giant session.** The `Agent` is shared and no `session_id=` is passed, so Agno reuses its auto-generated id. Pass `session_id=` on every `run()`, `arun()` and `continue_run()`.
- **Every turn is its own session.** You pass a new id per request, often a fresh `uuid4()`. Use the conversation or thread id your app already stores.
- **Sessions list shows tokens, but the detail page has no transcript or model.** `enable_genai_semconv` is off, so the spans only have OpenInference attributes, which Maple's detail page doesn't decode for Agno yet. Pass `TraceConfig(enable_genai_semconv=True)` or set `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true`, and check that `instrument()` isn't being called a second time by other code.
- **Resumed runs show up as loose model and tool calls with no session.** Your instrumentor is older than 1.0.8, which didn't wrap `continue_run()`. Upgrade to 1.0.10.
- **Team members appear as `Agent.run` with no lane.** The member has no `name=`.
- **Every model call appears twice.** A second instrumentor wraps the same client, usually `openinference-instrumentation-openai`, OpenLIT, or Phoenix's `register(auto_instrument=True)` picking up every installed OpenInference package. Keep only the Agno instrumentor.
- **An agent run lands inside the previous team run's trace.** The instrumentor leaves a finished team run's span attached to the thread or task ([agno#5573](https://github.com/agno-agi/agno/issues/5573)). Run each team run in its own context with `asyncio.create_task(...)` or `contextvars.copy_context().run(...)`, as shown in [Tools, errors and team members](#tools-errors-and-team-members). Plain agent runs, streamed or not, don't leak.
- **Tool results show as text instead of JSON.** The tool returns a `dict` or `list`, which Agno records as a Python repr. Return `json.dumps(...)`.
- **"Failed to detach context" in the logs after a streamed team run.** A known instrumentor issue with async generators ([agno#5208](https://github.com/agno-agi/agno/issues/5208)). The spans are still exported; it's log noise.
- **`SqliteDb` fails with "requires that the Python 'greenlet' library is installed".** Agno 3's SQLite store imports SQLAlchemy's asyncio support. SQLAlchemy doesn't pull in `greenlet` on every platform (Apple silicon, for one), so install `agno[sqlite]` and `greenlet`. This matters for tracing because `continue_run()` needs a `db`.
- **A failed tool shows as successful.** The tool returned an error message instead of raising. Raise an exception so the span gets status `ERROR`.
- **No cost on any session.** Your provider doesn't return prices. Maple shows the tokens and marks the session unpriced.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Agent tracing guides](/docs/agent-tracing)
- [Agno tracing documentation](https://docs.agno.com/agent-os/tracing/overview)
- [openinference-instrumentation-agno on PyPI](https://pypi.org/project/openinference-instrumentation-agno/)
- [OpenInference configuration variables](https://arize.com/docs/phoenix/tracing/how-to-tracing/advanced/masking-span-attributes)
