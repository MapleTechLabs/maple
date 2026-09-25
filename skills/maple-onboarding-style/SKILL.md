---
name: maple-onboarding-style
description: "General OpenTelemetry onboarding style for Maple: native APIs, withSpan, signal quality, inline keys, VCS resource attributes, LLM calls, and smoke checks."
---

# Maple OTel onboarding style

Use native OpenTelemetry APIs. Do not invent helper APIs.

## withSpan for TypeScript/JavaScript

For bounded business spans in TypeScript/JavaScript, add `@maple-dev/otel-helpers` to `package.json` and use its `withSpan`. It replaces expanding a whole function into `tracer.startActiveSpan(...)` plus `try` / `catch` / `finally`: it ends the span, and on throw records the exception, sets `Error` status, and rethrows. If the package can't be installed (offline, a private registry without it), write the `startActiveSpan` form instead; do not hand-roll a local `withSpan`. Do not use `withSpan` to wrap provider SDK calls that OpenInference / provider instrumentation already observes.

Do:

```ts
import { trace, metrics } from "@opentelemetry/api"
import { withSpan } from "@maple-dev/otel-helpers"

const tracer = trace.getTracer("orders.api")
const meter = metrics.getMeter("orders.api")
const ordersSubmitted = meter.createCounter("orders.submitted")

await withSpan(
	"order.submit",
	async (span) => {
		span.setAttributes({
			"tenant.id": tenantId,
			"order.id": orderId,
			outcome: "success",
		})
		ordersSubmitted.add(1, { "tenant.id": tenantId, outcome: "success" })
	},
	{ tracer },
)
```

Do not:

```ts
await sendMapleSpan(...)
recordCounter(...)
withTelemetry(...)
```

## Naming

- Files/functions are provider-neutral: `telemetry.ts`, `observability.ts`, `initTelemetry()`, `initObservability()`.
- The word Maple belongs only in endpoint/key setup comments or PR instructions.
- Span names are conventional and low-cardinality: `checkout.process`, `support.reply`, `llm.summarize_ticket`.
- Prefer semantic product-operation span names over provider transport names. `llm.summarize_ticket` is more useful than `llm.anthropic.messages.create`.

## Endpoint and key

Inline the endpoint and the ingest key directly in the bootstrap source and pass them explicitly via the exporter constructor's `endpoint` / `headers` options. Don't read `OTEL_EXPORTER_OTLP_*` env vars and don't write `.env` files. `maple-onboard` Step 0 decides the region and which key goes where.

```text
MAPLE_ENDPOINT = "https://ingest.maple.dev"   # EU organizations: https://ingest.eu.maple.dev
MAPLE_KEY      = "maple_pk_…"                 # public ingest key, or "MAPLE_TEST" until the user has one
```

`MAPLE_TEST` is accepted by both regions and dropped, so the bootstrap exercises the full code path before the real key arrives.

If the repo can call telemetry init from multiple paths, guard provider/exporter setup so repeated imports, tests, reloads, or framework callbacks do not install duplicate processors or log handlers. For a single-entrypoint app that starts cleanly, keep this simple.

Include standard resource attributes when values are available: `service.name`, `service.version`, `deployment.environment.name`, and the VCS attributes below.

## VCS resource attributes

Set `vcs.repository.url.full` on the OTel resource for every instrumented server-side service. The value is the canonical https URL of the repo (e.g. `https://github.com/acme/api`): the URL the user would paste in a browser, not an SSH URL or a local working-tree path. This is the important one; it lets Maple link telemetry back to the source. It is fine to hardcode this string alongside `service.name` in the SDK init; if a build env already exposes the slug (e.g. `VERCEL_GIT_REPO_OWNER` + `VERCEL_GIT_REPO_SLUG`, `RAILWAY_GIT_REPO_OWNER` + `RAILWAY_GIT_REPO_NAME`), prefer reading from env so a fork or rename doesn't drift. `@maple-dev/browser` has no option for it; that is fine.

