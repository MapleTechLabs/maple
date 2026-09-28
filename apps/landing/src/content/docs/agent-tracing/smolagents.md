---
title: "Trace Hugging Face smolagents with OpenTelemetry"
description: "Send smolagents runs to Maple as Agent Sessions, one per conversation, with the transcript, model and tool calls, tokens, failed tools and managed agents in their own lanes."
group: "AI Agents"
order: 25
navLabel: "smolagents"
icon: "huggingface"
---

smolagents has no OpenTelemetry code of its own. Every span comes from OpenInference's `openinference-instrumentation-smolagents`, which patches `MultiStepAgent.run`, each agent step, every model's `generate` and `Tool.__call__`. By default those spans use OpenInference attribute names (`llm.input_messages.0.message.role`, `llm.token_count.prompt`), and every `agent.run()` starts a new trace with no conversation id.

Two defaults have to change for Maple. Maple's session page reads the OpenTelemetry GenAI attributes (`gen_ai.*`) for smolagents, not OpenInference's own, so without the instrumentor's GenAI dual-write the session list shows token counts and the session page shows no transcript. And without `using_session(...)` around each run, a ten-message chat becomes ten one-turn sessions.

This guide covers smolagents 1.26 with `openinference-instrumentation-smolagents` 0.1.40 on Python 3.10 or later, for both `ToolCallingAgent` and `CodeAgent`.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-smolagents](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-smolagents) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for smolagents in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-smolagents -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the instrumentor and export to Maple

```bash
pip install "smolagents[openai]>=1.26" "openinference-instrumentation-smolagents>=0.1.40" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45"
```

Skip the `smolagents[telemetry]` extra from the smolagents docs. It also installs the Arize Phoenix server, which you don't need to send traces to Maple. The `[openai]` extra is for `OpenAIServerModel`; use `[litellm]` if you run `LiteLLMModel`.

Point the exporter at Maple with the standard OpenTelemetry variables:

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

EU organizations use `https://ingest.eu.maple.dev`. Set the base URL, not a signal path: `OTLPSpanExporter()` with no arguments appends `/v1/traces` to `OTEL_EXPORTER_OTLP_ENDPOINT`. If you pass `endpoint=` in code instead, it's used as is, so it has to end in `/v1/traces` or every export gets a 404.

Then add a `tracing.py` and import it at the top of your entry point:

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
    """Fixes what the smolagents instrumentor gets wrong for Maple: agent names, run token totals, tool names and arguments."""

    def on_start(self, span, parent_context=None):
        if span.instrumentation_scope.name != "openinference.instrumentation.smolagents":
            return
        attrs = span.attributes
        if span.name.endswith(".run"):
            # "weather_worker.run" -> gen_ai.agent.name "weather_worker", so sub-agents get lanes
            span.set_attribute("gen_ai.agent.name", span.name.removesuffix(".run"))
            # The run's token totals repeat its model calls (with reset=False, every earlier turn's too)
            span.set_attribute("gen_ai.usage.input_tokens", 0)
            span.set_attribute("gen_ai.usage.output_tokens", 0)
        elif "tool.name" in attrs:
            # Every @tool span is named "SimpleTool"; name it after the tool instead
            span.update_name(f"execute_tool {attrs['tool.name']}")
            # The GenAI dual-write copies the tool's input schema here; record the call's arguments
            if attrs.get("input.value", "").startswith("{"):
                call = json.loads(attrs["input.value"])
                span.set_attribute("gen_ai.tool.call.arguments", json.dumps(call["kwargs"] or call["args"]))


provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(SmolagentsForMaple())
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

SmolagentsInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

What each part does:

