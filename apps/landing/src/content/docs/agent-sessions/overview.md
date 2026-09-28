---
title: "Agent Sessions"
description: "See an AI agent conversation as one session: every turn, model call and tool call, with its tokens, cost, timing and failures, built from the OpenTelemetry traces your agent already sends."
group: "Agent Sessions"
order: 1
navLabel: "Overview"
---

A trace shows you one request. An agent conversation is rarely one request: a chat backend handles each user message separately, so a ten-message conversation is ten traces, and the model calls, tool calls and handoffs that matter are scattered across them.

**Agent Sessions** puts them back together. Maple groups the traces of one conversation into a session and shows it the way you think about it: turn by turn, with the transcript, every model and tool call, what it cost, where the time went and what failed. Sessions are built from OpenTelemetry traces, so there is no Maple SDK to add. To get your agent's traces in, pick your framework in [Trace your AI agent](/docs/agent-tracing).

## What is an agent session?

A session is one conversation between a user (or a job) and your agent. Maple uses four levels:

| Level | What it is | Where it comes from |
| --- | --- | --- |
| **Session** | One conversation, from the first message to the last. | Every trace that carries the same session id, such as `gen_ai.conversation.id`. |
| **Turn** | One user message and everything the agent did to answer it. | Usually one trace, rooted at an `invoke_agent` span. |
| **Model call** | One request to an LLM: the prompt, the reply, tokens, finish reason. | A `chat` (or `generate_content`, `text_completion`) span. |
| **Tool call** | One function the model asked to run, with its arguments and result. | An `execute_tool` span. |

Sub-agents sit inside a turn. When an orchestrator hands work to a `researcher` agent, the researcher's model and tool calls show up as their own lane, labeled with its `gen_ai.agent.name`.

A background job that never talks to a user is still a session: one run, usually one trace.

## What a session shows you

This is one conversation with a support agent that uses the OpenTelemetry GenAI conventions. The customer asks to change a delivery address, gives one in Paris, and ends up canceling the order.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-02-overview.webp" alt="A session's overview page: a time breakdown bar, a findings list with a failed tool call, a tools table with calls, failures and a timeline, and a right column with cost by model and token buckets." loading="lazy" />
  <figcaption>The overview. The failed tool call leads the page: <code>update_shipping_address</code> returned <code>unsupported_destination</code> in turn 2.</figcaption>
</figure>

The **overview** splits the wall clock into model time, tool time and idle time, and rolls cost and tokens up per model. Here the agent was busy for 14 seconds of a 2 minute 25 second session. The rest was the customer typing.

Under it, Maple runs a set of checks over the session and gives it a verdict: it completed cleanly, completed with warnings, or failed, and if it failed, which span ended it. The checks that need attention come first, each with what to do about it:

- **Completion**, **Context window**, **Reply length** and **Refusals**: did the model finish its answers, or did it run out of context, hit `max_tokens` or refuse?
- **Rate limits** and **Provider errors**: did the LLM provider fail calls, and did the session survive them?
- **Tool errors**, **Tool arguments**, **Tool timeouts** and **Tool availability**: which tools failed, and was it the tool or the arguments the model sent?
- **Repeated calls** and **Stalls**: is the agent looping, or did it stop making progress?
- **Prompt cache**: is the prompt prefix being reused across calls, or are you paying full price every turn?
- **Structured output**: did the model's JSON parse?

When your instrumentation doesn't record something a check needs, like message content or tool arguments, the check says it was skipped and what to capture, instead of passing quietly.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-03-transcript.webp" alt="The transcript view of a session: system instructions, user and assistant messages in sequence, each model call annotated with its model, tokens, cost and finish reason, and a tool call row with its latency and payload sizes." loading="lazy" />
  <figcaption>The transcript. Each model call carries its model, tokens, cost and finish reason; tool calls sit where the model made them.</figcaption>
</figure>

The **transcript** is the conversation as the model saw it: system instructions, user and assistant messages, and tool calls with their arguments and results, in order. It needs message content on your spans, which most instrumentations leave off by default. Each framework guide shows the switch.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-05-trace.webp" alt="The trace view of a session: three turns, each with an invoke_agent span, chat spans labeled with their model and token counts, and execute_tool spans, on a time axis with the idle gaps between turns removed. One tool span is marked with its error type." loading="lazy" />
  <figcaption>The trace. Spans grouped by turn, with 2 minutes 10 seconds of idle time cut from the axis and the failed tool span flagged.</figcaption>
</figure>

The **trace** view is every span of every turn on one time axis, with the idle gaps between turns removed so a slow tool doesn't hide next to a user who went for coffee.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-01-list.webp" alt="The Agent Sessions list in Maple, one row per session with services, model, duration, LLM call and tool call counts, tokens, cost, errors and start time, and a filter sidebar on the left." loading="lazy" />
  <figcaption>The list. One row per conversation, filterable by framework, service, environment, model, agent and tool.</figcaption>
</figure>

The **list** has one row per session with its model, duration, call counts, tokens, cost and errors. Sort by cost to find the expensive conversations, or filter to sessions that called a given tool.

## Debug the tools your agent calls

