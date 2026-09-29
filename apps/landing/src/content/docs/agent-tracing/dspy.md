---
title: "Trace DSPy programs and ReAct agents with OpenTelemetry"
description: "Send DSPy programs to Maple as one Agent Session per conversation, with transcript, model and tool calls, tokens and cost."
group: "AI Agents"
order: 27
navLabel: "DSPy"
icon: "python"
---

DSPy has no tracing of its own. OpenInference's `openinference-instrumentation-dspy` records a span for every module, predictor, model call and tool call, but no token counts, no tool names and no conversation id. You add the first two with a small DSPy callback, and the conversation id by wrapping each call in `using_session`.

Tested with DSPy 3.4 and `openinference-instrumentation-dspy` 0.1.45 on Python 3.10 or later.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-dspy](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-dspy) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for DSPy in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-dspy -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is under **Settings → Ingestion**.

## Install and point the exporter at Maple

```bash
pip install "dspy>=3.4" "openinference-instrumentation-dspy>=0.1.45" "openinference-instrumentation>=0.1.66" \
  "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45" \
  "opentelemetry-instrumentation-threading>=0.66b0"
```

```bash
export OTEL_SERVICE_NAME=support-agent
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

EU organizations use `https://ingest.eu.maple.dev`. Set the base URL only; the exporter appends `/v1/traces`.

## Initialize tracing

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

`enable_genai_semconv=True` writes the `gen_ai.*` attributes Maple's session page reads. Without it the session has no transcript and no model. `ThreadingInstrumentor` keeps `dspy.Parallel`, `Evaluate` and thread pool workers in the caller's trace and session.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or another library), add the OTLP exporter to that one and pass it to `instrument()` instead of creating a second.

## Add the Maple callback

The callback adds tokens and cost to model spans, names and arguments to tool spans, and an agent span for each module class you wrote. Save it as `maple_dspy.py`:

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

Every `dspy.Module` subclass you write becomes an agent in Maple, named after its class. Built-in modules like `Predict` and `ReAct` stay steps inside it. Give worker modules descriptive class names (`WeatherWorker`) so each gets its own lane.

## Group a conversation into one session

Each call to your module starts a new trace. Maple joins them into one session by `session.id`, which the instrumentor sets inside OpenInference's `using_session` block:

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

Use the id your app stores the chat under. A new UUID per request gives one session per message, and a constant puts every user in one session.

If you stream with `dspy.streamify`, call it after `dspy.configure(callbacks=[MapleCallback()])`, since it copies the callback list when called. Put `using_session` around the loop that reads the stream, because the program only starts on the first chunk.

To keep prompts and outputs out of your traces, set `OPENINFERENCE_HIDE_INPUTS=true` and `OPENINFERENCE_HIDE_OUTPUTS=true` before `tracing.py` runs. The callback follows both.

## Flush before short-lived processes exit

`BatchSpanProcessor` exports every 5 seconds and flushes on a normal exit. A killed process, a serverless handler or a notebook needs an explicit flush:

```py
from tracing import provider

try:
    handle_message("conv-42", "What's the weather in Berlin?", turns=[])
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

## Check that it works

Run a conversation of two or three messages through `handle_message` with one conversation id, including one tool call, with `cache=False` on the LM so every call reaches the provider. In **Agent Sessions** you should see one session with framework **DSPy** and one turn per call, each starting at `ChatAssistant.forward`.

Model calls are `LM.__call__` spans with a model and tokens. The transcript uses DSPy's `[[ ## field ## ]]` prompt format. Tool calls include `finish.__call__`, which is `dspy.ReAct`'s built-in end-of-loop tool. Cost is DSPy's own estimate, and models DSPy has no price for show as **unpriced**.

## Troubleshooting

- **No spans, or exports fail with 404.** Import `tracing` first. An `endpoint=` passed in code must end in `/v1/traces`; the env variable takes the base URL.
- **Tokens in the list, empty session page.** Pass `TraceConfig(enable_genai_semconv=True)` to `instrument()`.
- **No tokens anywhere.** `MapleCallback` isn't registered, a later `dspy.configure(callbacks=[...])` replaced it, or the calls were cache hits.
- **One session per message.** The call runs outside `using_session(...)`, or the id changes per request.
- **Every model call counted twice.** Remove `openinference-instrumentation-litellm` or `-openai`; the callback already records model calls.
- **`TypeError: object of type 'History' has no len()`.** A module attribute is named `history`. Rename it, or pass the `dspy.History` as an input field.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for every other framework.
- [DSPy observability](https://dspy.ai/tutorials/observability/): DSPy's own tracing page, built on MLflow.
- [openinference-instrumentation-dspy](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-dspy): the instrumentor's source.
- [DSPy's `BaseCallback`](https://github.com/stanfordnlp/dspy/blob/main/dspy/utils/callback.py): the hook API `MapleCallback` builds on.
- [LiteLLM](/docs/agent-tracing/litellm) and [OpenRouter](/docs/agent-tracing/openrouter): if your models go through either gateway.
