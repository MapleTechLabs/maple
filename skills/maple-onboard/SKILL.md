---
name: maple-onboard
description: "Onboard a project to Maple by installing OpenTelemetry traces, logs, and metrics across every app and service in the repo. Triggers on requests like 'install Maple', 'set up Maple', 'add Maple telemetry', 'onboard this repo to Maple', 'instrument with OpenTelemetry for Maple'."
---

# Maple onboarding

Wire OpenTelemetry traces, logs, and metrics into **every app and service in the repo** so telemetry streams to Maple. Use native OpenTelemetry APIs and each framework's documented bootstrap. If a stack stumps you, read the OTel docs for that language; don't guess.

## Companion skills

Read `maple-onboarding-style` first (span pattern, resource attributes, framework notes, signal quality, verification), then the skill for each stack in the repo: `maple-nextjs-style`, `maple-nodejs-style`, `maple-python-style`, `maple-effect-style`, `maple-go-style`, `maple-rust-style`, `maple-java-style`, `maple-csharp-style`, `maple-kotlin-style`. If they are not installed next to this skill, fetch them from `https://raw.githubusercontent.com/MapleTechLabs/maple/main/skills/<skill-name>/SKILL.md`, only the ones this repo needs. Stacks without one (Ruby, Elixir, PHP, Deno, ...) use `maple-onboarding-style` and the upstream OTel docs. A service that calls an LLM also gets `maple-agent-tracing`.

## Step 0: Region, endpoint, and key

A key only works in the region that issued it; the other region answers `401`.

| Region | Ingest endpoint | Dashboard | MCP server |
| --- | --- | --- | --- |
| US (default) | `https://ingest.maple.dev` | `https://app.maple.dev` | `https://api.maple.dev/mcp` |
| EU | `https://ingest.eu.maple.dev` | `https://app.eu.maple.dev` | `https://api.eu.maple.dev/mcp` |

Pick the region in this order: an ingest endpoint in the prompt (use it verbatim), an EU mention or `eu.maple.dev` URL, otherwise US. `<dashboard>` and `<mcp>` below mean that region's hosts.

**Inline the endpoint and the ingest key in the bootstrap source.** The key is project-scoped and write-only (think Sentry DSN): no `.env` files, no `process.env.OTEL_EXPORTER_OTLP_*`, no deploy wiring. The public key (`maple_pk_…`) is safe everywhere, browser and mobile included. The private key (`maple_sk_…`) is server-only.

- **Public key in the prompt:** inline it in every bootstrap file.
- **Private key in the prompt:** server bootstrap files only. Put `MAPLE_TEST` in browser and mobile code and tell the user to swap in the public key there (it also works on servers, so one key can cover the repo).
- **No key:** inline the sentinel `MAPLE_TEST`. Both regions return 200 for it and store nothing, so the bootstrap runs end to end. Tell the user briefly up front: "I'm using `MAPLE_TEST` as a placeholder so the bootstrap can run. Copy your public ingest key from Settings → Ingestion (<dashboard>/settings?tab=ingestion), or create an account at <dashboard>/sign-up first, and search-replace `MAPLE_TEST` in the files I write." Then keep going. Don't block on signup.

## Step 1: Map every service

Enumerate from workspace manifests (pnpm/bun/npm workspaces, `go.work`, Cargo, Python workspaces) and `apps/*` / `services/*`: web frontends, APIs, workers, background jobs, CLIs, demo apps, mobile apps, serverless and edge functions. Skip only packages with no runtime entry point. Instrument everything in this run; there may be no follow-up. Print the list so the user can correct it, then continue without waiting.

## Step 2: Install native OTel and bootstrap each service

Use the language's native SDK:

- Node servers: `@opentelemetry/sdk-node`. Next.js server side: `@vercel/otel` in `instrumentation.ts`.
- Browser frontends (Vite, SPA, Next.js client): `@maple-dev/browser` (traces, errors and session replay sharing one `session.id`).
- Expo / React Native: `@opentelemetry/sdk-trace-web` with an OTLP HTTP exporter.
- Python: `opentelemetry-sdk` + `opentelemetry-instrumentation-*`. Go: `go.opentelemetry.io/otel`. Effect: `@maple-dev/effect-sdk`.