When an agent misbehaves, the cause is usually a tool: it failed, it was slow, or the model called it with arguments it couldn't use. The **Tools** tab looks at every tool call across all sessions.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-04-tools.webp" alt="The Tools tab: a metric strip with tool calls, sessions, error rate and duration, a chart of calls over time, and a table ranking each tool by calls, p50, p90, p95, error rate, errors, sessions and last call." loading="lazy" />
  <figcaption><strong>Which tool is failing?</strong> Every tool ranked by calls, latency percentiles and error rate. <strong>Failing only</strong> keeps just the ones that have failed.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-08-tool-detail.webp" alt="A tool's detail page: four charts for tool calls, error rate, duration percentiles and calls per session, then an errors table with one row per error showing trend, share, count, sessions and last seen." loading="lazy" />
  <figcaption><strong>Why?</strong> A tool's page charts its calls, error rate, duration and calls per session, then groups its failures with a trend and the sessions they hit.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-09-tool-error.webp" alt="The error group dialog for a tool: the error type, how many calls and sessions it affected, a failed-calls-per-day chart, a Where it happens panel listing the model and service, a sessions list, and a sample failed call with its JSON arguments and JSON result side by side." loading="lazy" />
  <figcaption><strong>What exactly happened?</strong> An error group opens on the failed calls themselves: arguments on the left, the result on the right, and a link to the trace.</figcaption>
</figure>

Failures are grouped by what went wrong: Maple fingerprints the failed result (or the span's status message) with ids and numbers masked, so a thousand `order 12345 not found` errors are one group, not a thousand. A tool call counts as failed when its span has an `ERROR` status or an `error.type` attribute. Many frameworks catch a tool's exception and hand the message back to the model without marking the span, which makes a broken tool look healthy; the framework guides cover how to avoid that.

## How Maple builds a session from your traces

You don't need this to use Agent Sessions, but it explains what the framework guides ask you to configure.

1. **Maple recognizes AI spans at ingest.** A span counts if it carries `gen_ai.operation.name` (the OpenTelemetry GenAI conventions) or matches the fingerprint of a framework Maple knows: Vercel AI SDK, OpenAI Agents SDK, LangChain and LangGraph, Mastra, Pydantic AI, CrewAI, Google ADK, Strands, Claude Code, Spring AI and others. Traces with no AI span don't appear.
2. **It reads the session id that framework uses.** For most frameworks that's `gen_ai.conversation.id`; several, including CrewAI, DSPy and Strands, use `session.id`. One span per trace is enough. A trace without one becomes a session of its own, which is why "every message is its own session" is the most common setup problem.
3. **It splits the session into turns**, normally one per trace, and decodes each model call's model, tokens and content, and each tool call's name, arguments and result.
4. **It counts tokens once.** Providers disagree on whether cached and reasoning tokens are included in the input and output counts. Maple resolves that per provider, and when a framework records usage on both an agent span and the model calls inside it, Maple keeps the model calls' numbers.

Two limits are worth knowing up front:

- **Maple reads span attributes.** Prompts and replies that a framework writes only to span events or OpenTelemetry logs are still stored (on the span, or under [Logs](/docs/explore/logs)), but they don't show up in the transcript. The framework guides say where each framework puts its content and how to move it onto spans when that's possible.
- **Maple shows cost your instrumentation reports; it doesn't price tokens itself.** Cost appears when spans carry `gen_ai.usage.cost`, `gen_ai.usage.total_cost` or OpenInference's `llm.cost.total`. OpenRouter and some instrumentations send it. Otherwise the session shows tokens and reads as unpriced.

A session view loads up to 2,000 spans. Longer sessions show the first 2,000 and say they were cut.

## Get your agent into Agent Sessions

Maple ingests OpenTelemetry over OTLP/HTTP, so the work is turning on your framework's tracing and pointing it at `https://ingest.maple.dev` (`https://ingest.eu.maple.dev` for EU organizations) with an ingest key from **Settings → Ingestion**. [Trace your AI agent](/docs/agent-tracing) has a guide for each framework, and a prompt that has a coding agent do the setup for you.

The guides all aim for the same result:

- one session per conversation, not one per message;
- the prompt, reply and tool arguments and results in the transcript;
- tokens on every model call, including streamed ones;
- failed tools marked as failed;
- sub-agents named, so they get their own lanes.

## Query sessions from your coding agent

The same data is on the [MCP server](/docs/reference/mcp): `list_agent_sessions` finds sessions by cost, model, tool or failure, `get_agent_session` returns a session's verdict, checks and turns, and `get_agent_tools_overview` and `get_agent_tool_error` return the tool rankings and failure groups. Ask your coding agent "why did the last expensive session fail?" and it can answer from the traces.

## When a session doesn't look right

- **Every message is its own session.** No span in the trace carried a session id Maple reads for that framework. The framework's guide shows where to set it.
- **The transcript is empty.** Message content isn't on the spans: either capture is off (the default for most instrumentations), or the framework writes content to span events or logs only. Content that is on the spans must be a JSON string, such as a `[{role, parts}]` array; a plain string is ignored.
- **The framework shows as "Unidentified".** The spans follow the GenAI conventions but match no framework fingerprint. Sessions, transcripts and tools all work; only the framework facet is missing. Tell us which framework it is.
- **Token totals look doubled.** Two instrumentations recorded the same model call, typically the framework's and a provider SDK instrumentor like OpenAI's. Turn one off.
- **Nothing appears at all.** Check that ordinary traces from the service show up under **Explore → Traces** first. If they don't, the exporter isn't reaching Maple; a short-lived script that exits before flushing is the usual cause. If they do, none of the spans is recognized as AI; check the framework's tracing is actually on.

Using a framework we don't cover? Send us the framework and a sample trace at [support@maple.dev](mailto:support@maple.dev) or on [Discord](https://discord.gg/BnXjKuwJqP). Adding one is a detection rule on our side, not a new SDK. Until then, [the OpenTelemetry GenAI guide](/docs/agent-tracing/opentelemetry) works for any agent in any language.
