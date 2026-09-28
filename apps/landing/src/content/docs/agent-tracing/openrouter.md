---
title: "Trace OpenRouter calls in Maple with Broadcast"
description: "Send every OpenRouter model call to Maple as an OpenTelemetry trace with tokens and real cost, grouped into one Agent Session per conversation, and join it to your app's own traces."
group: "AI Agents"
order: 41
navLabel: "OpenRouter"
icon: "openrouter"
---

OpenRouter Broadcast exports a trace for every request that goes through your OpenRouter account. You configure it once in the OpenRouter dashboard, with no SDK and no code in your app. Each trace carries the model, the provider that served it, input, output, cached and reasoning tokens, the cost OpenRouter charged you, and the prompt and completion. Maple reads all of it and shows these traces under **Agent Sessions** as vendor **OpenRouter**.

Out of the box, though, every model call is its own trace and its own session. Broadcast only knows what is in the request body. Unless your code sends a `session_id`, a ten-turn conversation shows up as thirty one-call "sessions".

This guide covers the dashboard setup, the two request fields that fix the grouping (`session_id` and `trace`), and what Broadcast can't see: your tools and your agent structure. Code samples use the `openai` SDK (npm 7.23, PyPI 3.20), `@openrouter/ai-sdk-provider` 3.1 for the Vercel AI SDK, and `@openrouter/sdk` 1.3.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-openrouter](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-openrouter) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for OpenRouter in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-openrouter -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

The agent can change your code, but not your OpenRouter dashboard. It finishes by telling you the exact values to paste into the Broadcast destination below.

## Point Broadcast at Maple

