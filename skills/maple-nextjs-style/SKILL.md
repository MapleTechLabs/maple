---
name: maple-nextjs-style
description: "Next.js / Vercel OpenTelemetry style for Maple: instrumentation.ts, @vercel/otel bootstrap, native @opentelemetry/api call sites, inline endpoint + ingest key, no raw NodeSDK replacement, @maple-dev/browser on the client."
---

# Maple Next.js style

For Next.js apps, use the framework entrypoint, `instrumentation.ts` with `@vercel/otel`.

```ts
// instrumentation.ts
import { registerOTel } from "@vercel/otel"

const MAPLE_ENDPOINT = "https://ingest.maple.dev" // EU: https://ingest.eu.maple.dev
const MAPLE_KEY = "MAPLE_TEST" // public ingest key (maple_pk_…), or MAPLE_TEST until the user has one

export function register() {
	registerOTel({
		serviceName: "my-next-app",
		attributes: {
			"deployment.environment.name": process.env.VERCEL_ENV ?? "development",
			"vcs.repository.url.full": "https://github.com/acme/my-next-app",
			"vcs.ref.head.revision": process.env.VERCEL_GIT_COMMIT_SHA,
		},
		traceExporter: {
			url: `${MAPLE_ENDPOINT}/v1/traces`,
			headers: { authorization: `Bearer ${MAPLE_KEY}` },
		},
	})
}
```

Do not replace this with a custom `NodeSDK` bootstrap unless the repo is not a standard Next/Vercel app or already has a custom provider to extend.

For JavaScript/TypeScript LLM providers, use provider instrumentation instead of manual child spans. For Anthropic, add OpenInference in the same bootstrap and keep call sites native. This example uses `@vercel/otel@2.x`. If the installed types are v1, use `logRecordProcessor` (singular). Current `@opentelemetry/sdk-logs` takes `new BatchLogRecordProcessor({ exporter })`; older releases took the exporter as the first argument, and the wrong form silently drops every log. Check the installed `.d.ts`.

```ts
import Anthropic from "@anthropic-ai/sdk"
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { registerOTel } from "@vercel/otel"

const MAPLE_ENDPOINT = "https://ingest.maple.dev"
const MAPLE_KEY = "MAPLE_TEST"

const anthropicInstrumentation = new AnthropicInstrumentation({
	traceConfig: {
		hideInputs: true,
		hideOutputs: true,
	},
})

anthropicInstrumentation.manuallyInstrument(Anthropic)

export function register() {
	registerOTel({
		serviceName: "my-next-app",
		instrumentations: [anthropicInstrumentation],
		traceExporter: {
			url: `${MAPLE_ENDPOINT}/v1/traces`,
			headers: { authorization: `Bearer ${MAPLE_KEY}` },
		},
		logRecordProcessors: [
			new BatchLogRecordProcessor({
				exporter: new OTLPLogExporter({
					url: `${MAPLE_ENDPOINT}/v1/logs`,
					headers: { authorization: `Bearer ${MAPLE_KEY}` },
				}),
			}),
		],
	})
}
```

## Route handlers

Use native OTel APIs where auto-instrumentation is blind.

```ts
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api"

const tracer = trace.getTracer("my-next-app")
const meter = metrics.getMeter("my-next-app")
const generated = meter.createCounter("replies.generated")

export async function POST(request: Request) {
	const tenantId = request.headers.get("x-tenant-id") ?? "unknown"
	return tracer.startActiveSpan("reply.generate", async (span) => {
		try {
			span.setAttribute("tenant.id", tenantId)
			generated.add(1, { "tenant.id": tenantId, outcome: "success" })
			return Response.json({ ok: true })
		} catch (err) {
			span.recordException(err as Error)
			span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
			throw err
		} finally {
			span.end()
		}
	})
}
```

For TypeScript route handlers, wrap the business operation in `tracer.startActiveSpan(...)` with `try` / `catch` / `finally` (the shape in `maple-onboarding-style`). `@vercel/otel` already gives every request a span, so span the operation that matters rather than every handler by reflex. Don't hide the pattern behind a local helper.

If a route has an LLM call and OpenInference / provider instrumentation supports that SDK, do not wrap the provider call. Leave `client.messages.create(...)` / equivalent in place and put business context on the active product span or structured log. Do not duplicate provider/model/token attributes in route-level spans, logs, or metrics when OpenInference already reports them. Maple does not price tokens; see `maple-onboarding-style` "LLM calls" for cost and conversation grouping. For Anthropic in Next.js/ESM, keep the instrumentation instance and `manuallyInstrument(Anthropic)` call at module scope so it runs once and before route code.

Match the `@vercel/otel` logs option to the installed version: `@vercel/otel@1.x` takes `logRecordProcessor` (singular), `@vercel/otel@2.x` takes `logRecordProcessors` (plural). For normal Next.js / Vercel apps, do not guard `registerOTel(...)` behind `NEXT_RUNTIME`; Next calls `instrumentation.ts` in the appropriate runtime and `@vercel/otel` handles its own runtime differences.

`console.info` is not OTLP log export. If there is no existing logger bridge, use `@opentelemetry/api-logs` for production log records. Remove pre-existing `console.*` calls that duplicate the same structured OTel log event:

```ts
import { logs, SeverityNumber } from "@opentelemetry/api-logs"

const logger = logs.getLogger("my-next-app")

logger.emit({
	severityNumber: SeverityNumber.INFO,
	severityText: "INFO",
	body: "generated reply",
	attributes: {
		"tenant.id": tenantId,
		"gen_ai.provider.name": "anthropic",
		"gen_ai.request.model": model,
		"app.gen_ai.use_case": "support.reply",
		outcome: "success",
	},
})
```

## Client side

The browser half of the app uses `@maple-dev/browser` from a client component rendered in the root layout. `init()` is a no-op during server rendering, so module scope is safe.

```tsx
// app/maple.tsx
"use client"

import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "MAPLE_TEST", // public key (maple_pk_…) only, never maple_sk_
	serviceName: "my-next-app-web",
	region: "us", // "eu" for EU organizations
	environment: process.env.NODE_ENV,
	serviceVersion: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
})

export function Maple() {
	return null
}
```

Render `<Maple />` inside `<body>` in `app/layout.tsx` (Pages Router: import `./maple` from `pages/_app.tsx`). Give it a different `serviceName` from the server so browser and server spans stay distinguishable. Same-origin `fetch` calls to route handlers carry `traceparent`, so browser and server spans join one trace.

## Configuration and smoke

Inline the endpoint and ingest key in `instrumentation.ts` and pass them explicitly to `registerOTel`. Do not rely on `OTEL_EXPORTER_OTLP_*` env vars. The Maple ingest key is project-scoped and write-only, and inline config avoids Vercel's env-propagation quirks in preview builds.

Smoke-check with tools already in the repo (`npm run typecheck`, `npm run build`), plus a real app request where practical. Do not invent fragile inline Node scripts that import TypeScript source files directly, and do not assume `ts-node` exists unless it is already installed.