Rules:

- The bootstrap runs before any framework import, through the documented hook (`--import`, `instrumentation.ts`, top of `main.py`).
- HTTP OTLP exporters, never gRPC.
- Servers get traces, logs and metrics. Logs go through OTLP via the language's log bridge under the existing logger, so they carry `trace_id` / `span_id`.
- Set `service.name`, `service.version`, `deployment.environment.name`, `vcs.repository.url.full` (required on servers) and `vcs.ref.head.revision` (best effort).
- No wrapper APIs (`sendMapleSpan`, `recordCounter`, `withTelemetry`): module-scope tracers and meters, the SDK's own calls.
- Use the repo's package manager. Edit existing config; don't overwrite it.
- Keep existing vendors (Sentry, Datadog, New Relic, Pino transports, ...). OTel runs alongside them.

Per-framework details (browser init and CORS, Expo, Workers, FastAPI) are in `maple-onboarding-style` "Framework notes" and the stack skills.

## Step 3: Business spans, logs, and metrics

Auto-instrumentation is the floor. Read the code and add, per `maple-onboarding-style` "Business signals":

- **Spans** around every critical business operation (`order.process`, `payment.charge`, `job.<type>`): entity ids and outcomes as attributes, exceptions recorded, `Error` status on failure, always ended. Skip trivial helpers. No PII.
- **Logs** that are structured and trace-correlated. Error level only when manual intervention is needed.
- **Metrics:** counters for state transitions, histograms for latency and sizes, low-cardinality dimensions only.

## Step 4: Verify

Per service:

1. The project's own dev or build command still starts cleanly, and a smoke run (start or import the app, then one request through an instrumented route or a real CLI command) initializes the bootstrap. Broken startup is a regression: fix it.
2. Telemetry leaves the process: run with exporter diagnostics on and see no export error after the shutdown flush. `maple-onboarding-style` "Verify export" has the per-language switches and what to do on a `401`.
3. With a real key and Maple MCP tools, wait about a minute, call `list_services` to confirm each `service.name`, then `audit_setup` and fix what it reports. Skip this with `MAPLE_TEST`, which stores nothing; without MCP, tell the user Settings → Ingestion shows when data arrives.

A bootstrap that loads but never exports is not done.

## Step 5: Hand-off

- **What changed:** 3 to 7 short bullets: packages, files, business spans and metrics, vendors you left in place. If you added `@maple-dev/browser`, say session replay is on with inputs masked (`replay: { enabled: false }` turns it off) and that it keeps a visitor id in localStorage and a cookie (`privacy: { persistVisitorId: false }` turns it off).
- **Placeholder:** if `MAPLE_TEST` is still inline, tell the user: "The bootstrap uses `MAPLE_TEST` as a placeholder so the install could complete end to end. Copy your public ingest key from Settings → Ingestion (<dashboard>/settings?tab=ingestion); if you don't have a Maple account yet, create one at <dashboard>/sign-up first. Then search-replace `MAPLE_TEST` in the files I wrote and redeploy. If your organization is in the EU region (app.eu.maple.dev), also replace `ingest.maple.dev` with `ingest.eu.maple.dev`, or set `region: "eu"` in the Maple SDKs." Leave out the EU sentence if you used the EU endpoint.
- **Deploy:** as they normally do. There is nothing to configure: the key is in the source.

## Step 6: Maple MCP

Skip if Maple MCP tools are already connected to `<mcp>` (a server in the other region answers `401` or reads another organization). Otherwise offer to run, and confirm first: `claude mcp add --transport http maple <mcp>`. Mention without running: Codex `codex mcp add maple --url <mcp>`; Cursor and others copy the snippet at `<dashboard>/mcp`.

## Hard rules

- Never modify files outside the project root. Never commit, push, or open PRs.
- Never put a private key (`maple_sk_…`) in browser or mobile code.
- Never remove an existing observability vendor unless the user asks.
- If the dev or build command fails because of your instrumentation, fix it or report it.
