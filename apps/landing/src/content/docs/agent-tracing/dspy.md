---
title: "Trace DSPy programs and ReAct agents with OpenTelemetry"
description: "Send DSPy programs to Maple as Agent Sessions, one per conversation, with the transcript, model and tool calls, tokens, cost and failed tools, including modules that run in dspy.Parallel."
group: "AI Agents"
order: 27
navLabel: "DSPy"
icon: "python"
---

DSPy has no OpenTelemetry code of its own. Spans come from OpenInference's `openinference-instrumentation-dspy`, which patches `Module.__call__`, `Predict.forward`, the adapters, `LM.__call__` and `Tool.__call__`. That gives you the shape of a program (which module called which predictor, which tool ran, what the model was sent), but no token counts, no tool names and no conversation id.

The usual fix for the missing tokens, adding `openinference-instrumentation-litellm`, stopped working in DSPy 3.4. Most models now run on DSPy's own `lm15` engine instead of LiteLLM, so the LiteLLM instrumentor records nothing: in our test, a call to `openrouter/openai/gpt-4o-mini` produced zero LiteLLM spans. This guide fills the gaps with a DSPy callback instead, which works on both engines.

This guide covers DSPy 3.4 with `openinference-instrumentation-dspy` 0.1.45 on Python 3.10 or later, for `dspy.ReAct` agents and your own `dspy.Module` programs.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-dspy](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-dspy) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for DSPy in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-dspy -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the instrumentor and export to Maple

```bash
pip install "dspy>=3.4" "openinference-instrumentation-dspy>=0.1.45" "openinference-instrumentation>=0.1.66" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45" \
  "opentelemetry-instrumentation-threading>=0.66b0"
```

Point the exporter at Maple with the standard OpenTelemetry variables:

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

EU organizations use `https://ingest.eu.maple.dev`. Set the base URL: `OTLPSpanExporter()` with no arguments appends `/v1/traces`. An `endpoint=` passed in code is used as is and has to end in `/v1/traces`.

Add a `tracing.py` and import it at the top of your entry point, before your DSPy modules are defined:

```py
# tracing.py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.dspy import DSPyInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.threading import ThreadingInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

DSPyInstrumentor().instrument(tracer_provider=provider, config=TraceConfig(enable_genai_semconv=True))
ThreadingInstrumentor().instrument()
```

