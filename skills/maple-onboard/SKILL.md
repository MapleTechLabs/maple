---
name: maple-onboard
description: "Onboard a project to Maple by installing OpenTelemetry traces, logs, and metrics across every app and service in the repo. Triggers on requests like 'install Maple', 'set up Maple', 'add Maple telemetry', 'onboard this repo to Maple', 'instrument with OpenTelemetry for Maple'."
---

# Maple onboarding

Wire OpenTelemetry traces, logs, and metrics into the user's project so telemetry streams to Maple. Cover **every app and service in the repo**, not only the one the user is currently working in.

Prefer native OpenTelemetry APIs and the framework's documented bootstrap over custom helper layers. If a specific stack stumps you, search the OTel docs for that language; don't guess.

Before editing, read the applicable companion skills:

- `maple-onboarding-style` for the cross-language rules: the business-span pattern, resource attributes, signal quality, LLM calls, smoke checks.
- `maple-nextjs-style` for Next.js / Vercel apps.
- `maple-nodejs-style` for plain Node servers (Express, Fastify, Hono, Bun).
- `maple-python-style` for Python services (FastAPI, Django, Flask).
- `maple-effect-style` for Effect-based services (Maple's first-class SDK).
- `maple-go-style`, `maple-rust-style`, `maple-java-style`, `maple-csharp-style`, `maple-kotlin-style` for those stacks.

If they are not installed next to this skill, read them from https://github.com/MapleTechLabs/maple/tree/main/skills. If none match the stack (Ruby, Elixir, PHP, plain Deno, …), use `maple-onboarding-style` and the upstream OTel docs for that language.

## Step 0: Region, endpoint, and key

Maple runs two separate regions. A key only works in the region that issued it; the other region answers `401`.

| Region | Ingest endpoint | Dashboard | MCP server |
| --- | --- | --- | --- |
| US (default) | `https://ingest.maple.dev` | `https://app.maple.dev` | `https://api.maple.dev/mcp` |
| EU | `https://ingest.eu.maple.dev` | `https://app.eu.maple.dev` | `https://api.eu.maple.dev/mcp` |

Pick the region in this order: an ingest endpoint in the prompt (use it verbatim), an EU mention or an `eu.maple.dev` URL in the prompt, otherwise US. Use that region's hosts everywhere below: `<dashboard>` and `<mcp>` mean that region's dashboard and MCP server from this table. The endpoint is not a secret and **goes inline** in the bootstrap code.

The **ingest key** is **project-scoped and write-only**. It can only send telemetry to one organization; it can't read anything or change settings. Treat it like a Sentry DSN or a PostHog public key: **inline it directly in the OTel bootstrap source** alongside the endpoint. No `.env` files, no deploy-target wiring, no `process.env.OTEL_EXPORTER_OTLP_HEADERS`. The user deploys their code and events flow.

Each organization has two ingest keys with the same permissions:

- **Public key** (`maple_pk_…`). Safe in browser and mobile bundles. Use it everywhere, servers included, so one key covers the repo.
- **Private key** (`maple_sk_…`). Server-side code only. Never put it in a browser or mobile bundle.

Three paths, no questions asked:

- **Public key in the prompt:** inline it in every bootstrap file.
- **Private key in the prompt:** inline it in server-side bootstrap files only. Put `MAPLE_TEST` in browser and mobile code, and tell the user to swap in the public key there. Mention that the public key also works on servers, so one key can cover the repo.
- **No key:** inline the literal sentinel `MAPLE_TEST`. Both regions accept it and return 200 without storing anything, so the app can boot and exercise the OTel bootstrap path while the user gets a real key. Tell the user *briefly* at the top of your work: "I'm using `MAPLE_TEST` as a placeholder so the bootstrap can run. Copy your public ingest key from Settings → Ingestion (<dashboard>/settings?tab=ingestion) and search-replace `MAPLE_TEST` in the files I write." Then keep going. Don't block install on signup.

## Step 1: Map every app/service in the repo

Before instrumenting anything, enumerate what's here. Check workspace manifests (`pnpm-workspace.yaml`, root `package.json` `workspaces`, `bun` workspaces, `go.work`, Cargo workspace, Python `pyproject.toml` workspace setups, `apps/*` and `services/*` conventions). Identify each service: web frontend, API, workers, background jobs, CLIs, sample/demo apps, mobile apps, Supabase and/or server functions. Mobile and serverless/edge functions are in scope; do not skip them merely because they are client-side or short-lived. Skip pure type/config packages with no runtime entry point. Do not skip any runnable services or leave them "out of scope": instrument absolutely everything in this run; there may be no follow-up.

Print the list before you start so the user can correct it, then continue without waiting for a reply.

## Step 2: For each service, install native OTel and bootstrap

**Use the language's native OpenTelemetry SDK.** Don't reach for vendor wrappers or hand-rolled helpers when an official package exists. What "native" means per stack:

- Node servers: `@opentelemetry/sdk-node`.
- Next.js / Vercel, server side: `@vercel/otel` (sdk-node breaks Next's webpack and misses the framework bootstrap).
- Browser frontends (Vite, SPA, the client side of Next.js): `@maple-dev/browser`, Maple's browser SDK. It is OTel web tracing plus error capture and session replay that share one `session.id`; raw `@opentelemetry/sdk-trace-web` gives you spans only.
- Expo / React Native: `@opentelemetry/sdk-trace-web` with an OTLP HTTP exporter.
- Python: `opentelemetry-sdk` + `opentelemetry-instrumentation-*`. Go: `go.opentelemetry.io/otel`.

No broad wrapper APIs. Avoid reusable helpers like `sendMapleSpan`, `recordCounter`, `recordLog`, `startTelemetrySpan`, or `withTelemetry`. Acquire native tracers/meters/loggers at module scope and use the SDK's own APIs directly. In TypeScript/JavaScript that means `tracer.startActiveSpan` with `try` / `catch` / `finally` (see `maple-onboarding-style`).

Wire all three signals on servers: traces, logs, metrics. **Logs go through OTLP, not just stdout.** Set up the OTel log bridge for the language so app logs (with their existing log levels and structured fields) carry the active `trace_id` / `span_id` automatically. The user's existing logger keeps working; you only add an OTLP handler/processor underneath. Browser frontends get traces and errors (plus replay) from `@maple-dev/browser`.

Bootstrap rules:

- The bootstrap file must run before any framework imports. Use the language/framework's documented hook (`--import` flag, `instrumentation.ts`, top-of-`main.py` import, etc.).
- Inline the region's endpoint and the ingest key directly in the bootstrap source (Step 0). Don't read from `process.env.OTEL_EXPORTER_OTLP_*` or write any `.env` files. Inline configuration removes a whole class of "OTel didn't start because env vars weren't set" deploy failures. (See the framework-specific style skills for the exact shape per stack.)
- Use HTTP OTLP exporters, not gRPC. gRPC pulls in native bindings that break bundlers and complicate containers.
- Use the project's existing package manager (detect via lockfile).
- Prefer idempotent edits. If a config file already exists, edit don't overwrite.
- Set the resource attributes from `maple-onboarding-style` on every service: `service.name`, `service.version`, `deployment.environment.name`, `vcs.repository.url.full` (required on servers), and `vcs.ref.head.revision` (best effort). Use those semantic-convention keys exactly.

Framework rules:

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

**Coexist with existing observability vendors. Don't remove Sentry, Datadog, New Relic, Honeycomb, Logtail, Pino transports, etc.** OTel sits alongside them. The user wants both flowing during migration; removing the incumbent is not your call.

## Step 3: Add custom spans, metrics, and logs around business operations

Auto-instrumentation covers HTTP in/out, DB queries, and framework lifecycle. That is the floor. Read the project to find the operations an operator would want to see when something looks wrong.

### Traces

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

### LLM calls

If the project calls OpenAI / Anthropic / Google / any LLM provider, follow `maple-onboarding-style` "LLM calls": provider instrumentation (OpenInference) where it exists, `maple_ai.session.id` on each turn so Agent Sessions can group a conversation, and `gen_ai.usage.cost` only when the provider reports a billed cost. Maple does not price tokens.

## Step 4: Verify the app still works and telemetry arrives

Per service:

1. **Run the project's own dev or build command** (whatever its `package.json` / `pyproject` / `Makefile` already wires up). Confirm it starts cleanly with no errors that trace back to your OTel install. Also run a telemetry bootstrap smoke that imports or starts the app, so provider setup, exporter construction, log bridging, and framework instrumentation all initialize. For a Python server this can be an import/startup command such as `uv run python -c 'from app.main import app; print(app.title)'`; for Node/Next use the repo's build/start path. For a server, hit at least one route with curl so traffic flows through the instrumentation; choose a route that exercises an instrumented operation when practical, not only a static health route. For a CLI, invoke a real command. **Don't ship if the app's own startup is now broken.** That is a regression.
2. **Confirm telemetry leaves the process.** Exporters report failures and stay quiet on success, so turn diagnostics on for the smoke run and look for errors: `OTEL_LOG_LEVEL=debug` for Node's `NodeSDK` (each batch is dumped before it is sent; a failure logs `Export failed` / `OTLPExporterError` with the HTTP status); Python exporters log failures through `logging` at `WARNING`/`ERROR`, which reach stderr unless the app silences them; Go's default error handler prints to stderr. Batches sent and no export error once the process has shut down (so the final flush ran) means the exports got 2xx. A `401` means the key is wrong or belongs to the other region: try it once against the other region's ingest with curl. If both reject it, prove the export path with `MAPLE_TEST` for the smoke run, put the user's key back, and say in the hand-off that ingest rejected their key. As a network sanity check, `curl -X POST <endpoint>/v1/traces -H "authorization: Bearer MAPLE_TEST" -H "content-type: application/json" -d '{}'` returns 200. If the app's own exports never happen, the bootstrap is wrong (most often the SDK loads too late, or shutdown doesn't flush).
3. **Confirm the data landed (a key ingest accepted).** `MAPLE_TEST` stores nothing, so skip this with the placeholder or a rejected key. With a real key and the Maple MCP tools available, wait about a minute after the smoke traffic, call `list_services`, and check that every instrumented service is listed under the `service.name` you set. Then call `audit_setup` and fix the instrumentation findings it reports (missing signals, `service.name` mismatches, attribute gaps). Without MCP, tell the user that Settings → Ingestion shows when the first data arrives.

A bootstrap that loads but never exports is not a partial success. Fix it before moving on.

## Step 5: Hand-off (final message to the user)

### What changed

3–7 short factual bullets covering: packages installed, files created/modified, business spans/metrics added. Per service if changes differed, grouped if uniform. Mention any existing observability vendor (Sentry, Datadog, Logtail, Pino transports, etc.) you intentionally left in place so the coexistence is explicit. If you added `@maple-dev/browser`, say that session replay is on with inputs masked (`replay: { enabled: false }` turns it off), and that it keeps a persistent visitor id in localStorage and a cookie (`privacy: { persistVisitorId: false }` turns it off). Both matter for the user's privacy and cookie notices.

### Swap the placeholder if you used one

If `MAPLE_TEST` is still inline, tell the user:

> "The bootstrap currently uses `MAPLE_TEST` as a placeholder so the install could complete end-to-end. Copy your public ingest key from Settings → Ingestion (<dashboard>/settings?tab=ingestion), then search-replace `MAPLE_TEST` in the files I wrote and redeploy. If your organization is in the EU region (the dashboard is at app.eu.maple.dev), also replace `ingest.maple.dev` with `ingest.eu.maple.dev`, or set `region: "eu"` in the Maple SDKs."

Leave out the EU sentence if you already used the EU endpoint.

### Deploy

Tell the user to deploy as they normally would: push to their hosting platform, run their existing CI, or run locally. There are no env vars to wire and nothing platform-specific to configure: the endpoint and key are inline in the bootstrap, so events start flowing the moment the instrumented code runs.

If the user asks "where do I put the key in production?", the answer is "you already did; it's in the source you just deployed."

## Step 6: Drive Maple MCP install

Skip this if the Maple MCP tools are already available. Otherwise suggest installing the Maple MCP server so the agent (Claude Code, Codex, Cursor, etc.) can query telemetry directly the next time the user is debugging: search logs, pull traces, and check error rates from the chat without switching to the dashboard. Use `<mcp>` for the region from Step 0.

For **Claude Code**, offer to run it for them:

```
claude mcp add --transport http maple <mcp>
```

This edits the user's Claude Code config. **Confirm before running** (the user may have a custom MCP scope or want to install elsewhere). If they decline, print the command so they can run it themselves later.

For other agents the user might also use, mention but do *not* run:

- **Codex:** `codex mcp add maple --url <mcp>`
- **Cursor / others:** copy the `mcpServers` snippet from Settings → MCP in the Maple dashboard (`<dashboard>/mcp`).

## Hard rules

- Never modify files outside the project root.
- Never commit, push, or open PRs.
- Inline the ingest key in source. It's a write-only token (think Sentry DSN); env-var indirection just adds deploy-time failure modes for no gain.
- Never put a private key (`maple_sk_…`) in browser or mobile code.
- Never remove an existing observability vendor unless the user asks for it.
- Use the project's existing package manager and existing logger.
- Prefer native OTel packages for the language; don't reinvent telemetry plumbing the SDK already provides.
- If the dev/build command errors out *because of* your instrumentation, that is a failure. Fix it or report it; don't paper over it.