- **`enable_genai_semconv=True`** makes the instrumentor write `gen_ai.operation.name`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.*` and `gen_ai.tool.*` next to its OpenInference attributes when each span ends. The environment variable `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` does the same, but only if it's set before `TraceConfig` is built; passing it in code avoids that ordering trap.
- **`SmolagentsForMaple`** fixes four things in the instrumentor's output: it names each agent, zeroes the token totals on run spans (see [Tokens and cost](#tokens-and-cost)), names tool spans after the tool, and records the call's arguments instead of the tool's schema. It runs in `on_start`, before the dual-write, and the dual-write never overwrites a key that's already set.

The instrumentor patches smolagents' classes in place, so import order doesn't matter, as long as `instrument()` runs before the first `agent.run()`. It only patches the model classes smolagents exports. A `Model` subclass of your own that overrides `generate` produces no model spans.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or another library), don't create a second one. Add `SmolagentsForMaple()` and the OTLP exporter to the existing provider and pass that provider to `instrument()`.

## Group a conversation into one session

smolagents has no session, thread or conversation id. Memory lives on the agent object: `agent.run(task, reset=False)` continues the previous conversation, and every call is a new root span and a new trace. Maple groups traces into a session by the `session.id` attribute, and the instrumentor only sets it inside OpenInference's `using_session` context manager:

```py
from openinference.instrumentation import using_session
from smolagents import OpenAIServerModel, ToolCallingAgent

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

Use your app's own conversation id, the one it already stores the chat under. A new UUID per request gives you one session per message again, and a constant gives every user one shared session.

`using_session` stores the id in a Python contextvar, not in OpenTelemetry baggage, and the instrumentor copies it onto every span it creates inside the block, including the model and tool spans of managed agents and of tool calls running in parallel threads. It does not reach spans you create with a plain OpenTelemetry tracer. If you add your own spans, pass `dict(get_attributes_from_context())` (also from `openinference.instrumentation`) as their attributes. `using_attributes(session_id=..., user_id=...)` works the same way and also sets `user.id`.

If you skip this, every `agent.run()` shows up in **Agent Sessions** as its own one-turn session named after its trace id. Setting `gen_ai.conversation.id` yourself doesn't help: Maple reads `session.id` for smolagents.

One agent object per conversation matters for more than tracing. A single module-level agent with `reset=False` shares its memory across every user who talks to it, and its traces would look like one long conversation.

## Record prompts, responses and tool calls

Content capture is on by default. Every model span carries the full message list sent to the model (system prompt, the task, earlier steps, tool results) and the model's reply, and every tool span carries the tool's arguments and result. With the GenAI dual-write on, Maple renders these as the session transcript.

That full message list is large. smolagents' default system prompt is about 3,100 characters for `ToolCallingAgent` and 8,500 for `CodeAgent`, and with `reset=False` every model span repeats the whole conversation so far. Maple has no per-attribute limit, and ingest accepts requests up to 20 MiB.

To keep prompts and outputs out of your traces:

```py
config = TraceConfig(enable_genai_semconv=True, hide_inputs=True, hide_outputs=True)
```

`hide_inputs` drops the input messages and replaces `input.value` with `__REDACTED__`; `hide_outputs` does the same for outputs. The session still shows its turns, model and tool calls, tokens and failures, with an empty transcript. Narrower switches exist: `hide_input_text` and `hide_output_text` keep the message structure but redact the text, and `hide_llm_invocation_parameters` drops temperature and max tokens. Each has an `OPENINFERENCE_HIDE_*` environment variable.

These switches don't cover everything. The run span's `smolagents.task` attribute holds the previous `agent.run()` task in plain text, and the instrumentor doesn't mask it. If prompts can contain personal data, drop `smolagents.task` in an OpenTelemetry Collector with the `attributes` processor, or redact there with the `redaction` processor.

## Tools, errors and managed agents

Each tool call is a span of OpenInference kind `TOOL`, with `gen_ai.operation.name` `execute_tool`, the tool's name in `gen_ai.tool.name` and its return value in `gen_ai.tool.call.result`. smolagents' own `final_answer` is a tool too, so every run that finishes normally ends with an `execute_tool final_answer` span.

A tool that raises is marked failed without extra code. The instrumentor ends the tool span with status `ERROR` and the exception as the status message, for example `RuntimeError: transport data service unavailable (503)`, and Maple counts it on the session and on the tool's page. The enclosing `Step N` span is also marked `ERROR`, with the wrapped `AgentToolExecutionError`, and carries two `exception` events for one failure.

