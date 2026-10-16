---
name: maple-onboarding-style
description: "General OpenTelemetry onboarding style for Maple: native APIs, the business-span pattern, inline keys, VCS resource attributes, per-framework notes, business signals, export verification, LLM calls, and smoke checks."
---

# Maple OTel onboarding style

Use native OpenTelemetry APIs. Do not invent helper APIs.

## Business spans in TypeScript/JavaScript

Use `tracer.startActiveSpan` with `try` / `catch` / `finally`: record the exception and set `Error` status before rethrowing, and end the span in `finally`. The callback form keeps the span active for everything inside it, in browsers too, and keeps the function sync or async as it was. Don't hide this behind a local helper (`withSpan`, `traced`, …). Don't add spans around provider SDK calls that OpenInference / provider instrumentation already observes.

Do:

```ts
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api"

const tracer = trace.getTracer("orders.api")
const meter = metrics.getMeter("orders.api")
const ordersSubmitted = meter.createCounter("orders.submitted")

export async function submitOrder(tenantId: string, orderId: string) {
	return tracer.startActiveSpan("order.submit", async (span) => {
		try {
			span.setAttributes({ "tenant.id": tenantId, "order.id": orderId })
			const receipt = await chargeOrder(orderId)
			ordersSubmitted.add(1, { "tenant.id": tenantId, outcome: "success" })
			return receipt
		} catch (err) {
			span.recordException(err as Error)
			span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
			ordersSubmitted.add(1, { "tenant.id": tenantId, outcome: "failure" })
			throw err
		} finally {
			span.end()
		}
	})
}
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

Inline the endpoint and the ingest key directly in the bootstrap source and pass them explicitly to the exporter: its own URL option (`url` in JavaScript, `endpoint` in Python; each language skill shows the exact shape) plus `headers`. Don't read `OTEL_EXPORTER_OTLP_*` env vars and don't write `.env` files. `maple-onboard` Step 0 decides the region and which key goes where.

```text
MAPLE_ENDPOINT = "https://ingest.maple.dev"   # EU organizations: https://ingest.eu.maple.dev
MAPLE_KEY      = "maple_pk_…"                 # public ingest key, or "MAPLE_TEST" until the user has one
```

`MAPLE_TEST` is accepted by both regions and dropped, so the bootstrap exercises the full code path before the real key arrives.

If the repo can call telemetry init from multiple paths, guard provider/exporter setup so repeated imports, tests, reloads, or framework callbacks do not install duplicate processors or log handlers. For a single-entrypoint app that starts cleanly, keep this simple.

Set these resource attributes on every service: `service.name` (the app's own name, e.g. its package name without the scope), `service.version` (the package.json version, a release tag, or the commit SHA), `deployment.environment.name`, and the VCS attributes below.

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

## Framework notes

- **Next.js/Vercel:** server side uses `instrumentation.ts` with `@vercel/otel` `registerOTel(...)`. Do not substitute a raw `@opentelemetry/sdk-node` / `NodeSDK` bootstrap unless the repo already uses that architecture and you are extending it. Use `@opentelemetry/api` tracers/meters inside route handlers only where auto-instrumentation is blind. The client side uses `@maple-dev/browser` from a client component in the root layout (see `maple-nextjs-style`).
- **Browser frontends:** call `MapleBrowser.init` once at the top of the entry module:

	```ts
	import { MapleBrowser } from "@maple-dev/browser"

	MapleBrowser.init({
		ingestKey: "MAPLE_TEST", // public key (maple_pk_…) only
		serviceName: "acme-web",
		region: "us", // "eu" for EU organizations
		environment: import.meta.env.MODE,
		tracing: { propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//] },
	})
	```

	Use `region`; pass `endpoint` instead only when the prompt's endpoint is not a Maple host (a proxy or self-hosted ingest). Session replay is on by default with inputs masked; say so in the hand-off. If the API is on another origin, list it in `tracing.propagateTraceHeaderCorsUrls`, or browser and server spans land in separate traces. The API's CORS preflight must also allow `traceparent`. Check the current preflight response first: many setups (the `cors` package default) already echo the requested headers. Only when the config has an explicit allow-list, add `traceparent` to it and keep the existing entries. Effect frontends use `@maple-dev/effect-sdk/client` instead (see `maple-effect-style`).
- **Expo/React Native:** preserve existing Expo Go / unsupported-runtime guards. In supported builds, initialize telemetry before other SDKs that wrap `fetch` or the global error handler, and before app registration/user code. Inline the endpoint + public key in the observability module, with no `EXPO_PUBLIC_*` env vars.
- **Supabase Edge Functions / Cloudflare Workers:** native Deno / Workers OpenTelemetry can be quirky. Keep the exporter shim tiny, provider-neutral, and OTel-shaped: `tracer.startActiveSpan`, `span.setAttributes`, `SpanStatusCode`, `meter.createCounter`, `histogram.record`. For Effect on Workers, use `@maple-dev/effect-sdk/cloudflare` (see `maple-effect-style`).
- **Python/FastAPI:** use native instrumentation such as `FastAPIInstrumentor.instrument_app(app)` rather than replacing request handling with manual middleware.

## Business signals

Auto-instrumentation covers HTTP in/out, DB queries, and framework lifecycle. That is the floor. Read the project to find the operations an operator would want to see when something looks wrong.

### Business spans

Wrap **every critical business operation** with an active span. Auto-instrumented spans are fine where they exist. If an operation isn't already getting a span, add one.

- Naming: `domain.verb` (`order.process`, `payment.charge`, `email.send`, `agent.run`, `job.<type>`).
- Attributes: entity IDs (order.id, user.id, workspace.id, tenant.id), counts, key boolean branch outcomes.
- Record exceptions and set `Error` status on failure paths, and always end the span (`finally` in TS/JS).
- For Python functions with clear boundaries, prefer `@tracer.start_as_current_span("operation.name")`. Use a context manager when a decorator does not fit. Do not use detached `start_span()` + manual `end()` for bounded work.
- Skip trivial getters, pure transforms, and internal helpers: anything with no real latency or failure mode.
- **Never put PII in attributes** (emails, passwords, tokens, full request bodies).

### Logs

Make sure logs are **structured and carry operation context**. Concretely: every log line emitted inside a span should arrive at Maple with `trace_id` / `span_id` populated and any structured fields (orderId, userId, etc.) preserved as attributes. Trace/span context may be added natively by the log bridge or integration, or may require additional work.

Use logs for narrative ("starting batch reconcile", "retrying after 3xx") and exceptional events. An error log must only be emitted if the operation cannot recover and manual intervention is required. This applies to logs you add; leave existing log levels alone.

### Metrics

Cover **business and performance** signals:

- **Business logic counters.** Every meaningful state transition: created, started, completed, failed, retried. Break down per tenant, channel, or status, using low-cardinality dimensions only (never user/order IDs).
- **Performance histograms.** Latency of operations the user cares about, queue depth, batch sizes, payload sizes. Reuse existing timing instrumentation if the project has any (`time.perf_counter` blocks, custom `LatencyTracker`s, "[TIMING]" log lines). Emit a histogram from those measurements rather than measuring twice.

Get the meter once at module level, create instruments at module level, increment in the hot path. Don't create a fresh meter per call.

## Verify export

1. **Run the project's own dev or build command** (whatever its `package.json` / `pyproject` / `Makefile` already wires up). Confirm it starts cleanly with no errors that trace back to your OTel install. Also run a telemetry bootstrap smoke that imports or starts the app, so provider setup, exporter construction, log bridging, and framework instrumentation all initialize. For a Python server this can be an import/startup command such as `uv run python -c 'from app.main import app; print(app.title)'`; for Node/Next use the repo's build/start path. For a server, hit at least one route with curl so traffic flows through the instrumentation; choose a route that exercises an instrumented operation when practical, not only a static health route. For a CLI, invoke a real command. **Don't ship if the app's own startup is now broken.** That is a regression.
2. **Confirm telemetry leaves the process.** Exporters report failures and stay quiet on success, so turn diagnostics on for the smoke run and look for errors: `OTEL_LOG_LEVEL=debug` for Node's `NodeSDK` (each batch is dumped before it is sent; a failure logs `Export failed` / `OTLPExporterError` with the HTTP status); Python exporters log failures through `logging` at `WARNING`/`ERROR`, which reach stderr unless the app silences them; Go's default error handler prints to stderr. Batches sent and no export error once the process has shut down (so the final flush ran) means the exports got 2xx. A `401` means the key is wrong or belongs to the other region: try it once against the other region's ingest with curl. If both reject it, prove the export path with `MAPLE_TEST` for the smoke run, put the user's key back, and say in the hand-off that ingest rejected their key. As a network sanity check, `curl -X POST <endpoint>/v1/traces -H "authorization: Bearer MAPLE_TEST" -H "content-type: application/json" -d '{}'` returns 200. If the app's own exports never happen, the bootstrap is wrong (most often the SDK loads too late, or shutdown doesn't flush).

## LLM calls

If the app uses LLMs, first look for provider instrumentation that already captures model/provider/token/error spans. In JavaScript/TypeScript, prefer OpenInference packages such as `@arizeai/openinference-instrumentation-anthropic` or `@arizeai/openinference-instrumentation-openai` for supported SDKs. Keep the real provider call native and readable.

In Node, `getNodeAutoInstrumentations()` already includes `@opentelemetry/instrumentation-openai` (OTel `gen_ai.*` spans for the `openai` SDK). Use it for OpenAI and don't add OpenInference's OpenAI package as well, or every call is recorded twice. Check each instrumentation's supported SDK range against the installed SDK version: a mismatch installs cleanly and records nothing. Under ESM, OpenInference instrumentations need `manuallyInstrument(<the SDK module>)`.

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

**Cost.** Maple does not price tokens. It shows LLM cost only when a span carries `gen_ai.usage.cost` (USD); without it, Agent Sessions shows token counts and no cost. Set `gen_ai.usage.cost` when the provider returns the billed amount (OpenRouter returns `usage.cost` when the request sets `usage: { include: true }`; adding that flag is in scope). Record only that billed amount; leave cost unset when all you have is the app's own estimate. Put it on the span that makes the call when your code owns that span. When an instrumentation owns it, the span has ended before your code sees the response, so put the cost on the span that wraps the turn: it counts toward the session's cost, though not toward the per-model breakdown. Don't add a price table just for telemetry: prices change and a stale table reports wrong numbers. No `llm.cost_usd`-style metrics.

**Conversations.** Agent Sessions groups traces into one session by `maple_ai.session.id`. For a plain app (direct SDK calls, OpenInference, hand-written `gen_ai.*` spans), set `maple_ai.session.id` to the conversation or thread id on the span that wraps each turn, and `gen_ai.conversation.id` to the same value. Without it every trace is its own session. Agent frameworks that Maple recognizes (OpenAI Agents SDK, Mastra, Pydantic AI, Google ADK, CrewAI, …) emit their own session key; don't add one there. Use an opaque id, never an email or user name.

OpenInference `hideInputs` / `hideOutputs` keep prompts and completions out of telemetry. That is the safe default, but Agent Sessions then shows timing and tokens without a transcript. Tell the user which one you picked.

If the app has OpenAI, Anthropic, and Google callers, instrument all three.

## Smoke checks

Add a durable smoke path when the repo has a natural place for it: README, TESTING guide, script, npm command, pytest, or checked-in command note. If it has none, skip it; the Step 4 run is enough.

The smoke should explicitly prove startup/import with the OTel bootstrap loaded so provider setup, exporter construction, log bridging, and framework instrumentation initialize without errors. Then, where practical, exercise an actual instrumented span/log/metric or OTLP export attempt. A generic health route only proves the server responds; prefer an operation that crosses the instrumentation you added.
