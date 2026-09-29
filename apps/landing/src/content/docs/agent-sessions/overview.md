---
title: "Agent Sessions"
description: "Agent Sessions groups the OpenTelemetry traces of one AI agent conversation into a single view of its turns, model calls, tool calls, tokens, cost and failures."
group: "Agent Sessions"
order: 1
navLabel: "Overview"
---

Each user message in a conversation is usually its own trace. **Agent Sessions** groups those traces into one conversation and shows it turn by turn. To send your agent's traces, pick your framework in [Trace your AI agent](/docs/agent-tracing).

## Sessions, turns and calls

| Level | What it is | Where it comes from |
| --- | --- | --- |
| **Session** | One conversation, from the first message to the last. | Every trace that carries the same session id, such as `gen_ai.conversation.id`. |
| **Turn** | One user message and everything the agent did to answer it. | Usually one trace, rooted at an `invoke_agent` span. |
| **Model call** | One request to an LLM: the prompt, the reply, tokens, finish reason. | A `chat` (or `generate_content`, `text_completion`) span. |
| **Tool call** | One function the model asked to run, with its arguments and result. | An `execute_tool` span. |

Sub-agents show up inside a turn as their own lane, labeled with their `gen_ai.agent.name`. A background job with no user is also a session, usually one trace long.

## Read a session

The example below is a support agent where the customer asks to change a delivery address and ends up canceling the order.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-02-overview.webp" alt="A session's overview page: a time breakdown bar, a findings list with a failed tool call, a tools table with calls, failures and a timeline, and a right column with cost by model and token buckets." loading="lazy" />
  <figcaption>The overview. The failed tool call leads the page: <code>update_shipping_address</code> returned <code>unsupported_destination</code> in turn 2.</figcaption>
</figure>

The **overview** splits the session's wall clock into model time, tool time and idle time, and totals cost and tokens per model.

Below that is the verdict (completed, completed with warnings, or failed, with the span that ended it) and the checks behind it, failing ones first. A check that needs data your instrumentation doesn't record says it was skipped and what to capture.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-03-transcript.webp" alt="The transcript view of a session: system instructions, user and assistant messages in sequence, each model call annotated with its model, tokens, cost and finish reason, and a tool call row with its latency and payload sizes." loading="lazy" />
  <figcaption>The transcript. Each model call carries its model, tokens, cost and finish reason; tool calls sit where the model made them.</figcaption>
</figure>

The **transcript** is the conversation as the model saw it: system instructions, user and assistant messages, and tool calls with arguments and results. It needs message content on your spans, which most instrumentations leave off by default; each framework guide shows the switch.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-05-trace.webp" alt="The trace view of a session: three turns, each with an invoke_agent span, chat spans labeled with their model and token counts, and execute_tool spans, on a time axis with the idle gaps between turns removed. One tool span is marked with its error type." loading="lazy" />
  <figcaption>The trace. Spans grouped by turn, with 2 minutes 10 seconds of idle time cut from the axis and the failed tool span flagged.</figcaption>
</figure>

The **trace** view puts every span of every turn on one time axis, with the idle time between turns removed.

<figure class="shot">
  <img src="/screenshots/docs/agent-sessions-01-list.webp" alt="The Agent Sessions list in Maple, one row per session with services, model, duration, LLM call and tool call counts, tokens, cost, errors and start time, and a filter sidebar on the left." loading="lazy" />
  <figcaption>The list. One row per conversation, filterable by framework, service, environment, model, agent and tool.</figcaption>
</figure>

The **list** has one row per session with its model, duration, call counts, tokens, cost and errors. Sort by cost to find expensive conversations, or filter to sessions that called a given tool.

## Find the tools that fail

The **Tools** tab covers every tool call across all sessions.

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

A tool call counts as failed when its span has an `ERROR` status or an `error.type` attribute. Failures with the same message, ignoring ids and numbers, form one group.

## Query sessions from your coding agent

The [MCP server](/docs/reference/mcp) exposes the same data. `list_agent_sessions` finds sessions by cost, model, tool or failure, `get_agent_session` returns a session's verdict, checks and turns, and `get_agent_tools_overview` and `get_agent_tool_error` return the tool rankings and failure groups.

## When a session doesn't look right

- **Every message is its own session.** No span carried a session id Maple reads (`gen_ai.conversation.id` for most frameworks, `session.id` for some). The framework's guide shows where to set it.
- **The transcript is empty.** Content capture is off, or the framework writes content only to span events or logs. Content on span attributes must be a JSON string such as a `[{role, parts}]` array.
- **Cost shows as unpriced.** Maple shows cost only when spans carry `gen_ai.usage.cost`, `gen_ai.usage.total_cost` or `llm.cost.total`; it doesn't price tokens itself.
- **Token totals look doubled.** Two instrumentations recorded the same model call, usually the framework's and a provider SDK instrumentor. Turn one off.
- **Nothing appears at all.** Check **Explore → Traces** for the service first. No traces there means the exporter isn't reaching Maple, often a short-lived script that exits before flushing. Traces there but no session means the framework's tracing isn't on.

A framework shown as **Unidentified** still gets sessions, transcripts and tools. If yours has no guide, [the OpenTelemetry GenAI guide](/docs/agent-tracing/opentelemetry) works for any agent, and a sample trace sent to [support@maple.dev](mailto:support@maple.dev) or [Discord](https://discord.gg/BnXjKuwJqP) helps us add one.