smolagents feeds the error back to the model with "Now let's retry: take care not to repeat previous errors!", so a tool that's down stays down until `max_steps`. You'll see the same failed tool three or four times in one turn, and after `max_steps` the model is asked to answer without tools, which is where it tends to make data up. A `step_callbacks` hook that tells the model to stop after the first failure keeps both the trace and the answer honest.

With `ToolCallingAgent`, a model reply that calls `final_answer` together with another tool raises `AgentExecutionError`, and that step shows as a failed `Step` span even though the run continues. That's the framework rejecting the model's output, not your code failing.

Managed agents (`managed_agents=[...]`) show up as their own `<name>.run` spans under the manager's step, with the managed agent's steps, model calls and tools inside. There's no tool span around the delegation. The `SmolagentsForMaple` processor turns the span name into `gen_ai.agent.name`, and Maple opens a lane for each agent whose name differs from its caller's. Give every agent a `name`; an unnamed agent's span is `ToolCallingAgent.run` or `CodeAgent.run`, and two unnamed agents share one lane.

When a `ToolCallingAgent` model asks for several tools or managed agents in one reply, smolagents runs them in a thread pool (`max_tool_threads`) and copies the context into each thread, so parallel workers stay in the same trace and session.

`CodeAgent` calls tools from the Python code the model writes, run by `LocalPythonExecutor` in your process. Those calls produce the same tool spans; positional arguments are recorded as a JSON array, like `["Berlin"]`. With a remote executor (`executor_type="e2b"`, `"docker"`, `"modal"` and others), the code and its tool calls run outside your process, so there are no tool spans, only the model and step spans.

Two gaps remain in what Maple can show for smolagents tools. Tool spans have no `gen_ai.tool.call.id`, because smolagents doesn't pass the model's tool call id to the tool, so Maple can't link a tool span to the exact call in the model's reply. And the step's failure and the tool's failure are both on the trace, so a session with one broken tool has two failed spans.

## Tokens and cost

Every model span carries input and output tokens from the provider's reply, as `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` plus the OpenInference `llm.token_count.*` originals. The instrumentor doesn't record cached or reasoning tokens, even when the provider reports them. The model is the id you passed, `gen_ai.request.model` `gpt-4o-mini` or `openai/gpt-4o-mini`; smolagents doesn't record the model name the provider returns.

The provider comes from the model class, not the model: `OpenAIServerModel` is always `openai`, even for an Anthropic model behind OpenRouter. The model span is named after the class too: `OpenAIServerModel` is an alias of `OpenAIModel`, so its spans are `OpenAIModel.generate`.

Streaming (`stream_outputs=True` on the agent) produces `OpenAIModel.generate_stream` spans. smolagents requests `stream_options={"include_usage": True}` for `OpenAIServerModel`, `LiteLLMModel` and `InferenceClientModel`, so streamed calls from those keep their token counts.

The instrumentor also copies the agent monitor's token totals onto each `<name>.run` span. Those totals repeat the model spans below it, and with `reset=False` the monitor is never reset, so turn four's run span carries the tokens of turns one to four. Maple can't net them against the model calls, because a `Step N` span sits in between. In our test, a four-turn conversation with 7,675 input tokens of model calls had another 15,626 on its run spans. `SmolagentsForMaple` sets `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` to 0 on run spans. Maple reads those before OpenInference's `llm.token_count.*`, so each model call is counted once, and the OpenInference totals stay on the span for other tools.

Maple shows cost only when a span carries one, and smolagents never records cost. Sessions show as **unpriced**, with token counts.

Don't add `openinference-instrumentation-openai` or `openinference-instrumentation-litellm` next to the smolagents instrumentor. Neither checks for an existing model span, so every `OpenAIModel.generate` or `LiteLLMModel.generate` span gets a second model span under it for the same request.

## Flush spans before the process exits

