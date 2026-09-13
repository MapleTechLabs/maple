---
title: "Set up Agent Sessions"
description: "Send your AI agent's model calls and tool calls to Maple as OpenTelemetry traces and read them back as sessions: one conversation, every turn, every tool, every token."
group: "Agent Sessions"
order: 0
navLabel: "Setup"
---

An agent run is not one request. It is a conversation that spans several requests, and inside each one the agent calls a model, decides on a tool, runs it, and calls the model again. A trace view shows you one of those requests. Agent Sessions shows you the conversation.

Maple builds sessions from ordinary OpenTelemetry traces. You do not install a separate SDK: if your agent already exports spans that follow the OpenTelemetry **GenAI semantic conventions**, or runs on one of the [frameworks Maple recognises](#frameworks-maple-recognises-automatically), the sessions appear under **Explore → Agent Sessions** as soon as the first trace lands.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Any OTLP exporter</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">GenAI semconv</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">20+ frameworks</span>
</div>

## What a session is made of

Maple reads three things off your spans, and that is the whole contract:

- **Which spans are AI spans.** A span with `gen_ai.operation.name` is one: `chat` and `text_completion` are model calls, `execute_tool` is a tool call, `invoke_agent` is an agent pass. Each shows up with its own shape in the session.
- **Which traces belong together.** A session is a group of traces that carry the same session id. Every span of a trace joins once any span in it names the session, so your HTTP and database spans ride along and show up in the waterfall.
- **Where one turn ends and the next begins.** Each `invoke_agent` span with no agent above it opens a turn. A session without agent spans gets one turn per trace.

Everything else is decoration that makes the session readable: the model and provider, token buckets, the messages that went in and came out, tool arguments and results, and errors.

## Prerequisites

- **Traces already flowing.** Your service exports OTLP to `https://ingest.maple.dev` with an ingest key. If not, pick your language in [Instrument your application](/docs/instrumentation) and come back; Agent Sessions adds nothing to that setup.
- **Content capture turned on** if you want to read prompts and completions in the transcript. Most instrumentations leave message content off by default, and the section for your framework below says which switch turns it on.

## Recommended: OpenTelemetry GenAI semantic conventions

This is the path we recommend, and the one every other integration is normalised into. The [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) define one set of `gen_ai.*` attributes for model calls, tool calls and agents. Emit them and Maple reads them directly, with nothing vendor-specific in between.

You get there in one of two ways: an **official instrumentation** that emits the attributes for you, or **manual spans** if your agent loop is your own code.

### Official instrumentations

The OpenTelemetry project ships GenAI instrumentations for the common clients. In Python:

```bash
pip install opentelemetry-instrumentation-openai-v2   # OpenAI and OpenAI-compatible clients
pip install opentelemetry-instrumentation-google-genai
pip install opentelemetry-instrumentation-vertexai
pip install opentelemetry-instrumentation-botocore     # Amazon Bedrock
```

Two environment variables matter more than the install. The first switches the instrumentation to the current conventions (the default is a 2024 draft that predates `gen_ai.input.messages`). The second records the messages themselves, which are off by default.

```bash
export OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only
```

Use `span_only`, not `event_only`. Maple reads the transcript off span attributes; content emitted only as log events does not reach the session view.

Then instrument the client before you create it:

```python
from opentelemetry.instrumentation.openai_v2 import OpenAIInstrumentor
from openai import OpenAI

OpenAIInstrumentor().instrument()
client = OpenAI()
```

That gives you model calls. Tool calls and the session id are yours to add, and the next section shows both.

### Manual spans

If your agent loop is hand-written, wrap the model call, each tool execution and the whole pass in spans of your own. The example is Python, but the attributes are the same in every language.

```python
import json
from opentelemetry import trace

tracer = trace.get_tracer("acme.support_agent", "1.14.2")

def run_turn(session_id: str, history: list[dict]) -> str:
    with tracer.start_as_current_span("invoke_agent support-agent") as agent_span:
        agent_span.set_attributes({
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": "support-agent",
            "gen_ai.conversation.id": session_id,
            "maple_ai.session.id": session_id,      # the same value on every span
        })

        while True:
            with tracer.start_as_current_span("chat claude-sonnet-4-5") as span:
                span.set_attributes({
                    "gen_ai.operation.name": "chat",
                    "gen_ai.provider.name": "anthropic",
                    "gen_ai.request.model": "claude-sonnet-4-5",
                    "gen_ai.conversation.id": session_id,
                    "maple_ai.session.id": session_id,
                    "gen_ai.input.messages": json.dumps(history),
                })
                response = call_model(history)          # your provider call
                span.set_attributes({
                    "gen_ai.response.model": response.model,
                    "gen_ai.response.id": response.id,
                    "gen_ai.response.finish_reasons": [response.stop_reason],
                    "gen_ai.usage.input_tokens": response.usage.input_tokens,
                    "gen_ai.usage.output_tokens": response.usage.output_tokens,
                    "gen_ai.output.messages": json.dumps(response.messages),
                })

            history.extend(response.messages)
            if not response.tool_calls:
                return response.text

            for call in response.tool_calls:
                with tracer.start_as_current_span(f"execute_tool {call.name}") as tool:
                    tool.set_attributes({
                        "gen_ai.operation.name": "execute_tool",
                        "gen_ai.tool.name": call.name,
                        "gen_ai.tool.call.id": call.id,
                        "gen_ai.tool.call.arguments": json.dumps(call.arguments),
                        "gen_ai.conversation.id": session_id,
                        "maple_ai.session.id": session_id,
                    })
                    try:
                        result = run_tool(call)
                    except Exception as error:
                        tool.set_attribute("error.type", type(error).__name__)
                        tool.set_status(trace.StatusCode.ERROR, str(error))
                        result = {"error": str(error)}
                    tool.set_attribute("gen_ai.tool.call.result", json.dumps(result))
                    part = {"type": "tool_call_response", "id": call.id, "response": result}
                    history.append({"role": "tool", "parts": [part]})
```

Three details in that code are worth knowing about:

- **`maple_ai.session.id` is the session key for plain semconv spans.** The conventions define a conversation id, but no framework emits it the same way, so a session built from bare `gen_ai.*` spans would otherwise be one trace long. Set it to the same value as `gen_ai.conversation.id`. Any string works; Maple stores it verbatim.
- **`invoke_agent` is what makes a turn.** Wrap each pass of the loop in one, as above, and the session reads as one turn per user message. Without it every trace is a turn, which is fine for one request per message and wrong for anything batched.
- **Messages are JSON arrays of `{role, parts}`**, the shape the conventions specify for `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions`. A part is `{"type": "text", "content": "…"}`, `{"type": "tool_call", "id", "name", "arguments"}` or `{"type": "tool_call_response", "id", "response"}`. The transcript view is built from these, so a plain string in that attribute renders as nothing.
- **Tool failures are span errors.** Set the span status to `ERROR` and put a stable category in `error.type`. That is what the [tool health](#read-the-session-back) page groups on, and a tool that quietly returns `{"error": ...}` with an `OK` status counts as a success there.

### The attributes Maple reads

You do not need all of these. The first three rows make a span show up at all; the rest make it useful.

| Attribute                                                                                                                                                                             | Used for                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen_ai.operation.name`                                                                                                                                                               | Marks the span as AI and says what kind: `chat`, `text_completion`, `embeddings`, `execute_tool`, `invoke_agent`, `create_agent`, `invoke_workflow`.                                                                         |
| `maple_ai.session.id`                                                                                                                                                                 | Groups traces into one session. Maple's own key, the opt-in for emitters no framework predicate recognises.                                                                                                                  |
| `gen_ai.conversation.id`                                                                                                                                                              | The conversation or thread id. It is the session id for the frameworks that emit it, and set on the transcript's messages so they correlate.                                                                                 |
| `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`                                                                                                               | Provider and model facets, per-model token and cost roll-ups. The older `gen_ai.system` is accepted too.                                                                                                                     |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.reasoning.output_tokens` | The five token buckets. Maple knows which providers nest one bucket inside another and does not double count.                                                                                                                |
| `gen_ai.usage.cost`                                                                                                                                                                   | Cost in USD, if your instrumentation prices calls. The conventions define no cost attribute, so Maple does not price semconv calls itself; this is the OpenLLMetry key, and `llm.cost.total` from OpenInference is read too. |
| `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`                                                                                                       | The transcript.                                                                                                                                                                                                              |
| `gen_ai.agent.name`, `gen_ai.agent.id`, `gen_ai.agent.description`                                                                                                                    | Agent facet, and sub-agent handoffs inside a session.                                                                                                                                                                        |
| `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`                                                         | Tool calls in the transcript, and everything on the tool health pages.                                                                                                                                                       |
| `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.response.time_to_first_chunk`                                                                                         | Response metadata and time to first token.                                                                                                                                                                                   |
| `error.type` plus span status                                                                                                                                                         | Failed model and tool calls, and the failure groups on the tool health page.                                                                                                                                                 |

Retrieval, memory, embeddings and evaluation attributes from the conventions are stored and shown on the span, but do not change how the session is built.

## Frameworks Maple recognises automatically

If your agent runs on one of these, use the framework's own OpenTelemetry exporter or the instrumentation listed and point it at Maple. Maple recognises the framework at ingest, normalises its attribute dialect into the `gen_ai.*` fields above, and takes the session id from wherever that framework keeps it.

| Framework                        | Instrumentation Maple recognises                    | Session id                                                |
| -------------------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| Vercel AI SDK                    | The SDK's `experimental_telemetry`                  | One per trace                                             |
| OpenAI Agents SDK                | OpenInference `openai_agents` instrumentation       | `session.id` or `gen_ai.conversation.id`                  |
| Claude Code and Claude Agent SDK | Built-in OpenTelemetry telemetry                    | `session.id`                                              |
| LangChain and LangGraph          | LangSmith OpenTelemetry export                      | `langsmith.metadata.thread_id`                            |
| LlamaIndex                       | LlamaIndex's OpenTelemetry observability package    | One per trace                                             |
| Pydantic AI                      | Built-in (`instrument=True`) or Logfire             | `gen_ai.conversation.id`                                  |
| Mastra                           | `@mastra/otel-exporter`                             | `gen_ai.conversation.id`                                  |
| Google ADK                       | Built-in OpenTelemetry tracing                      | `gen_ai.conversation.id` or `gcp.vertex.agent.session_id` |
| Microsoft Agent Framework        | Built-in OpenTelemetry tracing                      | `gen_ai.conversation.id`                                  |
| Semantic Kernel                  | Built-in OpenTelemetry tracing                      | One per trace                                             |
| Spring AI                        | Spring Boot observability over OTLP                 | `spring.ai.chat.client.conversation.id`                   |
| CrewAI                           | Built-in telemetry or OpenInference instrumentation | `session.id`                                              |
| DSPy                             | OpenInference `dspy` instrumentation                | `session.id`                                              |
| smolagents                       | OpenInference `smolagents` instrumentation          | `session.id`                                              |
| Agno                             | OpenInference `agno` instrumentation                | `session.id`                                              |
| Strands Agents                   | Built-in OpenTelemetry tracing                      | `session.id`                                              |
| Haystack                         | Built-in OpenTelemetry tracer                       | One per trace                                             |
| LiteLLM                          | Built-in OpenTelemetry callback                     | One per trace                                             |
| OpenRouter                       | Broadcast to an OTLP endpoint                       | `session.id`                                              |
| Effect AI                        | `@effect/opentelemetry`                             | One per trace                                             |
| OpenAI SDK via OpenInference     | OpenInference `openai` instrumentation              | `session.id`                                              |

For the frameworks that give you one session per trace, stamp `maple_ai.session.id` on every span of the conversation (a span processor is the usual place) and Maple groups them the same way it does for the manual example above.

Two dialects that are not frameworks are recognised as well: any **OpenInference** emitter (`openinference.span.kind`, `llm.*`, `input.value`) and any **OpenLLMetry / Traceloop** emitter (`traceloop.*`, `llm.*`). Their spans land as sessions without a framework name attached.

**Don't see yours?** Send us the framework and a sample trace at [support@maple.dev](mailto:support@maple.dev) or on [Discord](https://discord.gg/BnXjKuwJqP). Adding a framework is a detection rule and a dialect map on our side, not a new SDK, so it is usually quick. In the meantime, anything that emits `gen_ai.operation.name` already works through the generic path above.

## Read the session back

Once traces arrive, open **Explore → Agent Sessions**. The list shows the last seven days: one row per session with its services, the models it used, duration, model and tool call counts, tokens, cost and errors. The sidebar filters on framework, service, environment, model, agent and tool.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-01-list.webp" alt="The Agent Sessions list in Maple, one row per session with services, model, duration, LLM call and tool call counts, tokens, cost, errors and start time, and a filter sidebar on the left." loading="lazy" />
  <figcaption>Every conversation from the last week, filterable by framework, model, agent and tool.</figcaption>
</figure>

Open a session and you land on its overview: a digest of every turn with what the user asked, which tools ran, what the model answered, and the tokens and cost each turn added.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-02-overview.webp" alt="A session's overview page: a header with duration, token and cost totals, then one card per turn listing the user message, the tool calls it triggered and the assistant's reply." loading="lazy" />
  <figcaption>The overview reads the session top to bottom, one turn at a time.</figcaption>
</figure>

The **Transcript** tab is the same conversation as the model saw it, with each tool call where the model made it. It is built from `gen_ai.input.messages`, `gen_ai.output.messages` and the `gen_ai.tool.call.*` attributes, so if it is empty, content capture is what to check first.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-03-transcript.webp" alt="The transcript view of a session: system instructions, user and assistant messages in sequence, each model call annotated with its model, tokens, cost and finish reason, and a tool call row with its latency and payload sizes." loading="lazy" />
  <figcaption>Every model call carries its tokens, cost and finish reason. A tool call sits where the model made it; open it for the arguments and result.</figcaption>
</figure>

**Trace** and **Flow** show the same session as a waterfall and as a graph, which is where a slow tool or a retry loop is easiest to spot.

Across sessions, **Agent Sessions → Tools** ranks every tool by call volume, failure rate and latency, and each tool's page groups its failures by `error.type` with the sessions that hit them.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-04-tools.webp" alt="The tool health page: a metric strip with calls, failures and latency, a chart of calls over time, and a table ranking each tool by call count, failure rate and p95 duration." loading="lazy" />
  <figcaption>Tool health across every session in the window, ranked by failure rate.</figcaption>
</figure>

The same data is on the [MCP server](/docs/mcp): `list_agent_sessions`, `get_agent_session` and the `get_agent_tools_*` tools let an assistant read a session or a tool's failure groups without opening the dashboard.

## When it does not look right

- **Every turn is its own session.** No span carried a session id Maple recognises. Add `maple_ai.session.id` to every span of the conversation, or check the framework table for the key your framework is expected to emit.
- **The transcript is empty.** Message content is off in your instrumentation. For the OpenTelemetry instrumentations, set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only`; other frameworks have their own switch. If content is on and still missing, check that the attribute holds a JSON array of `{role, parts}` objects rather than a plain string.
- **The framework shows as "Unidentified" or "Maple".** Unidentified means the spans carry `gen_ai.*` attributes but no fingerprint of a known framework; Maple means they carry `maple_ai.session.id`, which takes precedence over framework detection. Sessions, transcripts and tool health work either way; only the framework facet differs. Tell us which framework it is and we will add the rule.
- **Token totals look too high or too low.** Providers disagree on whether cached and reasoning tokens are included in the input and output counts. Maple resolves that per `gen_ai.provider.name`, so if the provider name is missing or unexpected, set it and the totals correct themselves.
- **Nothing appears at all.** Confirm ordinary traces from the service show under **Explore → Traces** first. If they do, no span in them carries `gen_ai.operation.name`; if they do not, the problem is the exporter, and the [instrumentation guide](/docs/instrumentation) for your language covers it.