Also set `vcs.ref.head.revision` (the commit SHA) on a best-effort basis. Read it from whatever env var the runtime/build platform already injects: `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, `GITHUB_SHA`, `SOURCE_COMMIT`, `GIT_COMMIT`, `HEROKU_SLUG_COMMIT`, etc. Do not shell out to `git` from the running process. Many production images have no git binary or working tree. If no env source is available, omit the attribute; skipping the SHA is fine, skipping the URL is not. (`@maple-dev/browser` sets it from `serviceVersion` when that is a commit SHA.)

Use `vcs.repository.url.full` and `vcs.ref.head.revision` exactly as named. These are the OTel semantic-convention keys. Do not invent parallel attributes like `git.repo`, `app.repo_url`, or `deployment.commit_sha`.

## Signals

- Traces: all critical operations have spans with relevant attributes.
- Logs: structured, concise, OTLP-forwarded, and trace/span-correlated.
- Metrics: critical operations have low-cardinality counters/histograms.
- Tenant/org/project information is included where available.
- Do not put raw user ids or request ids in metric tags unless the repo already treats them as bounded tenant-like ids.

## LLM calls

If the app uses LLMs, first look for provider instrumentation that already captures model/provider/token/error spans. In JavaScript/TypeScript, prefer OpenInference packages such as `@arizeai/openinference-instrumentation-anthropic` or `@arizeai/openinference-instrumentation-openai` for supported SDKs. Keep the real provider call native and readable.

```ts
const response = await client.messages.create({
	model,
	max_tokens: 100,
	messages,
})
```

Let provider instrumentation own model/provider/token spans where it supports them. Do not duplicate those attributes at every application call site. Where no provider instrumentation exists, put `gen_ai.*` semantic-convention attributes (`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) on the span that makes the call, plus `app.gen_ai.*` for bounded application dimensions such as use case and call site. Avoid inventing parallel `llm.*` attributes unless the repo already standardizes on them.

Token counters are only for usage provider instrumentation cannot capture:

```ts
llmInputTokens.add(inputTokens, {
	"tenant.id": tenantId,
	"gen_ai.provider.name": "anthropic",
	"gen_ai.request.model": model,
	"app.gen_ai.use_case": "support.reply",
	"app.gen_ai.call_site": "generateReply",
	outcome: "success",
})
```

Name them `llm.tokens.input` / `llm.tokens.output` with unit `{token}`. Use histograms for latency/duration distributions.

**Cost.** Maple does not price tokens. It shows LLM cost only when a span carries `gen_ai.usage.cost` (USD); without it, Agent Sessions shows token counts and no cost. Set `gen_ai.usage.cost` on the LLM span when the provider returns the billed amount (OpenRouter returns `usage.cost` when the request sets `usage: { include: true }`), or when the app already computes cost for billing or quotas. Don't add a price table just for telemetry: prices change and a stale table reports wrong numbers. No `llm.cost_usd`-style metrics.

**Conversations.** Agent Sessions groups traces into one session by `maple_ai.session.id`. For a plain app (direct SDK calls, OpenInference, hand-written `gen_ai.*` spans), set `maple_ai.session.id` to the conversation or thread id on the span that wraps each turn, and `gen_ai.conversation.id` to the same value. Without it every trace is its own session. Agent frameworks that Maple recognizes (OpenAI Agents SDK, Mastra, Pydantic AI, Google ADK, CrewAI, …) emit their own session key; don't add one there. Use an opaque id, never an email or user name.

OpenInference `hideInputs` / `hideOutputs` keep prompts and completions out of telemetry. That is the safe default, but Agent Sessions then shows timing and tokens without a transcript. Tell the user which one you picked.

If the app has OpenAI, Anthropic, and Google callers, instrument all three.

## Smoke checks

Add a durable smoke path when the repo has a natural place for it: README, TESTING guide, script, npm command, pytest, or checked-in command note.

The smoke should explicitly prove startup/import with the OTel bootstrap loaded so provider setup, exporter construction, log bridging, and framework instrumentation initialize without errors. Then, where practical, exercise an actual instrumented span/log/metric or OTLP export attempt. A generic health route only proves the server responds; prefer an operation that crosses the instrumentation you added.