`BatchSpanProcessor` exports every 5 seconds. The `TracerProvider` registers an `atexit` handler that flushes on a normal interpreter exit, which covers most scripts and CLIs. It doesn't run when the process is killed, calls `os._exit`, or is frozen between serverless invocations, and a notebook never exits. Flush yourself in those cases:

```py
from tracing import provider

try:
    handle_message("conv-42", "What's the weather in Berlin?")
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

Call `provider.shutdown()` instead of `force_flush()` when the process is about to exit and won't trace anything else.

## Check that it works

Run one conversation of two or three messages through `handle_message` with the same conversation id, including one that uses a tool, then open **Agent Sessions** in Maple. You should see:

- **One session** for the conversation, framework **smolagents**, with one turn per `agent.run()`. Turn traces start at `assistant.run` (your agent's name).
- **The transcript**: your messages and the model's replies. smolagents sends each task to the model as `New task:` followed by your text, and tool results come back as `tool-response` messages.
- **Model calls** named `OpenAIModel.generate` (or `LiteLLMModel.generate`, `InferenceClientModel.generate`), each with a model, input and output tokens.
- **Tool calls** named `execute_tool get_weather` and `execute_tool final_answer`, with arguments and results.
- **Agents**: `assistant`, plus one lane per managed agent if you use them.
- **Cost**: unpriced.

A second conversation with a different id is a second session. If a turn is missing, check that the process flushed.

## Troubleshooting

- **No spans at all.** `instrument()` never ran, or ran after the agent was used. Import `tracing` first in the entry point and look for an `OTLPSpanExporter` error in the logs.
- **Exports fail with 404.** `OTLPSpanExporter(endpoint=...)` doesn't append `/v1/traces`. Use `OTEL_EXPORTER_OTLP_ENDPOINT` with the base URL, or pass the full path.
- **Tokens in the list, empty session page.** The GenAI dual-write is off. Pass `TraceConfig(enable_genai_semconv=True)`, or set `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` before `instrument()` runs.
- **One session per message.** The run isn't inside `using_session(...)`, or the id changes per request. Wrap every `agent.run()` and use the stored conversation id.
- **Two users in one session.** A shared agent object with `reset=False`, or a constant session id. Keep one agent and one id per conversation.
- **Every tool span is named `SimpleTool`.** `@tool` functions all become instances of a class called `SimpleTool`, and the instrumentor names tool spans after the class. `SmolagentsForMaple` renames them; `gen_ai.tool.name` has the real name either way.
- **Tool arguments show the tool's input schema.** The dual-write copies `tool.parameters`, the schema, into `gen_ai.tool.call.arguments`. `SmolagentsForMaple` replaces it with the call's arguments.
- **No lanes for managed agents.** The instrumentor puts the agent's name only in the span name. Add `SmolagentsForMaple` and give each agent a `name`.
- **A failing tool appears three or four times.** smolagents tells the model to retry after every error, up to `max_steps`. Stop it with a `step_callbacks` hook or a lower `max_steps`.
- **Session tokens are about double the model calls, or grow faster every turn.** The run spans' token totals are being counted. Keep the two zero-token lines for `.run` spans in `SmolagentsForMaple`.
- **Every model call appears twice.** A provider instrumentor (`openinference-instrumentation-openai` or `-litellm`) is also installed. Remove it.
- **No tool spans with `CodeAgent`.** A remote executor runs the generated code outside your process. Only `LocalPythonExecutor` produces tool spans.
- **A custom model class has no model spans.** The instrumentor only patches the model classes smolagents exports. Subclass one of them without overriding `generate`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for every other framework.
- [Inspecting runs with OpenTelemetry](https://huggingface.co/docs/smolagents/tutorials/inspect_runs): the smolagents docs page on tracing.
- [openinference-instrumentation-smolagents](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-smolagents): the instrumentor's source.
- [LiteLLM](/docs/agent-tracing/litellm) and [OpenRouter](/docs/agent-tracing/openrouter): if your models go through either gateway.
