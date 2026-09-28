---
title: "Trace CrewAI crews and flows with OpenTelemetry"
description: "Send CrewAI crews and flows to Maple as Agent Sessions, one per conversation, with the transcript, model and tool calls, tokens, failed tools and an agent lane per crew member."
group: "AI Agents"
order: 21
navLabel: "CrewAI"
icon: "crewai"
---

CrewAI sends nothing to your OpenTelemetry backend on its own. Its built-in telemetry is anonymous usage analytics that goes to CrewAI on a private tracer provider, and its OpenTelemetry export is a CrewAI AMP feature. The traces come from OpenInference: `openinference-instrumentation-crewai` records crews, flows, tasks and tools, and a second instrumentor for the SDK CrewAI calls records the model calls, prompts and tokens.

Most broken CrewAI traces are missing that second instrumentor. With only the CrewAI one, you get agent and tool spans with no model, no tokens and no transcript. The other gap is the conversation: CrewAI has no chat thread, so every `kickoff()` is its own trace with nothing linking it to the previous message. This guide covers CrewAI 1.15 with `openinference-instrumentation-crewai` 1.1.18 and `openinference-instrumentation-openai` 0.1.61, on Python 3.10 to 3.13.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-crewai](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-crewai) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for CrewAI in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-crewai -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the instrumentors and export to Maple

```bash
pip install "crewai>=1.15" "openinference-instrumentation-crewai>=1.1.18" \
  "openinference-instrumentation-openai>=0.1.61" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

The OpenAI instrumentor is right for most apps because CrewAI 1.x calls most providers through the `openai` SDK. Which instrumentor you need depends on the model string you pass to `LLM(...)`:

| Model string | SDK CrewAI calls | Instrumentor |
| --- | --- | --- |
| `openai/…`, `openrouter/…`, `deepseek/…`, `ollama/…`, `custom_openai=True`, or a bare name like `gpt-4.1-mini` | `openai` | `openinference-instrumentation-openai` |
| `anthropic/…` or a bare `claude-…` | `anthropic` | `openinference-instrumentation-anthropic` |
| `gemini/…` or a bare `gemini-…` | `google-genai` | `openinference-instrumentation-google-genai` |
| `bedrock/…` | `boto3` | `openinference-instrumentation-bedrock` |
| Anything else (needs `crewai[litellm]`) | `litellm` | `openinference-instrumentation-litellm` |

Instrument only the SDKs your crews actually call. The Arize Phoenix CrewAI page still recommends the LiteLLM instrumentor, which records nothing when CrewAI uses its native providers.

Point the exporter at Maple with the standard OpenTelemetry variables:

```bash
export OTEL_SERVICE_NAME=support-crew
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export CREWAI_DISABLE_TELEMETRY=true
export CREWAI_TRACING_ENABLED=false
```

EU organizations use `https://ingest.eu.maple.dev`. Set the base URL: `OTLPSpanExporter()` with no arguments appends `/v1/traces`. An `endpoint=` passed in code is used as is, so it must end in `/v1/traces`.

The last two variables turn off CrewAI's own pipelines. `CREWAI_DISABLE_TELEMETRY` stops the anonymous analytics export to `telemetry.crewai.com`. `CREWAI_TRACING_ENABLED=false` stops the CrewAI AMP trace uploader and its first-run "view your traces" prompt, which waits for input at the end of a run. Don't use `OTEL_SDK_DISABLED=true`, which CrewAI's telemetry docs also mention: it disables the OpenTelemetry SDK for the whole process, and your Maple traces with it.

Then add a `tracing.py` and import it at the top of your entry point, before you build any crew:

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

What each part does:

- **`enable_genai_semconv=True`** makes both instrumentors write the OpenTelemetry GenAI attributes (`gen_ai.operation.name`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.*`, `gen_ai.tool.*`, `gen_ai.conversation.id`) next to their OpenInference ones when each span ends. Maple's session page reads the GenAI names for CrewAI's agent and tool spans, so without it those spans have no operation or tool details, and model calls have no message transcript. The environment variable `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` does the same if it's set before `instrument()` runs.
- **`CrewAIAgentNames`** fills a gap in the CrewAI instrumentor, which puts the agent's role in the span name and in `graph.node.id` but never in an agent-name attribute. Without it, every agent in a crew shares one lane in Maple.
- **`skip_dep_check=True`** stops an instrumentor from skipping itself, with only an error log, when its version check disagrees with your installed CrewAI or `openai` package.

Both instrumentors patch classes in place, so `instrument()` only has to run before the first `kickoff()`. If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or Sentry), don't create a second one. Add `CrewAIAgentNames()` and the OTLP exporter to the existing provider and pass that provider to `instrument()`.

## Group a conversation into one session

A `Crew` runs its tasks once and returns. There's no thread or session id, and the instrumentors set none: `crew_id` changes with every `Crew` object and `crew_key` is the same for every user of the same crew, so neither works as a conversation id. Maple groups traces into a session by `session.id`, which the instrumentors set only inside OpenInference's `using_session` context manager.

In a chat backend, build the crew per message, put the user's message first in the task description, and run it inside `using_session` with the conversation id your app already stores:

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

Each `kickoff()` is one trace and one turn in the session. CrewAI doesn't remember earlier messages, so pass the history yourself, as above. Maple labels each turn with the first line of the prompt CrewAI builds, `Current Task: <your description>`, which is why the user's message goes first.

Give the crew a `name`. An unnamed crew's root span is `Crew_<uuid>.kickoff`, a different name on every request.

If you skip `using_session`, every message shows up in **Agent Sessions** as its own one-turn session named after its trace id. Setting `gen_ai.conversation.id` on your own spans doesn't help, because Maple reads `session.id` for CrewAI.

`using_session` also works for conversational flows, where CrewAI's own session id is the flow's `state.id`. Use the same value for both:

```py
with using_session(conversation_id):
    reply = support_flow.handle_turn(text, session_id=conversation_id)
```

Each `handle_turn` runs one `kickoff()`, so each message is a trace under the flow's `<FlowName>.kickoff` span.

### Async kickoffs

Use `kickoff()` or `await crew.kickoff_async()`. Don't use `await crew.akickoff()`: it runs a separate native-async code path that the CrewAI instrumentor doesn't patch, so there's no crew or agent span and every model call and tool call becomes its own trace. `kickoff_async()` runs the instrumented `kickoff()` in a thread and keeps the session and trace.

### Streaming

`Crew(stream=True)` returns a `CrewStreamingOutput` right away and runs the crew again in a thread once you iterate it. The instrumentor records both calls, so each streamed message produces two traces: an empty `support.kickoff` and the real one. Wrap the turn in one span of your own so both land in one trace and one turn:

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

`gen_ai.operation.name` makes Maple treat the wrapper as the turn's agent span, so the two crew spans under it don't count as two turns. `LLM(stream=True)` without `Crew(stream=True)` streams inside a single `kickoff()` and needs none of this.

## Record prompts, responses and tool calls

Content capture is on by default. Each model call carries the messages CrewAI sent (the agent's role, goal and backstory as the system message, then `Current Task: …` with the context from earlier tasks) and the model's reply, including tool calls. Agent spans carry the task and its output, and tool spans carry the tool's arguments and result. With the GenAI dual-write on, Maple renders the model calls as the session transcript.

To keep prompts and outputs out of your traces, add the hide switches to the config both instrumentors share:

```py
config = TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)
```

`hide_inputs` drops the input messages and replaces `input.value` with `__REDACTED__`, and `hide_outputs` does the same for outputs. The session keeps its turns, model and tool calls, tokens and failures, with an empty transcript. `hide_input_text` and `hide_output_text` keep the message structure but redact the text. Each switch also has an `OPENINFERENCE_HIDE_*` environment variable.

Agent roles, task names and tool names are always recorded, because they're span names. CrewAI's analytics, if you leave them on, also collect roles and tool names, so keep personal data out of both.

## Tools, errors and agents

Each tool call is a `<tool name>.run` span with `gen_ai.operation.name` `execute_tool` and the tool's name in `gen_ai.tool.name`. A tool that raises is marked failed without extra code: the span ends with status `ERROR` and the exception message, for example `transport data service unavailable (503)`, and Maple counts it on the session and on the tool's page. CrewAI then sends `Error executing tool: …` back to the model, and the agent and crew spans stay `OK` because the crew itself carried on.

Tool spans come from CrewAI's native function calling, which every provider in the table above uses. A model that CrewAI drives with text-based ReAct prompts instead (some custom `BaseLLM` subclasses and LiteLLM models without function calling) runs tools through a path the instrumentor doesn't patch, so those calls have no tool span.

Each task is an agent span named `<role>.<task name>._execute_core`, with `gen_ai.operation.name` `invoke_agent`. `CrewAIAgentNames` gives it the role as `gen_ai.agent.name`, and Maple opens a lane for each agent in the crew. Tasks with `async_execution=True` run in threads; the instrumentor copies the trace context into them, so parallel tasks stay in the same trace as siblings under the crew span.

In a hierarchical crew (`process=Process.hierarchical`), CrewAI adds a manager agent called `Crew Manager` that delegates with the `Delegate work to coworker` and `Ask question to coworker` tools. The delegated work runs through `Agent.execute_task`, which the instrumentor doesn't patch, so the coworker's model calls appear inside the delegation's tool span with no agent span of their own and no lane. The manager's own task is an agent span like any other.

In a flow, `<FlowName>.kickoff` is the root and each `@start`, `@listen` and `@router` method is a `<FlowName>.<method>` span, with any crew or `Agent.kickoff()` it runs nested inside. A flow paused by `@human_feedback` and continued with `flow.resume(...)` continues in a new request, and `resume()` isn't patched, so wrap it in `using_session` with the same id and a span of your own, like the streaming wrapper above.

## Tokens and cost

Every model call carries input and output tokens from the provider's reply, as `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` plus the OpenInference `llm.token_count.*` originals, along with cached and reasoning tokens when the provider reports them. Crew and agent spans carry no usage of their own, so nothing is counted twice. The model is the one the provider returned, such as `openai/gpt-4o-mini` behind OpenRouter.

Streamed calls keep their token counts: CrewAI's OpenAI provider requests `stream_options={"include_usage": True}` whenever it streams.

Maple shows cost only when a span carries one. The OpenAI, Anthropic and Gemini instrumentors never record cost, so those sessions show as **unpriced**, with token counts. LiteLLM computes a price for the models it knows, and the LiteLLM instrumentor records it as `llm.cost.total`, which Maple reads.

`memory=True` and `planning=True` make model calls of their own (memory analysis, embeddings, a planning agent). They appear in the session because they're real, billed calls.

## Flush spans before the process exits

`BatchSpanProcessor` exports every 5 seconds, and the `TracerProvider` flushes from an `atexit` handler on a normal interpreter exit. That covers most scripts and CLIs, but not a killed process, `os._exit`, a frozen serverless instance or a notebook. Flush yourself in those cases:

```py
from tracing import provider

