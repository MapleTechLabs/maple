---
title: "Trace DSPy programs and ReAct agents with OpenTelemetry"
description: "Send DSPy programs to Maple as one Agent Session per conversation, with transcript, model and tool calls, tokens and cost."
group: "AI Agents"
order: 27
navLabel: "DSPy"
icon: "python"
---

This guide traces DSPy with OpenInference's DSPy instrumentor, adds tokens and tool names with a small DSPy callback, and groups each conversation into one session with `using_session`.

Tested with DSPy 3.4 and `openinference-instrumentation-dspy` 0.1.45 on Python 3.10 or later.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-dspy](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-dspy) skill and follows it.

```text
Set up Maple agent tracing for DSPy in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-dspy -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

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

`ThreadingInstrumentor` keeps `dspy.Parallel` and thread pool workers in the caller's session.

If the app already has a `TracerProvider` (from `opentelemetry-instrument`, Logfire or another library), add the OTLP exporter to it and pass it to `instrument()` instead of creating a second one.

## Add the Maple callback

The callback adds tokens, cost, tool names and agent spans. Save it as `maple_dspy.py`:

```py
# maple_dspy.py
import json

import dspy
from dspy.utils.callback import BaseCallback
from openinference.instrumentation import TraceConfig
from opentelemetry import trace

_config = TraceConfig()


def _message(role, values):
    text = "\n".join(v for v in values if isinstance(v, str))
    return json.dumps([{"role": role, "parts": [{"type": "text", "content": text}]}]) if text else None


class MapleCallback(BaseCallback):
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
import tracing  # must come first

import dspy
from maple_dspy import MapleCallback

dspy.configure(lm=dspy.LM("openai/gpt-4o-mini", temperature=0), callbacks=[MapleCallback()])
```

Every `dspy.Module` subclass you write shows up as an agent named after its class, so give worker modules descriptive names like `WeatherWorker`.

## Group a conversation into one session

Each call to your module is its own trace. Wrap every call in `using_session` with the conversation id to group them into one session:

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

If you stream with `dspy.streamify`, call it after `dspy.configure(callbacks=[MapleCallback()])`, and put `using_session` around the loop that reads the stream.

To keep prompts and outputs out of your traces, set `OPENINFERENCE_HIDE_INPUTS=true` and `OPENINFERENCE_HIDE_OUTPUTS=true` before `tracing.py` runs. The callback follows both.

## Flush before short-lived processes exit

Serverless handlers, notebooks and processes that get killed need an explicit flush:

```py
from tracing import provider

try:
    handle_message("conv-42", "What's the weather in Berlin?", turns=[])
finally:
    provider.force_flush()  # serverless: before returning; notebooks: after each run
```

## Check that it works

Set `cache=False` on the LM, then run two or three messages through `handle_message` with one conversation id, including one tool call. In **Agent Sessions** you should see one session with framework **DSPy**, one turn per call, and `LM.__call__` model calls with tokens. `finish.__call__` is `dspy.ReAct`'s built-in end-of-loop tool.

## Troubleshooting

- **No spans, or exports fail with 404.** Import `tracing` first. An `endpoint=` passed in code must end in `/v1/traces`; the env variable takes the base URL.
- **No tokens anywhere.** `MapleCallback` isn't registered, a later `dspy.configure(callbacks=[...])` replaced it, or the calls were cache hits.
- **One session per message.** The call runs outside `using_session(...)`, or the id changes per request.
- **Every model call counted twice.** Remove `openinference-instrumentation-litellm` or `-openai`; the callback already records model calls.
- **`TypeError: object of type 'History' has no len()`.** A module attribute is named `history`. Rename it, or pass the `dspy.History` as an input field.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [LiteLLM](/docs/agent-tracing/litellm) and [OpenRouter](/docs/agent-tracing/openrouter): if your models go through either gateway.
