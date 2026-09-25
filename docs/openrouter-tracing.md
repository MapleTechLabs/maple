# OpenRouter Attribution And Tracing

Maple attributes every OpenRouter request to its app page on openrouter.ai and tags it with the
surface it came from, the org it ran for, and the session it belongs to. Separately, OpenRouter
Broadcast can send each completion as an OTLP/HTTP trace to any backend that accepts JSON OTLP on
`/v1/traces`, including Maple's own ingest gateway.

References verified on August 4, 2026:

- App attribution: https://openrouter.ai/docs/app-attribution
- User tracking: https://openrouter.ai/docs/guides/guides/administration/user-tracking
- Broadcast to OpenTelemetry Collector: https://openrouter.ai/docs/guides/features/broadcast/otel-collector

## Where OpenRouter Is Called

| Path                                 | Client                              | Surfaces                                                   |
| ------------------------------------ | ----------------------------------- | ---------------------------------------------------------- |
| `apps/ai/src/platform/Llm.ts`        | Effect AI (`@effect/ai-openrouter`) | chat turns, investigation passes, and pull request reviews |
| `apps/ai/src/mcp/__evals__/model.ts` | `@ai-sdk/openai-compatible`         | MCP evals in CI, **not** attributed or tagged              |

`apps/ai` can also run on Cloudflare Workers AI (`MAPLE_LLM_PROVIDER=workers-ai`). None of the
attribution below applies on that path. The tag fields are OpenRouter's, and `resolveTriageModel`
keeps them off the Workers AI branch.

## App Attribution

`HTTP-Referer` creates the app page on openrouter.ai. A title on its own does nothing, and usage
without a referer never appears in the rankings. Every caller sends the same URL and title on
purpose: the referer is the app's identity, so a second value would mint a second app entry and
split the rankings.

| Header         | Value               | Set at                                                                |
| -------------- | ------------------- | --------------------------------------------------------------------- |
| `HTTP-Referer` | `https://maple.dev` | `apps/ai/src/platform/Llm.ts` (`OPENROUTER_APP_URL`, `openRouterHttp`) |
| `X-Title`      | `Maple`             | same file, `OPENROUTER_APP_TITLE`                                     |

Per-app analytics then live at https://openrouter.ai/apps.

## Per-Request Tags

`resolveTriageModel(env, tags)` and `resolveReviewModel(env, tags)` take an optional `LlmCallTags`
(`surface`, `orgId`, `sessionId`, plus `turnId` and `workflowName` for spans). The OpenRouter
fields are folded into the model config, so every call made with the returned model carries them
without each call site threading them through.

| Field              | Maple value                                                                                                              | Where it shows up                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`             | Maple org id                                                                                                             | the `/activity` page, activity exports, and the `/generations` API. OpenRouter folds it into a hashed identity and never forwards it raw upstream. |
| `session_id`       | the chat session id (`<orgId>:inv-<investigationId>` for an investigation's passes), truncated to OpenRouter's 256-character limit | groups the requests of one conversation or investigation, and makes OpenRouter route the whole session to one provider so prompt caches hit |
| `trace.trace_name` | `chat` or `bot`                                                                                                          | forwarded to configured Broadcast destinations only. It does **not** appear in the OpenRouter dashboard.                                          |

The same session id goes onto Maple's own model-call spans as `maple_ai.session.id`, so a call and
its Broadcast mirror land in one agent session.

## Configure OpenRouter Broadcast To Maple

Use this when you want OpenRouter-generated LLM traces to land in Maple. This is also the only way
the `trace` metadata above becomes visible anywhere.

1. In Maple, copy the org's private ingest key from Settings -> Ingestion. It has the `maple_sk_...` prefix.
2. In OpenRouter, open Settings -> Observability and enable Broadcast.
3. Edit the OpenTelemetry Collector destination.
4. Set the endpoint:

```text
https://ingest.maple.dev/v1/traces
```

For self-hosted Maple, use the externally reachable ingest gateway URL:

```text
https://<your-ingest-host>/v1/traces
```

5. Set headers to:

```json
{
	"Authorization": "Bearer maple_sk_..."
}
```

6. Use OpenRouter's Test Connection action, then send a Maple chat message.

OpenRouter only emits Broadcast traces for traffic under the OpenRouter account or workspace where
Broadcast is enabled. Maple has no BYOK path: every org's traffic runs on Maple's own
`OPENROUTER_API_KEY`, so Broadcast is configured once, on Maple's OpenRouter account.

## Querying In Maple

OpenRouter Broadcast traces use standard GenAI semantic convention attributes such as `gen_ai.*` for
model, usage, and cost data. The tag fields arrive under OpenRouter's `trace.metadata.*` namespace.

Useful filters:

```text
trace.metadata.trace_name = "chat"
session.id = "<orgId>:inv-<investigationId>"
```

If prompt or completion content should not leave OpenRouter, enable Privacy Mode for the OpenRouter
observability destination. OpenRouter's docs state that Privacy Mode excludes prompt and completion
content while still sending timing, model, token usage, cost, and metadata.

## Local Test Coverage

The attribution and tagging contract is covered by:

```bash
bun run --cwd apps/ai vitest run src/platform/Llm.test.ts
```

Those tests swap `FetchHttpClient.Fetch` for a capture and assert, on the outgoing request, that
Maple sends the attribution headers, the `user` / `session_id` / `trace` fields, omits `session_id`
when there is no session, truncates an over-long one, and sends none of it on the Workers AI path.