try:
    handle_message("conv-42", "What's the weather in Berlin?", history="")
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

Call `provider.shutdown()` instead when the process is about to exit and won't trace anything else.

## Check that it works

Run one conversation of two or three messages through `handle_message` with the same conversation id, including one that uses a tool, then open **Agent Sessions** in Maple. You should see:

- **One session** for the conversation, with one turn per `kickoff()`. Each turn's trace starts at `support.kickoff` (your crew's name), or `<FlowName>.kickoff` for a flow.
- **The transcript**: the system message built from the agent's role, goal and backstory, `Current Task: …` with your message, and the model's replies.
- **Model calls** named `ChatCompletion` (from the OpenAI instrumentor), each with a model and input and output tokens.
- **Tool calls** named `get_weather.run` and `calculate.run`, with results.
- **Agents**: one lane per role, from `assistant.reply._execute_core` and its siblings.
- **Cost**: unpriced, unless your models go through LiteLLM.

A second conversation with a different id is a second session. If a turn is missing, check that the process flushed.

## Troubleshooting

- **Agent and tool spans, but no model calls or tokens.** The instrumentor for your provider's SDK isn't installed. Match it to the model string with the table above; `openai/…` and `openrouter/…` models need `openinference-instrumentation-openai`, not the LiteLLM one.
- **No spans at all.** `instrument()` never ran, ran after the first kickoff, or skipped itself on its version check. Import `tracing` first, keep `skip_dep_check=True`, and look for an exporter error in the logs. Check that `OTEL_SDK_DISABLED` isn't set.
- **Exports fail with 404.** `OTLPSpanExporter(endpoint=...)` doesn't append `/v1/traces`. Use `OTEL_EXPORTER_OTLP_ENDPOINT` with the base URL, or pass the full path.
- **One session per message.** The kickoff isn't inside `using_session(...)`, or the id changes per request. Wrap every `kickoff()` and use the stored conversation id.
- **Every model call and tool call is its own trace.** The crew runs with `akickoff()`. Use `kickoff()` or `kickoff_async()`.
- **An empty extra turn for each streamed message.** `Crew(stream=True)` runs the crew twice. Wrap the turn in one span, as in [Streaming](#streaming).
- **Agent and tool spans have no details on the session page.** The GenAI dual-write is off. Pass `TraceConfig(enable_genai_semconv=True)` to both instrumentors.
- **All agents in one lane.** `CrewAIAgentNames` isn't on the provider, or it was added to a different provider than the one passed to `instrument()`.
- **Tool arguments show the tool's input schema.** The dual-write copies `tool.parameters`, which is the schema, into `gen_ai.tool.call.arguments`. The call's actual arguments are in the tool span's `input.value`. This is an OpenInference mapping bug with no workaround in the span processor, because the arguments are set after the span starts.
- **A delegated coworker has no lane.** Hierarchical delegation runs the coworker through `Agent.execute_task`, which isn't instrumented. Its model calls are inside the `Delegate work to coworker` tool span.
- **Every model call appears twice.** Two model-layer instrumentors cover the same call, for example LiteLLM's and OpenAI's with a LiteLLM model that calls the `openai` SDK, or `litellm.callbacks=["otel"]` next to an OpenInference instrumentor. Keep one.
- **The process hangs at exit asking about traces.** CrewAI's first-run trace prompt. Set `CREWAI_TRACING_ENABLED=false`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for every other framework.
- [CrewAI telemetry](https://docs.crewai.com/en/telemetry): what CrewAI's own analytics collect and how to turn them off.
- [openinference-instrumentation-crewai](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-crewai): the instrumentor's source.
- [LiteLLM](/docs/agent-tracing/litellm) and [OpenRouter](/docs/agent-tracing/openrouter): if your models go through either gateway.