1. In OpenRouter, open [Settings → Observability](https://openrouter.ai/settings/observability) and turn on **Enable Broadcast**. In an organization account, only an organization admin can edit this.
2. Click the edit icon next to **OpenTelemetry Collector**.
3. Set **Endpoint** to the full traces URL. OpenRouter posts to it verbatim and does not append `/v1/traces`:

   ```text
   https://ingest.maple.dev/v1/traces
   ```

   EU organizations use `https://ingest.eu.maple.dev/v1/traces`.

4. Set **Headers** to a JSON object with your Maple ingest key:

   ```json
   { "Authorization": "Bearer YOUR_INGEST_KEY" }
   ```

5. Leave the sampling rate at 1.0 and Privacy Mode off for now (see [privacy](#prompts-completions-and-privacy-mode) below).
6. Click **Test Connection**. OpenRouter only saves the destination if the test passes.

OpenRouter sends OTLP over HTTP with JSON encoding only. Maple's ingest accepts JSON on `/v1/traces`, so no collector is needed in between.

Three destination settings silently decide what reaches Maple:

- **API key filter.** If the destination lists API keys, only requests made with those keys are exported. Excluded keys always win. Leave it empty to export every key.
- **Sampling rate.** Sampling is per `session_id`, so a session is either complete or absent. Anything below 1.0 drops whole conversations.
- **Data regions.** A destination only receives requests served in its regions. If your app calls `eu.openrouter.ai`, the destination needs the Europe region (the default is global).

Destinations can also be created through OpenRouter's [observability API](https://openrouter.ai/docs/api/api-reference/observability/create-an-observability-destination) (`type: "otel-collector"`) with a management key, if you manage OpenRouter as code.

## Group each conversation into one session

Maple builds a session from the `session.id` attribute on OpenRouter's spans. OpenRouter copies it from the `session_id` field of your request (up to 256 characters) or from the `x-session-id` header. The body wins if you send both.

Send the same id on every request of a conversation: your chat thread id, conversation id or agent run id. Use a new one for each conversation. A process-wide constant merges every user into one session.

With the `openai` SDK in TypeScript, `session_id` isn't in the types, so it needs a `@ts-expect-error`. The SDK sends unknown fields as-is:

```ts
import OpenAI from "openai"

const client = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
})

const completion = await client.chat.completions.create({
	model: "openai/gpt-4o-mini",
	messages,
	// @ts-expect-error OpenRouter-only field
	session_id: conversationId,
})
```

Or skip the type workaround and send the header, which the SDK types allow per request:

```ts
const completion = await client.chat.completions.create(
	{ model: "openai/gpt-4o-mini", messages },
	{ headers: { "x-session-id": conversationId } },
)
```

In Python, use `extra_body`:

```py
import os

from openai import OpenAI

client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"])

completion = client.chat.completions.create(
    model="openai/gpt-4o-mini",
    messages=messages,
    extra_body={"session_id": conversation_id},
)
```

With the Vercel AI SDK and `@openrouter/ai-sdk-provider`, everything under `providerOptions.openrouter` is merged into the request body:

```ts
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { streamText } from "ai"

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })

const result = streamText({
	model: openrouter("openai/gpt-4o-mini"),
	messages,
	providerOptions: { openrouter: { session_id: conversationId } },
})
```

OpenRouter's own SDKs have typed fields: `sessionId` in `@openrouter/sdk` (`openRouter.chat.send({ model, messages, sessionId })`) and `session_id=` in the `openrouter` Python package.

`session_id` also makes OpenRouter route a session's requests to the same provider, so prompt caches hit more often.

If you skip it, each call lands in its own session, named `trace:<trace id>` in Maple, with one turn and one model call.

## Join Broadcast to your own traces

By default, each OpenRouter request becomes a separate trace with an `LLM Generation` root span. That has two consequences in Maple:

- **Turns.** Maple counts one turn per trace, so a user message that makes three model calls (one per tool round trip) shows as three turns.
- **Duplicates.** If your app already sends its own traces to Maple (the Vercel AI SDK, OpenAI Agents SDK, LangChain and so on), every model call is recorded twice: once by your app and once by Broadcast.

The `trace` request field fixes both. OpenRouter uses `trace.trace_id` and `trace.parent_span_id` verbatim as the OTLP trace id and parent span id, so the Broadcast spans land inside your trace. Use W3C ids: 32 lowercase hex characters for the trace id and 16 for the span id.

In TypeScript, the least invasive place is a `fetch` wrapper. It reads the span that is active when the SDK sends the HTTP request, which is your framework's model-call span if it has one:

```ts
import { trace } from "@opentelemetry/api"

// Nests each OpenRouter Broadcast trace under the span that made the request.
export const openRouterFetch: typeof fetch = (input, init) => {
	const span = trace.getActiveSpan()?.spanContext()
	if (span && typeof init?.body === "string") {
		const body = JSON.parse(init.body)
		body.trace = { ...body.trace, trace_id: span.traceId, parent_span_id: span.spanId }
		init = { ...init, body: JSON.stringify(body) }
	}
	return fetch(input, init)
}
```

Pass it to the client: `new OpenAI({ baseURL, apiKey, fetch: openRouterFetch })` or `createOpenRouter({ apiKey, fetch: openRouterFetch })`. Both SDKs send the body as a JSON string, which is what the wrapper expects.

In Python, add the current span's ids next to `session_id`:

```py
from opentelemetry import trace


def openrouter_extra_body(conversation_id: str) -> dict:
    body = {"session_id": conversation_id}
    ctx = trace.get_current_span().get_span_context()
    if ctx.is_valid:
        body["trace"] = {
            "trace_id": format(ctx.trace_id, "032x"),
            "parent_span_id": format(ctx.span_id, "016x"),
        }
    return body


client.chat.completions.create(model=model, messages=messages, extra_body=openrouter_extra_body(conversation_id))
```

This parents the Broadcast spans to whatever span is current at the call site, usually your turn or agent span.

Once the spans share a trace, Maple counts each model call once:

- If the Broadcast `LLM Generation` span is a descendant of your app's model-call span, Maple counts the usage at the deepest span that reports it.
- If they are siblings, or in different traces, Maple matches them by `gen_ai.response.id`. OpenRouter's is the `gen-…` id in the response. Instrumentations that record the response id (the Vercel AI SDK, OpenTelemetry's `openai-v2` instrumentation) match; ones that don't are counted twice.

Use the same value for `session_id` as for your framework's conversation id. A trace that carries two different session ids is assigned to one of them, the lexically larger, without a warning.

## Prompts, completions and Privacy Mode

Broadcast includes content by default. The `LLM Generation` span carries the request messages in `gen_ai.prompt` and the reply in `gen_ai.completion`, both as JSON strings.

They are wrapped objects, not message arrays: `{"messages": [...]}` for the prompt and `{"completion": "...", "reasoning": "..."}` for the reply. Maple shows each one as a single raw JSON block on the span, so the transcript is readable but not rendered as chat bubbles, and turns have no label from the user's message. If your app also emits `gen_ai.input.messages` on its own spans, that transcript renders normally.

In our captures, the completion object also echoes the request body, including your tool definitions and the `user`, `session_id` and `trace` fields.

To keep content out of Maple, turn on **Privacy Mode** on the destination. OpenRouter strips prompts and completions; tokens, cost, timing, model and metadata still arrive, so sessions, counts and cost still work. Privacy Mode does not remove `user`, `session_id` or custom `trace` metadata, so don't put emails or names in them.

OpenRouter shortens any single value over 10,000,000 characters and adds a `<key>.truncated` attribute. Maple's ingest accepts request bodies up to 20 MiB.

## Tools, errors and provider fallbacks

Broadcast sees HTTP requests to OpenRouter, not your agent. Your tools run in your process, so a Broadcast-only setup has **no tool spans**: tool calls appear inside the completion JSON, but Maple's tool counts, tool pages and tool failure groups stay empty, and a tool that throws is invisible. There is no agent name either, so sub-agents don't get lanes.

For tools and agent structure, instrument the app with its framework guide from [Agent tracing](/docs/agent-tracing) and nest Broadcast under it as shown above. Broadcast then adds what most frameworks lack: cost and the provider routing.

Model failures do show up. Each request's trace has an `LLM Generation` root and a `provider attempt N: <provider>` child per upstream provider OpenRouter tried:

- A failed attempt that OpenRouter recovered from by falling back to another provider is a retry. Maple does not count it as a failure.
- If every attempt fails, `LLM Generation` has status Error with the message `Provider returned error`, and Maple counts it as a `provider_error` in the session. Such a call carries no token usage, and Maple then counts the root and each failed attempt as separate model calls, so one failed request with one attempt shows as two LLM calls.

On that error path, OpenRouter currently drops the `trace` object, so the failed call lands in its own trace. It keeps `session.id`, so it still joins the right session.

## Tokens and cost

Every `LLM Generation` span carries:

| Attribute | What Maple does with it |
| --- | --- |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | Input and output tokens |
| `gen_ai.usage.input_tokens.cached` | Cache-read tokens (included in input) |
| `gen_ai.usage.output_tokens.reasoning` | Reasoning tokens (included in output) |
| `gen_ai.usage.total_cost` | Cost in USD, OpenRouter's actual charge |
| `gen_ai.request.model`, `gen_ai.response.model` | Model, as the OpenRouter slug (`openai/gpt-4o-mini`) |
| `gen_ai.response.finish_reasons` | Truncation and refusal checks |

Cost is the main reason to use Broadcast even when your app is already instrumented. Maple never prices tokens itself, and most frameworks export no cost, so their sessions read "unpriced". When the app's span and the Broadcast span describe the same call, Maple keeps the larger cost of the two, which is OpenRouter's.

Streaming doesn't matter here: OpenRouter accounts usage server-side, so streamed calls carry tokens and cost without `stream_options.include_usage`.

Not read by Maple:

- `gen_ai.usage.input_tokens.cache_write` (cache writes). Totals are unaffected, but the cache-write column stays empty.
- `trace.metadata.openrouter.first_token_ms` (time to first token). Maple reads TTFT only from `gen_ai.response.time_to_first_chunk`.
- The **Cost** option under **Additional generation metadata**, which adds `span.metadata.openrouter_generation.*` attributes. You don't need it for Maple.

`gen_ai.provider.name` is the model's author (`openai`, `anthropic`), not the provider that served the request. That one is in `trace.metadata.openrouter.provider_name` (for example `Amazon Bedrock`).

One known gap for Claude models: OpenRouter's input count includes cached tokens for every model, but Maple reads an `anthropic` input count as excluding them, so cache reads are counted twice in Claude sessions' token totals. In our test, a Claude session with 26,730 input tokens (4,248 of them cached) showed 32,573 total tokens instead of 28,325. Cost is unaffected, because it comes from OpenRouter's charge.

## Short-lived processes

Broadcast needs no flush. OpenRouter sends traces from its own servers after each request completes, so a script, a serverless function or a CLI that exits right after the response loses nothing.

Expect about a minute between the response and the trace in Maple.

If your app also exports its own spans, those still need the usual flush on exit (`sdk.shutdown()` in Node, `provider.force_flush()` in Python). Otherwise Maple shows the Broadcast spans with a missing parent.

## Check that it works

Run one conversation of three or more turns, with a tool call, sending the same `session_id` on every request. Wait about a minute, then open **Agent Sessions** in Maple and filter by service `openrouter`.

- **One session for the conversation**, named by your `session_id`, with vendor **OpenRouter**. A second conversation is a second session.
- **Model calls.** Each call has an `LLM Generation` span with one or more `provider attempt N: <provider>` children, and sometimes `generation` or `moderation` children. Only `LLM Generation` counts as a model call, except on a request where every provider attempt failed (see above).
- **Tokens and cost** on the session and per model, with cost in USD.
- **Transcript**: each call's prompt and completion as a JSON block, unless Privacy Mode is on.
- **Turns**: one per trace. Broadcast-only, that's one per model call, listed as unlabeled segments (Segment 1, Segment 2, ...). Nested under your own traces, it's one per turn of your agent.
- **Tools**: none from Broadcast. Tool spans come from your app's instrumentation.

The service name on Broadcast spans is always `openrouter`, and there is no environment attribute. Custom keys in the `trace` object arrive as `trace.metadata.<key>` attributes, which you can search in [Traces](/docs/explore/traces) but which don't set Maple's environment or service.

## Troubleshooting

- **Test Connection fails.** The endpoint must be the full `https://ingest.maple.dev/v1/traces` URL and the headers valid JSON with `"Authorization": "Bearer YOUR_INGEST_KEY"`. EU organizations use `ingest.eu.maple.dev`.
- **Test Connection passes but nothing arrives.** Check the destination's API key filter and data regions against the key and endpoint your app actually uses, and that **Enable Broadcast** is on for the account or organization your app's key belongs to. A placeholder key such as `MAPLE_TEST` passes the test, but Maple discards everything it sends.
- **Every call is its own session, named `trace:<id>`.** The request has no `session_id`. Check the outgoing body, not just your code: a wrapper or framework may drop unknown fields.
- **A session named `trace:00000000000000000000000000000001` with no model calls.** That's the `openrouter-connection-test` span from **Test Connection**. Every test reuses that trace id, so the session gains a span per click. Ignore it.
- **A session with an `openai/gpt-4-turbo` call you never made, trace name `Test Trace - OpenRouter Observability`.** OpenRouter's sample trace from the destination settings, with sample tokens and cost.
- **Tokens or LLM calls are about double what you expect.** Your app's instrumentation and Broadcast both report the call, in different traces and without a shared response id. Nest Broadcast with `trace.trace_id` and `trace.parent_span_id`, or filter that service's API key out of the destination.
- **Broadcast spans show up as a separate trace despite `trace.trace_id`.** The id isn't W3C hex, or the call failed: on the all-providers-failed path OpenRouter drops the `trace` object.
- **Turns have no label and the transcript is raw JSON.** Expected for Broadcast content (see [above](#prompts-completions-and-privacy-mode)).
- **Sessions are missing entirely at random.** The destination's sampling rate is below 1.0.
- **Tool counts are zero.** Expected for Broadcast-only. Add your framework's instrumentation for tool spans.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Agent tracing guides](/docs/agent-tracing)
- [OpenRouter Broadcast](https://openrouter.ai/docs/guides/features/broadcast) and its [OpenTelemetry Collector destination](https://openrouter.ai/docs/guides/features/broadcast/otel-collector)
- [Vercel AI SDK](/docs/agent-tracing/vercel-ai-sdk), if you call OpenRouter through `@openrouter/ai-sdk-provider`