- **`enable_genai_semconv=True`** makes the instrumentor also write the OpenTelemetry GenAI attributes (`gen_ai.operation.name`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.tool.call.result`) when each span ends. Maple's session page reads those for DSPy, not the OpenInference originals, so without it the session page has no transcript and no model. `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` does the same if it's set before `instrument()` runs.
- **`ThreadingInstrumentor`** carries the trace context into threads. `dspy.Parallel`, `Evaluate` and a plain `ThreadPoolExecutor` start every worker without it, so each worker becomes its own trace with no parent and no session (see [Parallel modules](#parallel-modules-stay-in-one-trace)).

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or another library), don't create a second one. Add the OTLP exporter to the existing provider and pass that provider to `instrument()`.

### Add the Maple callback

The instrumentor leaves out four things Maple needs: tokens and cost on model spans, tool names and arguments on tool spans, an agent span per program, and a way to tell DSPy's adapter spans apart from model calls. A DSPy callback runs inside each of those spans, so it can add them. Save this as `maple_dspy.py`:

```py
# maple_dspy.py
import json

import dspy
from dspy.utils.callback import BaseCallback
from openinference.instrumentation import TraceConfig
from opentelemetry import trace

# Same switches as the instrumentor: OPENINFERENCE_HIDE_INPUTS / OPENINFERENCE_HIDE_OUTPUTS.
_config = TraceConfig()


def _message(role, values):
    text = "\n".join(v for v in values if isinstance(v, str))
    return json.dumps([{"role": role, "parts": [{"type": "text", "content": text}]}]) if text else None


class MapleCallback(BaseCallback):
    """Adds what Maple reads and the OpenInference DSPy instrumentor leaves out:
    an agent span per program, tool names and arguments, tokens and cost."""

    def __init__(self):
        self._agents = set()
        self._lms = {}

    def on_module_start(self, call_id, instance, inputs):
        if type(instance).__module__.startswith("dspy."):
            return  # Predict, ChainOfThought, ReAct: building blocks, not agents
        self._agents.add(call_id)
        span = trace.get_current_span()
        span.set_attribute("gen_ai.operation.name", "invoke_agent")
        span.set_attribute("gen_ai.agent.name", type(instance).__name__)
        user = _message("user", [*inputs.get("args", ()), *inputs.get("kwargs", {}).values()])
        if user and not _config.hide_inputs:
            span.set_attribute("gen_ai.input.messages", user)

    def on_module_end(self, call_id, outputs, exception):
        if call_id not in self._agents:
            return
        self._agents.discard(call_id)
        if isinstance(outputs, dspy.Prediction) and not _config.hide_outputs:
            reply = _message("assistant", [v for k, v in outputs.items() if k != "reasoning"])
            if reply:
                trace.get_current_span().set_attribute("gen_ai.output.messages", reply)

    def on_adapter_format_start(self, call_id, instance, inputs):
        # The span is "ChatAdapter.__call__"; without an operation, "chat" in the name reads as a model call.
        trace.get_current_span().set_attribute("gen_ai.operation.name", "invoke_workflow")

    def on_tool_start(self, call_id, instance, inputs):
        span = trace.get_current_span()
        span.set_attribute("gen_ai.tool.name", instance.name)
        span.set_attribute("gen_ai.tool.description", instance.desc or "")
        if not _config.hide_inputs:
            span.set_attribute("gen_ai.tool.call.arguments", json.dumps(inputs.get("kwargs", {}), default=str))

    def on_lm_start(self, call_id, instance, inputs):
        self._lms[call_id] = instance

    def on_lm_end(self, call_id, outputs, exception):
        lm = self._lms.pop(call_id, None)
        # The LM's history holds the provider response. Threads share the LM, so match ours by identity.
        entry = next((e for e in reversed(lm.history[-16:]) if e["outputs"] is outputs), None) if lm else None
        if entry is None or getattr(entry["response"], "cache_hit", False):
            return  # history is off, or a cache hit that cost nothing
        usage = entry["usage"] or {}
        attributes = {
            "gen_ai.response.id": getattr(entry["response"], "id", None),
            "gen_ai.response.model": entry.get("response_model"),
            "gen_ai.usage.input_tokens": usage.get("prompt_tokens"),
            "gen_ai.usage.output_tokens": usage.get("completion_tokens"),
            "gen_ai.usage.cache_read.input_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            "gen_ai.usage.reasoning.output_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
            "gen_ai.usage.cost": entry.get("cost"),
        }
        trace.get_current_span().set_attributes({k: v for k, v in attributes.items() if v is not None})
```

Register it with the rest of your DSPy configuration:

```py
import tracing  # first: sets up the provider and patches DSPy

import dspy
from maple_dspy import MapleCallback

dspy.configure(lm=dspy.LM("openai/gpt-4o-mini", temperature=0), callbacks=[MapleCallback()])
```

The callback works because the instrumentor patches DSPy's classes from the outside, so DSPy's own callback hooks run while the instrumentor's span is the current one. Any `dspy.Module` subclass you write becomes an agent in Maple, named after its class. DSPy's built-in modules (`Predict`, `ChainOfThought`, `ReAct`) stay plain steps inside it. The GenAI dual-write never overwrites a key that's already set, so the callback's values win.

### Why not MLflow or the OpenTelemetry DSPy package

DSPy's documented tracing path is `mlflow.dspy.autolog()`. MLflow can export OTLP and translate to GenAI attributes (`MLFLOW_ENABLE_OTEL_GENAI_SEMCONV`, MLflow 3.11 and later), but it pulls in the whole MLflow package, its GenAI mapping is documented for provider SDK spans, and it has no conversation id Maple can read.

The OpenTelemetry project published `opentelemetry-instrumentation-genai-dspy` on 24 September 2026 as a 1.2 beta. It emits GenAI attributes directly, but only for tools, ReAct loops and retrieval. It records no model calls, and relies on a provider instrumentor for those, which DSPy 3.4's native engine bypasses. Maple also identifies DSPy by the OpenInference instrumentor, so its spans would show as an unidentified framework. We'll revisit it once it covers model calls.

## Group a conversation into one session

DSPy has no session, thread or conversation id. A chat program takes the conversation as a `dspy.History` input field, and every call to your module is a new root span and a new trace. Maple groups a DSPy program's traces into one session by the `session.id` attribute, which the instrumentor only sets inside OpenInference's `using_session` context manager:

```py
import dspy
from openinference.instrumentation import using_session


class ChatAssistant(dspy.Module):
    def __init__(self):
        super().__init__()
        self.respond = dspy.ReAct(
            "question: str, conversation: dspy.History -> answer: str",
            tools=[get_weather, calculate],
        )

    def forward(self, question, conversation):
        return self.respond(question=question, conversation=conversation)


assistant = ChatAssistant()


def handle_message(conversation_id: str, question: str, turns: list[dict]) -> str:
    with using_session(conversation_id):
        answer = assistant(question=question, conversation=dspy.History(messages=turns)).answer
    turns.append({"question": question, "answer": answer})
    return answer
```

Use your app's own conversation id, the one it stores the chat under. A new UUID per request gives you one session per message, and a constant gives every user one shared session. `using_session` puts the id in the OpenTelemetry context, and the instrumentor copies it onto every span it creates inside the block, including spans in worker threads once `ThreadingInstrumentor` is on.

If you skip this, every call to your module shows up in **Agent Sessions** as its own one-turn session named after its trace id. The GenAI dual-write also copies `session.id` into `gen_ai.conversation.id`, but that key alone doesn't group anything: Maple reads `session.id` for DSPy.

Don't store the conversation on the module as `self.history`. DSPy appends every model call to a list attribute named `history` on each calling module, so a `dspy.History` there crashes the first model call with `TypeError: object of type 'History' has no len()`. Pass it as an input field, or name the attribute something else.

## Stream replies with dspy.streamify

A streamed turn is traced like any other: same session, same spans, tokens and cost on every model call. Two details decide whether that holds. Here is a streaming handler you can return from an SSE or WebSocket endpoint:

```py
stream_assistant = dspy.streamify(assistant, stream_listeners=[dspy.streaming.StreamListener("answer")])


async def stream_message(conversation_id: str, question: str, turns: list[dict]):
    with using_session(conversation_id):
        async for chunk in stream_assistant(question=question, conversation=dspy.History(messages=turns)):
            if isinstance(chunk, dspy.streaming.StreamResponse):
                yield chunk.chunk
            elif isinstance(chunk, dspy.Prediction):
                turns.append({"question": question, "answer": chunk.answer})
```

- **Call `dspy.streamify` after `dspy.configure(callbacks=[MapleCallback()])`.** `streamify` copies the callback list at the moment you call it. A streamed program built at import time, before `configure` runs, streams without the callback: no tokens, no tool names, and every `ChatAdapter.__call__` counted as a model call.
- **Put `using_session` around the loop that reads the stream.** The program doesn't start until the first chunk is requested. If the `with` block only wraps the `stream_assistant(...)` call, for example in an endpoint that returns `StreamingResponse(stream_assistant(...))`, it has already exited when the model runs, and the turn lands in a session of its own.

DSPy asks the provider for usage on streamed calls, so the streamed `LM.__call__` span has input and output tokens and cost. In our test, the streamed answer to "What is the capital of France?" recorded 341 input and 47 output tokens. Two things are missing on streamed calls: `gen_ai.response.id`, because DSPy's native engine doesn't keep the id from a stream, and a time-to-first-token attribute, which nothing in this setup records.

## Record prompts, responses and tool calls

Content capture is on by default. Every `LM.__call__` span carries the messages DSPy's adapter sent to the model (the signature's instructions as the system message, then the formatted fields) and the raw reply, and every tool span carries the tool's arguments and result. The callback adds a short user and assistant message on each agent span, built from your module's string inputs and outputs, which Maple uses as the turn's title.

The model messages look like DSPy's prompt format, not like a chat: the user message starts with `[[ ## question ## ]]` and the reply with `[[ ## next_thought ## ]]` or `[[ ## answer ## ]]`. That's what the model actually saw. A `dspy.History` input is expanded into earlier user and assistant messages, so each call repeats the whole conversation so far.

To keep prompts and outputs out of your traces, set the instrumentor's switches, which the callback also reads:

```bash
export OPENINFERENCE_HIDE_INPUTS=true
export OPENINFERENCE_HIDE_OUTPUTS=true
```

The session still shows its turns, model and tool calls, tokens and failures, with an empty transcript and no tool arguments or results. Set them before `tracing.py` runs. Narrower switches (`OPENINFERENCE_HIDE_INPUT_TEXT`, `OPENINFERENCE_HIDE_OUTPUT_TEXT`, `OPENINFERENCE_HIDE_LLM_INVOCATION_PARAMETERS`) redact parts of each message; the callback's agent messages follow only the two above.

## Tools, errors and sub-agents

Each tool call is a span named `<tool>.__call__`, of OpenInference kind `TOOL` and `gen_ai.operation.name` `execute_tool`. The callback adds `gen_ai.tool.name`, the tool's docstring as `gen_ai.tool.description`, and its arguments. `dspy.ReAct` also calls a built-in `finish` tool when it's done, so every ReAct run ends with a `finish.__call__` span, and `finish` shows up in Maple's tool list.

A tool that raises is marked failed with no extra code. The instrumentor ends the tool span with status `ERROR` and the exception as the status message, for example `RuntimeError: transport data service unavailable (503)`, and Maple counts it on the session and on the tool's page. `ReAct` catches the exception and hands `Execution error in fetch_transport_data: ...` back to the model, so the `ReAct.forward` span and your module's span stay `OK`, and the program's return value doesn't tell you the tool failed.

Tool spans have no `gen_ai.tool.call.id`. `ReAct` asks the model for the next tool as text fields (`next_tool_name`, `next_tool_args`), not through the provider's tool-calling API, so there's no id to link.

DSPy's idiom for sub-agents is module composition: an orchestrator module that calls worker modules. With the callback, every module class you wrote is an `invoke_agent` span with its class name as `gen_ai.agent.name`, and Maple opens a lane for each agent whose name differs from its caller's. Name the classes after what they do (`WeatherWorker`, `BudgetWorker`); two instances of one class share a name and a lane.

### Parallel modules stay in one trace

`dspy.Parallel` runs modules in a `ThreadPoolExecutor` and copies only DSPy's own settings into each worker thread, not the OpenTelemetry context. Without `ThreadingInstrumentor`, each worker's spans start a new trace with no parent and no `session.id`: in our test, a three-worker fan-out became four traces, with 61 of 73 spans outside the trace that started them, including the only failed tool. With it, the same program is one trace and one session:

```py
class Briefing(dspy.Module):
    def __init__(self):
        super().__init__()
        self.weather = WeatherWorker()
        self.transport = TransportWorker()

    def forward(self, city):
        weather, transport = dspy.Parallel(num_threads=2)(
            [(self.weather, {"city": city}), (self.transport, {"city": city})]
        )
        return dspy.Prediction(briefing=f"{weather.findings}\n{transport.findings}")
```

The same applies to your own `ThreadPoolExecutor` and `threading.Thread`. `ThreadingInstrumentor` doesn't reach `multiprocessing`; a module that runs in another process starts its own trace.

## Tokens and cost

The instrumentor records no token counts. The callback reads them from the provider response DSPy keeps in `lm.history` and writes them on the `LM.__call__` span: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, cached input tokens and reasoning tokens when the provider reports them, plus `gen_ai.response.id` and the model the provider answered with.

Three cases have no tokens on the span:

- **Cache hits.** `dspy.LM` caches responses by default (`cache=True`). A repeated prompt is answered from the cache with no provider call, so the callback records nothing for it. Pass `cache=False` while you're checking the numbers.
- **History turned off.** `dspy.configure(disable_history=True)` or `max_history_size=0` stops DSPy from keeping the response the callback reads.
- **A custom engine.** An `LM` with your own `engine=` reports whatever usage your engine puts on its response.

Cost is DSPy's own estimate, the `cost` field of each history entry, written as `gen_ai.usage.cost`. On the `lm15` engine DSPy prices tokens from its bundled model metadata; on the LiteLLM engine it's LiteLLM's `response_cost`. Maple never prices tokens itself, so when DSPy has no price for a model, that call shows as **unpriced**. Treat the figure as an estimate, not your bill.

Don't add `openinference-instrumentation-litellm` or `-openai` next to this setup. On DSPy 3.4's native engine they record nothing. On the LiteLLM engine (`dspy.LM(..., engine="litellm")`, and Anthropic models by default) they add a second model span under every `LM.__call__`, and Maple counts each call twice.

## Flush spans before the process exits

`BatchSpanProcessor` exports every 5 seconds. The `TracerProvider` flushes on a normal interpreter exit, which covers most scripts and CLIs. That doesn't happen when the process is killed, calls `os._exit`, or is frozen between serverless invocations, and a notebook never exits. Flush yourself in those cases:

```py
from tracing import provider

try:
    handle_message("conv-42", "What's the weather in Berlin?", turns=[])
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

Call `provider.shutdown()` instead when the process is about to exit and won't trace anything else. DSPy optimizers (`MIPROv2`, `GEPA`, `BootstrapFewShot`) and `dspy.Evaluate` make hundreds of calls; trace them in a separate service name or not at all, so they don't bury your production sessions.

## Check that it works

Run one conversation of two or three messages through `handle_message` with the same conversation id, including one that uses a tool, with `cache=False` on the LM. Then open **Agent Sessions** in Maple. You should see:

- **One session** for the conversation, framework **DSPy**, with one turn per call to your module. Each turn's trace starts at `ChatAssistant.forward` (your module's class name), titled with the question you asked.
- **Model calls** named `LM.__call__`, each with a model, input and output tokens. Every model call sits under `Predict.forward`, `Predict(StringSignature).forward` and `ChatAdapter.__call__` spans; those are DSPy's steps, not extra calls.
- **The transcript**: the messages DSPy sent, in its `[[ ## field ## ]]` format, and the replies.
- **Tool calls** named `get_weather.__call__` and `finish.__call__`, with arguments and results. `finish` is ReAct's end-of-loop tool and counts as a tool call, so a turn that used one tool shows two.
- **Agents**: one per module class you wrote, with a lane for each worker module.
- **Cost** per call where DSPy has a price for the model.
- **Checks**: a tool that raised fails the session's **Tool availability** check, with the exception as its headline.

A second conversation with a different id is a second session. If a turn is missing, check that the process flushed.

Expect a **Prompt cache** warning on a short test conversation. OpenRouter reports cached input tokens even when they're zero, so Maple judges the cache hit rate, and providers only cache long prompts (OpenAI from 1,024 tokens; Anthropic models only with explicit cache markers). In our test the prompts peaked at 870 tokens and none were cached.

## Troubleshooting

- **No spans at all.** `instrument()` never ran, or the exporter can't reach Maple. Import `tracing` first in the entry point and look for an `OTLPSpanExporter` error in the logs.
- **Exports fail with 404.** `OTLPSpanExporter(endpoint=...)` doesn't append `/v1/traces`. Use `OTEL_EXPORTER_OTLP_ENDPOINT` with the base URL, or pass the full path.
- **Tokens in the list, empty session page.** The GenAI dual-write is off. Pass `TraceConfig(enable_genai_semconv=True)` to `instrument()`.
- **No tokens anywhere.** `MapleCallback` isn't registered, a later `dspy.configure(callbacks=[...])` or `dspy.context(callbacks=[...])` replaced it, or the calls were cache hits.
- **One session per message.** The call isn't inside `using_session(...)`, or the id changes per request.
- **A streamed turn has no tokens, or is a session of its own.** `dspy.streamify` ran before `dspy.configure(callbacks=[MapleCallback()])`, or `using_session` exits before the stream is read. See [Stream replies](#stream-replies-with-dspystreamify).
- **`dspy.Parallel` workers are separate traces with no session.** `ThreadingInstrumentor().instrument()` didn't run. It has to run before the worker threads start.
- **`TypeError: object of type 'History' has no len()`.** A module attribute is named `history`. Rename it, or pass the `dspy.History` as an input field.
- **Every model call counted twice.** A LiteLLM or OpenAI instrumentor is also installed, or the callback isn't registered and `ChatAdapter.__call__` is read as a model call by its name. Remove the extra instrumentor and register the callback.
- **A `finish` tool in every run.** That's `dspy.ReAct`'s built-in tool for ending the loop, not one of yours.
- **Your module shows `OK` after a tool failed.** `ReAct` turns tool exceptions into text for the model. The failed tool span is still marked `ERROR` and counted.
- **Two spans for one step after a parse error.** When `ChatAdapter` can't parse a reply, DSPy retries with `JSONAdapter`, so one `Predict` span holds two adapter spans, each with its own `LM.__call__`. Both calls happened and both are billed.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for every other framework.
- [DSPy observability](https://dspy.ai/tutorials/observability/): DSPy's own tracing page, built on MLflow.
- [openinference-instrumentation-dspy](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-dspy): the instrumentor's source.
- [DSPy's `BaseCallback`](https://github.com/stanfordnlp/dspy/blob/main/dspy/utils/callback.py): the hook API `MapleCallback` builds on.
- [LiteLLM](/docs/agent-tracing/litellm) and [OpenRouter](/docs/agent-tracing/openrouter): if your models go through either gateway.
