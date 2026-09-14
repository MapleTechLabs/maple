---
title: "Agent Sessions"
description: "An AI agent conversation as one session: every turn, model call and tool call with its cost, timing and failures, built from OpenTelemetry GenAI traces. What Maple records, and how to connect an agent in any language or framework."
group: "Agent Sessions"
order: 0
navLabel: "Overview & setup"
---

One conversation from a support agent instrumented with the OpenTelemetry GenAI conventions: the customer asks to change a delivery address, gives one in Paris, and ends up cancelling the order. This is what Maple recorded.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">No extra SDK</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">OpenTelemetry GenAI semconv</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">20+ frameworks</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Any language</span>
</div>

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-02-overview.webp" alt="A session's overview page: a time breakdown bar, a findings list with a failed tool call, a tools table with calls, failures and a timeline, and a right column with cost by model and token buckets." loading="lazy" />
  <figcaption>The session overview. The failed tool call leads the page: <code>update_shipping_address</code> returned <code>unsupported_destination</code> in turn 2.</figcaption>
</figure>

The overview also splits the wall clock into model time, tool time and idle, and rolls cost and tokens up per model. Here the agent was busy for 14 seconds of 2 minutes 25; the rest was the customer typing.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-03-transcript.webp" alt="The transcript view of a session: system instructions, user and assistant messages in sequence, each model call annotated with its model, tokens, cost and finish reason, and a tool call row with its latency and payload sizes." loading="lazy" />
  <figcaption>The transcript. Each model call carries its model, tokens, cost and finish reason; tool calls sit where the model made them.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-05-trace.webp" alt="The trace view of a session: three turns, each with an invoke_agent span, chat spans labelled with their model and token counts, and execute_tool spans, on a time axis with the idle gaps between turns removed. One tool span is marked with its error type." loading="lazy" />
  <figcaption>The trace. Spans grouped by turn, 2m 10s of idle cut from the axis, the failed tool span flagged with its <code>error.type</code>.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-01-list.webp" alt="The Agent Sessions list in Maple, one row per session with services, model, duration, LLM call and tool call counts, tokens, cost, errors and start time, and a filter sidebar on the left." loading="lazy" />
  <figcaption>The list. One row per conversation for your retention period, filterable by framework, service, model, agent and tool; failed ones marked.</figcaption>
</figure>

