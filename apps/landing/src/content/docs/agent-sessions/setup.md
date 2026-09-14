---
title: "Agent Sessions"
description: "An AI agent conversation as one session: every turn, model call and tool call with its cost, timing and failures, built from OpenTelemetry GenAI traces. What Maple records, and how to connect an agent in any language or framework."
group: "Agent Sessions"
order: 0
navLabel: "Overview & setup"
---

Below is one conversation from a support agent instrumented with the OpenTelemetry GenAI conventions. Three turns: the customer asks whether they can change a delivery address, gives one in Paris, and ends up cancelling the order. This is what Maple recorded, and how much of the debugging is done before you open a trace.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">No extra SDK</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">OpenTelemetry GenAI semconv</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">20+ frameworks</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Any language</span>
</div>

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-02-overview.webp" alt="A session's overview page: a time breakdown bar, a findings list with a failed tool call, a tools table with calls, failures and a timeline, and a right column with cost by model and token buckets." loading="lazy" />
  <figcaption>The session's overview. The failed tool call is the first thing on the page, with the tool, the error type and the message it returned.</figcaption>
</figure>

The finding at the top says what went wrong: in turn 2, `update_shipping_address` failed with `unsupported_destination`, because the order region is US. Around it, the page has already answered the questions you would otherwise ask the trace. The agent was busy for 14 seconds of a 2 minute 25 second wall clock, and the other 90% was the customer typing. Claude Sonnet did the work for four cents across six calls, and a mini model classified each message for a fraction of that. Three tools ran; one failed; the timeline on the right of the tools table says when.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-03-transcript.webp" alt="The transcript view of a session: system instructions, user and assistant messages in sequence, each model call annotated with its model, tokens, cost and finish reason, and a tool call row with its latency and payload sizes." loading="lazy" />
  <figcaption>The same session as a transcript. Turn 1: the classifier's one-word answer, the collapsed system prompt, the order lookup, and the reply the customer saw.</figcaption>
</figure>

The transcript is the conversation as the model saw it. Each model call is labelled with its model, tokens in and out, cost, time to first token and finish reason, so a slow or expensive turn is visible in the margin before you read it. A system prompt that repeats is collapsed to one line, and a tool call sits between the model turn that requested it and the one that reacted to it, with its arguments and result one click away.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-05-trace.webp" alt="The trace view of a session: three turns, each with an invoke_agent span, chat spans labelled with their model and token counts, and execute_tool spans, on a time axis with the idle gaps between turns removed. One tool span is marked with its error type." loading="lazy" />
  <figcaption>The same session as a trace. 2m 10s of idle time between turns is cut from the axis; the failed tool span carries its <code>error.type</code> inline.</figcaption>
</figure>

The trace is where the timing lives. Spans are grouped by turn, the idle gaps between turns are removed from the axis so the calls stay readable, and the failed tool is marked where it happened: 210 ms, between a 2.18 second model call and the 2.35 second one that handled the failure. Your HTTP, database and queue spans are in the same trace, so a slow tool leads to the query behind it.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-01-list.webp" alt="The Agent Sessions list in Maple, one row per session with services, model, duration, LLM call and tool call counts, tokens, cost, errors and start time, and a filter sidebar on the left." loading="lazy" />
  <figcaption>Where the session came from. One row per conversation from the last seven days, with the failed ones marked.</figcaption>
</figure>

The list is where you find this session tomorrow, among the others: one row per conversation with its services, models, duration, model and tool call counts, tokens, cost and errors, filterable by framework, service, environment, model, agent and tool. The **1 tool** badge is what led here. Flip **With errors** and only the sessions that broke remain.

Tools get the same treatment across sessions: the Tools tab ranks every tool by volume, failure rate and latency, and each tool's page groups its failures by error type with the arguments and results that produced them. [Debug and monitor tools](#debug-and-monitor-tools) walks through it.

All of it is also on the [MCP server](/docs/mcp): `list_agent_sessions`, `get_agent_session`, `get_agent_tools_overview` and `get_agent_tool_error` let an assistant do the same reading without opening the dashboard.

## How a session is built

There is no separate SDK. Maple reads three things off the spans you already export, and that is the whole contract:

- **Which spans are AI spans.** Any span with `gen_ai.operation.name`: `chat` and `text_completion` are model calls, `execute_tool` is a tool call, `invoke_agent` is one pass of the agent.
- **Which traces belong together.** Traces that carry the same session id form one session. Once any span in a trace names the session, every span of that trace joins it, which is how your HTTP and database spans end up in the waterfall.
- **Where one turn ends and the next begins.** Each `invoke_agent` span with no agent above it opens a turn. A session with no agent spans gets one turn per trace.

