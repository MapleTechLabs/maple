---
name: maple-agent-tracing-openrouter
description: "Trace OpenRouter calls with Maple: route OpenRouter Broadcast (OTLP) to Maple and edit the app's OpenRouter requests to send session_id and trace ids, so each conversation is one Maple Agent Session with model calls, tokens and real cost. Triggers on 'trace my openrouter calls', 'add Maple to openrouter', 'agent sessions for openrouter', 'OpenTelemetry for openrouter', 'openrouter broadcast to maple'."
---

# Maple agent tracing: OpenRouter Broadcast

Goal: every conversation = one Maple Agent Session with each OpenRouter model call, its tokens, cost (`gen_ai.usage.total_cost`, OpenRouter's real charge) and prompt/completion. If the app already exports its own traces to Maple, the Broadcast spans nest inside them and each call is counted once.

Mechanism: OpenRouter Broadcast, configured in the OpenRouter dashboard, exports one OTLP/HTTP JSON trace per request (scope and `service.name` = `openrouter`, root span `LLM Generation`, children `provider attempt N: <provider>`). Maple reads **`session.id`** as the session key. OpenRouter sets `session.id` from the request's `session_id` body field or `x-session-id` header, and uses `trace.trace_id` / `trace.parent_span_id` from the body verbatim as the OTLP trace id / parent span id.

You cannot change the OpenRouter dashboard. Your job: (1) edit the app's OpenRouter calls, (2) hand the user the exact destination settings.

What Broadcast cannot give (tell the user, don't try to fix it here): tool spans, tool failures, agent names / sub-agent lanes. Those need the app's framework instrumentation (router skill `maple-agent-tracing`).

## Step 0: Detect

1. Find every OpenRouter call site: `openrouter.ai` base URLs (`https://openrouter.ai/api/v1`, `https://eu.openrouter.ai/api/v1`), `OPENROUTER_API_KEY`, `@openrouter/ai-sdk-provider`, `@openrouter/sdk`, the `openrouter` PyPI package, `openai` clients with an OpenRouter `baseURL` / `base_url`, LiteLLM `openrouter/` models, framework model classes pointed at OpenRouter.
2. Find where the conversation id lives per request: chat thread id, conversation id, session id, agent run id. It must be per conversation, never a process constant or a per-client default.
3. Existing OTel exporting to Maple? Search for `TracerProvider`, `NodeSDK`, `registerOTel`, `registerTelemetry`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `ingest.maple.dev`, `logfire.configure`, OpenInference / OpenLLMetry instrumentors.
   - Yes → do Step 2 and Step 3 (nesting).
   - No → Step 2 only (Broadcast-only). Mention that the app's framework skill adds tool spans and agent structure.
4. Which endpoint region the app calls (`openrouter.ai` vs `eu.openrouter.ai`), for the destination's data regions.

## Step 1: Key and region (for the destination headers)

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion. Test Connection passes with it, but nothing lands.
- Never put a private `maple_sk_` key in browser code. The key here goes into OpenRouter's dashboard, not the repo.
- If the app also exports its own OTel to Maple, follow the repo's existing secret/env convention for that exporter. Ingest keys are write-only, so inline is acceptable if there is none.

## Step 2: Send `session_id` on every OpenRouter request

Same id for every request of one conversation, new id per conversation, max 256 characters. If the app also has framework instrumentation, use the SAME value as the framework's conversation/session id (a trace with two different ids is assigned to the lexically larger one, silently).

`openai` npm (>= 7; field is untyped, sent as-is):

```ts
const completion = await client.chat.completions.create({
	model,
	messages,
	// @ts-expect-error OpenRouter-only field
	session_id: conversationId,
})
```

Or per-request header, no type workaround:

```ts
await client.chat.completions.create({ model, messages }, { headers: { "x-session-id": conversationId } })
```

`openai` PyPI (>= 3): `extra_body={"session_id": conversation_id}` on `chat.completions.create(...)` (and on `responses.create(...)` if used).

Vercel AI SDK + `@openrouter/ai-sdk-provider` (>= 3.1): `providerOptions: { openrouter: { session_id: conversationId } }` on `generateText` / `streamText` / agent calls. Everything under `providerOptions.openrouter` is merged into the body.

`@openrouter/sdk`: `openRouter.chat.send({ model, messages, sessionId: conversationId })`. `openrouter` PyPI: `session_id=conversation_id`.

Other clients: find the framework's extra-body or per-request-headers option and set `session_id` / `x-session-id`. Check the outgoing request (log the body once, or a test that captures `fetch`) to confirm the field is actually sent; some wrappers drop unknown fields.

Optional: `user` (<= 128 chars) is forwarded as `user.id`. Maple does not use it for sessions. Never put emails/names in `user`, `session_id` or `trace` metadata: Privacy Mode does not strip them.

## Step 3: Nest Broadcast under the app's own traces (only if the app exports OTel to Maple)

Without this, every model call is recorded twice (app span + Broadcast trace) and Broadcast-only turns split one per model call. Put the active span's W3C ids in `trace.trace_id` (32 hex) and `trace.parent_span_id` (16 hex).

TypeScript: wrap `fetch` and pass it to the client (`new OpenAI({ baseURL, apiKey, fetch: openRouterFetch })` or `createOpenRouter({ apiKey, fetch: openRouterFetch })`). Reads the span active when the SDK sends the request, which is the framework's model-call span if it has one:

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

- Add `@opentelemetry/api` only if it isn't already a dependency (it is, wherever OTel is set up).
- If the app has a single custom `fetch` already, compose with it instead of replacing it.

Python (`openai` or any client with `extra_body`): build the body at the call site:

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
```

This parents to the span current at the call site (turn/agent span), so the app's model span and Broadcast's `LLM Generation` are siblings. Maple dedupes siblings only by `gen_ai.response.id` (OpenRouter's `gen-…` id). Check that the app's instrumentation records the response id (Vercel AI SDK `ai.response.id`, OTel `openai-v2` instrumentor `gen_ai.response.id`). If it doesn't, tell the user tokens will double-count for that service, and offer to exclude that service's OpenRouter API key from the destination instead.

Don't set `trace_name` / `span_name` / `generation_name` unless the user asks: `span_name` creates an extra intermediate span.

## Step 4: Content

Broadcast includes prompts and completions by default (`gen_ai.prompt`, `gen_ai.completion` on `LLM Generation`). The completion object has also been seen echoing the request body (tool definitions, `user`, `session_id`, `trace`). Nothing to change in code. If the user must keep content out of Maple: tell them to enable **Privacy Mode** on the destination (tokens, cost, timing and metadata still arrive).

## Step 5: Tools, errors, sub-agents

- Broadcast has no tool spans and no agent names. Don't add fake tool spans. Point the user to their framework's skill for tools/lanes.
- Provider fallbacks show as `provider attempt N: <provider>` children; a failed attempt followed by a successful one is a retry and not counted as a failure.
- A call where every provider failed: `LLM Generation` status Error, message `Provider returned error`, counted as `provider_error`. On this path OpenRouter drops the `trace` object, so it's its own trace (still in the right session via `session.id`).

## Step 6: Flush

Broadcast needs none: OpenRouter exports from its servers after each request. Delivery lag is about a minute. If the app exports its own spans, keep/ensure its normal shutdown flush (`sdk.shutdown()`, `provider.force_flush()`), otherwise nested Broadcast spans point at a missing parent.

## Step 7: Hand the user the dashboard settings

Print these, filled in (you cannot apply them):

1. OpenRouter → Settings → Observability (`https://openrouter.ai/settings/observability`) → **Enable Broadcast** (org accounts: org admin only).
2. Edit **OpenTelemetry Collector**:
   - Endpoint: `https://ingest.maple.dev/v1/traces` (EU: `https://ingest.eu.maple.dev/v1/traces`). Full path; OpenRouter does not append `/v1/traces`.
   - Headers: `{ "Authorization": "Bearer <key>" }`
   - Sampling rate: `1` (sampling is per session; lower values drop whole conversations).
   - API keys: empty, or include the key(s) the app uses. Excluded keys always win.
   - Data regions: include Europe if the app calls `eu.openrouter.ai`.
   - Privacy Mode: off unless content must not leave OpenRouter.
   - Leave **Additional generation metadata → Cost** off; Maple reads `gen_ai.usage.total_cost`, which is sent anyway.
3. Click **Test Connection**; it only saves if the test passes. A 401 (`ingest_unauthorized` / "Invalid ingest key") with a key you trust usually means the key belongs to the other region (keys are region-bound): switch the endpoint to the other region.

## Step 8: Verify

Run one conversation (3+ turns, one with a tool call) with a fixed `session_id`, then a second conversation. If the app has no scriptable entry point (server or UI only), write a small driver: one conversation id, 3 turns, one tool call. Wait about a minute. In Maple → Agent Sessions (`https://app.maple.dev/agent-sessions`, EU `app.eu.maple.dev`), filter service `openrouter` (plus the app's service if nested). Check:

- Exactly one session per conversation, id = your `session_id`, vendor OpenRouter. No `trace:<id>` sessions. With the Maple MCP: `list_agent_sessions` with `search=<session_id>` returns one row.
- Each model call = one `LLM Generation` span with `gen_ai.operation.name=chat`, `gen_ai.request.model` (OpenRouter slug), `gen_ai.response.id` (`gen-…`), input/output tokens, `gen_ai.usage.total_cost`.
- Session tokens, LLM-call count and cost ≈ what the app made (not ~2x). If ~2x: Step 3 nesting or response-id match is missing.
- Nested case: `LLM Generation` has a parent in the app's trace; turns = the app's turns, not one per model call.
- Transcript shows each call's prompt and completion (absent if Privacy Mode is on).
- Streamed calls have tokens too (OpenRouter accounts server-side).
- Tool counts from Broadcast are 0 (expected). Tool spans only come from app instrumentation.
- No attribute contains `sk-or-`, `Bearer ` or `maple_sk_`.

Tell the user: cost is shown (OpenRouter's charge); TTFT, environment, tool calls and agent lanes are not available from Broadcast.

## Known behavior (tell the user when relevant)

- Transport: OTLP over HTTP with JSON encoding only; Maple ingest accepts JSON on `/v1/traces`, no collector needed.
- `session_id` also makes OpenRouter route a session's requests to the same provider (better prompt-cache hits). Body `session_id` wins over the `x-session-id` header if both are sent.
- No `session_id` → each call is its own session named `trace:<trace id>`, one turn, one model call.
- Turns: Maple counts one turn per trace, so Broadcast-only a user message with three model calls = three turns (Segment 1, 2, ...).
- Dedup when nested: if `LLM Generation` is a descendant of the app's model-call span, usage is counted at the deepest span that reports it; siblings or separate traces are matched by `gen_ai.response.id`. When both spans carry cost, Maple keeps the larger (OpenRouter's).
- Span tree: `LLM Generation` root, `provider attempt N: <provider>` children, sometimes `generation` / `moderation` children. Only `LLM Generation` counts as a model call.
- Content format: `gen_ai.prompt` = `{"messages": [...]}`, `gen_ai.completion` = `{"completion": "...", "reasoning": "..."}`, both JSON strings. Values over 10,000,000 chars are shortened with a `<key>.truncated` attribute; ingest body limit 20 MiB.
- Attributes on `LLM Generation`: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.input_tokens.cached` (included in input), `gen_ai.usage.output_tokens.reasoning` (included in output), `gen_ai.usage.total_cost` (USD, actual charge), `gen_ai.request.model` / `gen_ai.response.model` (OpenRouter slug), `gen_ai.response.finish_reasons`.
- Not read by Maple: `trace.metadata.openrouter.first_token_ms` (Maple reads TTFT only from `gen_ai.response.time_to_first_chunk`), the **Cost** generation-metadata option's `span.metadata.openrouter_generation.*`.
- `gen_ai.provider.name` = the model's author (`openai`, `anthropic`); the serving provider is `trace.metadata.openrouter.provider_name` (e.g. `Amazon Bedrock`).
- Streaming: tokens and cost present without `stream_options.include_usage` (server-side accounting).
- `service.name` on Broadcast spans is always `openrouter`, no environment attribute. Custom keys in the `trace` object arrive as `trace.metadata.<key>` (searchable in Traces, don't set service/environment).
- OpenRouter's sample trace (`Test Trace - OpenRouter Observability`, an `openai/gpt-4-turbo` call with sample tokens/cost) can appear as a session; ignore it.
- Test Connection passes but nothing arrives: check API key filter, data regions, **Enable Broadcast** on the account/org the app key belongs to, and that the key isn't `MAPLE_TEST`.
- Destinations can be created via OpenRouter's observability API (`type: "otel-collector"`) with a management key (only if the user explicitly asks and provides a management key).