Tools get the same treatment across sessions: ranked by volume, failure rate and latency, with each failure grouped by error type and the arguments and results that produced it. See [Debug and monitor tools](#debug-and-monitor-tools).

The same data is on the [MCP server](/docs/mcp) as `list_agent_sessions`, `get_agent_session`, `get_agent_tools_overview` and `get_agent_tool_error`.

## Connect your agent

### Step 1: traces are flowing

Your service exports OTLP to `https://ingest.maple.dev` with an ingest key. If it does not yet, pick your language in [Instrument your application](/docs/instrumentation) and come back. Agent Sessions adds nothing to that setup; it reads the traces that already arrive.

### Step 2: emit GenAI spans

Two ways to get there. If your agent runs on a [framework Maple recognises](#frameworks-maple-recognises-automatically), turn on that framework's OpenTelemetry export and you are done. Otherwise, and this is the path we recommend, emit the **OpenTelemetry GenAI semantic conventions** directly. Every framework integration is normalised into them anyway, and they are the one vocabulary that works in every language.

The conventions live at [opentelemetry.io/docs/specs/semconv/gen-ai](https://opentelemetry.io/docs/specs/semconv/gen-ai/). The pages you will actually use:

- [Inference spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/): the `chat`, `text_completion` and `embeddings` spans, the request and response attributes, and the token usage attributes.
- [Agent and tool spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/): `invoke_agent`, `create_agent` and `execute_tool`, and the `gen_ai.tool.*` attributes.
- [Message content](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/): the `{role, parts}` shape of `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions`.
- [Attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/): every `gen_ai.*` key with its type and examples.

One attribute is Maple's own: `maple_ai.session.id`, the same value on every span of a conversation, is what groups its traces into one session when no framework is recognised. Everything else Maple reads is in [the attribute table](#the-attributes-maple-reads) below.

### Step 3: open Explore → Agent Sessions

Run one conversation and open the list. The session appears as soon as its first trace lands; the overview and transcript fill in as the rest of the turns arrive. If it does not look like the screenshots above, [When it does not look right](#when-it-does-not-look-right) covers the four usual reasons.

### The attributes Maple reads

You do not need all of these. The first two rows make a span show up at all; the rest make it useful.

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
| `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`                                                         | Tool calls in the transcript, and everything on the tool pages.                                                                                                                                                              |
| `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.response.time_to_first_chunk`                                                                                         | Response metadata and time to first token.                                                                                                                                                                                   |
| `error.type` plus span status                                                                                                                                                         | Failed model and tool calls, and the failure groups on the tool pages.                                                                                                                                                       |

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

For the frameworks that give you one session per trace, stamp `maple_ai.session.id` on every span of the conversation (a span processor is the usual place) and Maple groups them into one session.

Two dialects that are not frameworks are recognised as well: any **OpenInference** emitter (`openinference.span.kind`, `llm.*`, `input.value`) and any **OpenLLMetry / Traceloop** emitter (`traceloop.*`, `llm.*`). Their spans land as sessions without a framework name attached.

**Don't see yours?** Send us the framework and a sample trace at [support@maple.dev](mailto:support@maple.dev) or on [Discord](https://discord.gg/BnXjKuwJqP). Adding a framework is a detection rule and a dialect map on our side, not a new SDK, so it is usually quick. In the meantime, anything that emits `gen_ai.operation.name` already works through the generic path above.

## Debug and monitor tools

Tools are where agents actually break. The model is rarely the thing that timed out, returned the wrong shape or refused a refund; the code behind `check_shipment` did. Agent Sessions treats every `execute_tool` span as a first-class thing you can rank, chart, group and open, so the three questions you ask when an agent misbehaves each take one click.

**Which tool is failing?** **Agent Sessions → Tools** is the fleet view. The strip on top gives calls, the share of sessions that used a tool, error rate and latency percentiles for the window, each with its change against the previous window. The table ranks every tool by calls, p50, p90, p95 and error rate, with a volume sparkline and the last call. Sort by error rate, or hit **Failing only** and the table drops to the tools that have failed at all.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-04-tools.webp" alt="The Tools tab: a metric strip with tool calls, sessions, error rate and duration, a chart of calls over time, and a table ranking each tool by calls, p50, p90, p95, error rate, errors, sessions and last call." loading="lazy" />
  <figcaption>Four tools, fifteen calls, three failures. The two with a 33% error rate stand out without a filter.</figcaption>
</figure>

**Why is it failing?** Click a tool. Its page charts calls, error rate, duration percentiles and calls per session over the window, so you can tell a tool that is failing because it is suddenly slow from one that is failing because a downstream API changed. Below the charts, the failures are grouped by `error.type`, each group with its share of failures, a daily trend and the sessions it hit. The bottom of the page lists every session that ran the tool, so the healthy calls are one click away too.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-08-tool-detail.webp" alt="A tool's detail page: four charts for tool calls, error rate, duration percentiles and calls per session, then an errors table with one row per error type showing trend, share, count, sessions and last seen." loading="lazy" />
  <figcaption>One tool over seven days. The p95 spike on the 13th and the <code>carrier_timeout</code> group are the same failure.</figcaption>
</figure>

**What exactly happened?** Open an error group and you get the failing calls themselves: the arguments the model sent on the left, the result the tool returned on the right, with long values shortened around the error path, plus which models and services the failure happens under and which sessions hit it. **Open trace** jumps into the session at that span.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-09-tool-error.webp" alt="The error group dialog for a tool: the error type, how many calls and sessions it affected, a failed-calls-per-day chart, a Where it happens panel listing the model and service, a sessions list, and a sample failed call with its JSON arguments and JSON result side by side." loading="lazy" />
  <figcaption>The <code>carrier_timeout</code> group: one failed call, its tracking number argument, and the result the agent had to work with.</figcaption>
</figure>

**Inside one conversation,** the session overview lists the tools that ran with calls, failures, total and slowest time, and where on the timeline each call sat. A failed one is a finding at the top of the page. Click it and the span opens with its error, the raw result, and every `gen_ai.tool.*` attribute it carried; the transcript shows the same call between the model turn that requested it and the one that reacted to it, and the trace shows how long it held the turn up.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-07-overview-tool-expanded.webp" alt="A tool span opened from the session overview: an ERROR banner with the error type and message, the result JSON, the span's timing and identifiers, and its AI attributes including operation, conversation id and tool name." loading="lazy" />
  <figcaption>A failed tool call opened from the overview: error, result, timing and the attributes behind them, with a jump into the trace.</figcaption>
</figure>

To get all of this, a tool span needs four attributes and a status: `gen_ai.operation.name` of `execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, and on failure a span status of `ERROR` with a stable `error.type`. The framework integrations do this for you. The error groups are keyed on `error.type` first, so a tool that raises `TimeoutError` and a tool that returns `{"error": "timeout"}` land in different groups, and the fingerprint masks ids, timestamps and other volatile tokens so one failure is one row rather than a hundred.

Ask the same questions from an assistant with the MCP server: `get_agent_tools_overview` returns the ranked table for a window, and `get_agent_tool_error` returns a group with its samples. The [MCP page](/docs/mcp) has the setup.

## When it does not look right

- **Every turn is its own session.** No span carried a session id Maple recognises. Add `maple_ai.session.id` to every span of the conversation, or check the framework table for the key your framework is expected to emit.
- **The transcript is empty.** Message content is not on the spans. Most official instrumentations leave it off by default, and some only ever write it to log events, which Maple does not read. If content is on the spans and still missing, check that the attribute holds a JSON array of `{role, parts}` objects rather than a plain string.
- **The framework shows as "Unidentified" or "Maple".** Unidentified means the spans carry `gen_ai.*` attributes but no fingerprint of a known framework; Maple means they carry `maple_ai.session.id`, which takes precedence over framework detection. Sessions, transcripts and tool pages work either way; only the framework facet differs. Tell us which framework it is and we will add the rule.
- **Token totals look too high or too low.** Providers disagree on whether cached and reasoning tokens are included in the input and output counts. Maple resolves that per `gen_ai.provider.name`, so if the provider name is missing or unexpected, set it and the totals correct themselves.
- **Nothing appears at all.** Confirm ordinary traces from the service show under **Explore → Traces** first. If they do, no span in them carries `gen_ai.operation.name`; if they do not, the problem is the exporter, and the [instrumentation guide](/docs/instrumentation) for your language covers it.