Everything else on the pages above, the models, the token buckets, the messages, the tool arguments and results, the errors, comes from the rest of the `gen_ai.*` attributes, and the [attribute table](#the-attributes-maple-reads) says which ones do what.

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

Pick your language.

#### Python

The OpenTelemetry project ships instrumentations for the common clients:

```bash
pip install opentelemetry-instrumentation-openai-v2   # OpenAI and OpenAI-compatible clients
pip install opentelemetry-instrumentation-google-genai
pip install opentelemetry-instrumentation-vertexai
pip install opentelemetry-instrumentation-botocore     # Amazon Bedrock
```

Two environment variables matter more than the install. The first switches the instrumentation to the current conventions; the default is a 2024 draft that predates `gen_ai.input.messages`. The second records the messages themselves, which are off by default.

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

That gives you the model calls. The tool spans and the session id are yours to add, and [Manual spans](#manual-spans-any-language) below shows both.

#### Node.js and TypeScript

`@opentelemetry/instrumentation-openai` covers `openai` 4.19 and later and is part of `@opentelemetry/auto-instrumentations-node` if you already use the bundle; `@opentelemetry/instrumentation-langchain` does the same for LangChain.

```bash
npm install @opentelemetry/instrumentation-openai
```

```typescript
// tracing.ts, before any application import
import { NodeSDK } from "@opentelemetry/sdk-node"
import { OpenAIInstrumentation } from "@opentelemetry/instrumentation-openai"

const sdk = new NodeSDK({
	// ...the exporter and resource from the Node.js guide
	instrumentations: [new OpenAIInstrumentation()],
})
sdk.start()
```

That puts the model, the token counts and the finish reason on every model call. One thing to know: this instrumentation writes message content to **log events**, not span attributes, even with `captureMessageContent` on, and Maple builds the transcript from span attributes. Tool calls and the session id are yours to add anyway, so the [manual spans](#manual-spans-any-language) below are the way to get the full conversation. Using the Vercel AI SDK, Mastra or Effect AI instead? They are in the [framework table](#frameworks-maple-recognises-automatically), put content on the spans, and need no instrumentation package.

#### Java and Kotlin

The Java agent instruments the official `openai-java` client with no code change: the [agent command line](/docs/guides/instrumentation-java) from the Java guide already produces `chat` spans with the model, tokens and finish reason. Without the agent, the same instrumentation is a library you wrap the client with:

```kotlin
// io.opentelemetry.instrumentation:opentelemetry-openai-java-1.1
val client = OpenAITelemetry.builder(openTelemetry)
    .build()
    .wrap(OpenAIOkHttpClient.fromEnv())
```

As with Node.js, this instrumentation records message content as log events (`otel.instrumentation.genai.capture-message-content=true` turns them on), which Maple does not read into the transcript. Add the [manual spans](#manual-spans-any-language) for the tool calls and the conversation. Spring AI applications are [recognised as a framework](#frameworks-maple-recognises-automatically): Spring Boot's observability over OTLP is enough.

#### C# and .NET

`Microsoft.Extensions.AI` emits the conventions for any `IChatClient`. Wrap the client and register the source with the tracer from the [.NET guide](/docs/guides/instrumentation-csharp):

```csharp
IChatClient client = new OpenAIClient(apiKey)
    .GetChatClient("gpt-4.1")
    .AsIChatClient()
    .AsBuilder()
    .UseOpenTelemetry(sourceName: "acme.support-agent", configure: o => o.EnableSensitiveData = true)
    .Build();

builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing.AddSource("acme.support-agent") /* ...exporter */);
```

`EnableSensitiveData` is what puts the messages on the spans. Semantic Kernel and the Microsoft Agent Framework are recognised as frameworks and need only their built-in tracing.

#### Go, Rust, PHP and everything else

There is no official GenAI instrumentation for these yet, and you do not need one. The conventions are attribute names, so the [manual spans](#manual-spans-any-language) below work with any OpenTelemetry SDK. Go applications using `openai-go` can also pick up the community middleware from OpenLLMetry or LangWatch, both of which emit `gen_ai.*`.

#### Manual spans (any language)

If your agent loop is your own code, wrap the model call, each tool execution and the whole pass in spans. The example is Python; the attribute names are identical in every SDK, and the two shorter snippets after it show the same span in TypeScript and Go.

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

The tool span in TypeScript:

```typescript
import { SpanStatusCode, trace } from "@opentelemetry/api"

const tracer = trace.getTracer("acme.support-agent", "1.14.2")

await tracer.startActiveSpan(`execute_tool ${call.name}`, async (span) => {
	span.setAttributes({
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": call.name,
		"gen_ai.tool.call.id": call.id,
		"gen_ai.tool.call.arguments": JSON.stringify(call.arguments),
		"gen_ai.conversation.id": sessionId,
		"maple_ai.session.id": sessionId,
	})
	try {
		const result = await runTool(call)
		span.setAttribute("gen_ai.tool.call.result", JSON.stringify(result))
		return result
	} catch (error) {
		span.setAttribute("error.type", error instanceof Error ? error.name : "unknown")
		span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
		throw error
	} finally {
		span.end()
	}
})
```

And in Go:

```go
ctx, span := tracer.Start(ctx, "execute_tool "+call.Name)
defer span.End()
args, _ := json.Marshal(call.Arguments)
span.SetAttributes(
	attribute.String("gen_ai.operation.name", "execute_tool"),
	attribute.String("gen_ai.tool.name", call.Name),
	attribute.String("gen_ai.tool.call.id", call.ID),
	attribute.String("gen_ai.tool.call.arguments", string(args)),
	attribute.String("gen_ai.conversation.id", sessionID),
	attribute.String("maple_ai.session.id", sessionID),
)
result, err := runTool(ctx, call)
if err != nil {
	span.SetAttributes(attribute.String("error.type", errorType(err)))
	span.SetStatus(codes.Error, err.Error())
}
out, _ := json.Marshal(result)
span.SetAttributes(attribute.String("gen_ai.tool.call.result", string(out)))
```

Four details in that code are worth knowing about:

- **`maple_ai.session.id` is the session key for plain semconv spans.** The conventions define a conversation id, but no framework emits it the same way, so a session built from bare `gen_ai.*` spans would otherwise be one trace long. Set it to the same value as `gen_ai.conversation.id`. Any string works; Maple stores it verbatim. A span processor that stamps it on every span is the usual place for it.
- **`invoke_agent` is what makes a turn.** Wrap each pass of the loop in one and the session reads as one turn per user message. Without it every trace is a turn, which is fine for one request per message and wrong for anything batched.
- **Messages are JSON arrays of `{role, parts}`**, the shape the conventions specify for `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions`. A part is `{"type": "text", "content": "…"}`, `{"type": "tool_call", "id", "name", "arguments"}` or `{"type": "tool_call_response", "id", "response"}`. The transcript is built from these, so a plain string in that attribute renders as nothing.
- **Tool failures are span errors.** Set the span status to `ERROR` and put a stable category in `error.type`. That is what the tool pages group on. A tool that quietly returns `{"error": ...}` with an `OK` status counts as a success there.

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

For the frameworks that give you one session per trace, stamp `maple_ai.session.id` on every span of the conversation (a span processor is the usual place) and Maple groups them the same way it does for the manual example above.

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

To get all of this, a tool span needs four attributes and a status: `gen_ai.operation.name` of `execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, and on failure a span status of `ERROR` with a stable `error.type`. The manual example above does exactly that; the framework integrations do it for you. The error groups are keyed on `error.type` first, so a tool that raises `TimeoutError` and a tool that returns `{"error": "timeout"}` land in different groups, and the fingerprint masks ids, timestamps and other volatile tokens so one failure is one row rather than a hundred.

Ask the same questions from an assistant with the MCP server: `get_agent_tools_overview` returns the ranked table for a window, and `get_agent_tool_error` returns a group with its samples. The [MCP page](/docs/mcp) has the setup.

## When it does not look right

- **Every turn is its own session.** No span carried a session id Maple recognises. Add `maple_ai.session.id` to every span of the conversation, or check the framework table for the key your framework is expected to emit.
- **The transcript is empty.** Message content is not on the spans. Python: set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only`. .NET: set `EnableSensitiveData = true`. The Node.js and Java OpenAI instrumentations only ever write content to log events, so there the fix is the manual spans. If content is on the spans and still missing, check that the attribute holds a JSON array of `{role, parts}` objects rather than a plain string.
- **The framework shows as "Unidentified" or "Maple".** Unidentified means the spans carry `gen_ai.*` attributes but no fingerprint of a known framework; Maple means they carry `maple_ai.session.id`, which takes precedence over framework detection. Sessions, transcripts and tool pages work either way; only the framework facet differs. Tell us which framework it is and we will add the rule.
- **Token totals look too high or too low.** Providers disagree on whether cached and reasoning tokens are included in the input and output counts. Maple resolves that per `gen_ai.provider.name`, so if the provider name is missing or unexpected, set it and the totals correct themselves.
- **Nothing appears at all.** Confirm ordinary traces from the service show under **Explore → Traces** first. If they do, no span in them carries `gen_ai.operation.name`; if they do not, the problem is the exporter, and the [instrumentation guide](/docs/instrumentation) for your language covers it.
