---
title: "Frontend tracing for Astro"
description: "Trace Astro page loads, ClientRouter navigations and island errors with @maple-dev/browser, and join the first page load to the server render of on-demand pages."
group: "Frontend"
order: 7
navLabel: "Astro"
icon: "astro"
---

This page sets up `@maple-dev/browser` in an Astro site. Every document load becomes a `pageload` span and, with `<ClientRouter />`, every client-side navigation a `navigate` span, both named after the page's route (`/projects/[id]`). For pages rendered on demand, the page load joins the server render's trace.

It covers the browser setup, connecting your API, island errors, and the server half with the Node adapter. Checked against Astro 7.4 and `@maple-dev/browser` 0.14.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this page.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses Astro.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. EU organizations should say EU region.

## Install

```bash
npm install @maple-dev/browser
```

## Trace page loads and navigations

Astro has no browser router hooks of its own, so a few lines of your code call the SDK's navigation API. Create `src/maple.ts`:

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: import.meta.env.PUBLIC_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	environment: import.meta.env.MODE,
	tracing: {
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})

const endNavigation = () => MapleBrowser.endNavigation(document.documentElement.dataset.route)

// Every document load is a page load, named when the window load event fires
MapleBrowser.startNavigation(location.pathname)
addEventListener("load", endNavigation)

// <ClientRouter /> navigations, with the page fetch inside them
document.addEventListener("astro:before-preparation", (event) => {
	MapleBrowser.startNavigation(event.to.pathname)
	const loader = event.loader
	event.loader = () => MapleBrowser.traced("load page", loader)
})
document.addEventListener("astro:page-load", endNavigation)
```

Astro only exposes `PUBLIC_`-prefixed environment variables to browser code. The public key can only write telemetry, so it is safe to ship. For an EU organization, add `region: "eu"`.

Same-origin requests always carry the `traceparent` header, so your server's spans join the browser's trace. `propagateTraceHeaderCorsUrls` adds your APIs on other origins. Each must allow the header in its CORS preflight (`Access-Control-Allow-Headers: content-type, traceparent, tracestate`), or the browser blocks the request, and needs OpenTelemetry to read it ([Instrument your application](/docs/instrumentation)). List only your own APIs.

Import it from the base layout every page renders, and write the route template onto `<html>`:

```astro
---
// src/layouts/Layout.astro
import { ClientRouter } from "astro:transitions"
---

<html lang="en" data-route={Astro.routePattern}>
	<head>
		<meta charset="utf-8" />
		<ClientRouter />
		<script>
			import "../maple"
		</script>
	</head>
	<body>
		<slot />
	</body>
</html>
```

`<ClientRouter />` is optional; drop it and the same script traces a multi-page site. Keep the `<script>` without `is:inline` so Astro bundles it once per page. A page that doesn't use the layout needs the same `<script>` and `data-route`.

Requests islands make are their own traces, not children of the page load or navigation span. They still join your backend's trace through `traceparent`.

## Report island errors

Uncaught errors and unhandled rejections from scripts and islands are reported without extra code, as `browser.uncaught_error` and `browser.unhandled_rejection`. Errors an island framework catches never reach those handlers, so report them where the framework catches them.

For React islands, wrap the island's content in `MapleErrorBoundary`. It reports a render error once, as `react.render_error`, and renders `fallback`:

```tsx
// src/components/Projects.tsx
import { MapleErrorBoundary } from "@maple-dev/browser/react"

export default function Projects() {
	return (
		<MapleErrorBoundary fallback={<p>Something went wrong.</p>}>
			<ProjectList />
		</MapleErrorBoundary>
	)
}
```

For Vue islands, set `app.config.errorHandler` in an app entrypoint:

```js
// astro.config.mjs
vue({ appEntrypoint: "/src/vue-app" })
```

```ts
// src/vue-app.ts
import { MapleBrowser } from "@maple-dev/browser"
import type { App } from "vue"

export default (app: App) => {
	app.config.errorHandler = (error, _instance, info) => {
		console.error(error) // a handler replaces Vue's own logging
		MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
	}
}
```

For other island frameworks, call `MapleBrowser.captureException(error)` from their error hook. Each error object is recorded once.

## Join the page load to the server render

For pages rendered on demand (an adapter, and `output: "server"` or `export const prerender = false`), the server can hand its trace context to the browser in a `Server-Timing` header. The SDK reads it and makes the `pageload` span a child of the server's span. Prerendered pages are plain files, so their page loads start their own traces.

This step is optional: without it, each page load is still traced, as a trace of its own.

Install OpenTelemetry for the server:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http import-in-the-middle
```

- `@opentelemetry/sdk-node`: the OpenTelemetry SDK for Node.js.
- `@opentelemetry/auto-instrumentations-node`: creates a span for each request the server handles, which the page load joins, plus spans for the server's `fetch` and database calls.
- `@opentelemetry/exporter-trace-otlp-http`: sends the spans to Maple.
- `import-in-the-middle`: lets the instrumentations patch ES modules, which Astro's server build uses. Without it there is no request span.
- `@opentelemetry/api`: the middleware below uses it to write the header.

Start the SDK in a file the server loads first:

```js
// tracing.mjs
import { register } from "import-in-the-middle/register-hooks.mjs"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { NodeSDK } from "@opentelemetry/sdk-node"

// Lets the instrumentations patch ES modules
register()

const sdk = new NodeSDK({
	serviceName: "acme-astro",
	traceExporter: new OTLPTraceExporter({
		url: "https://ingest.maple.dev/v1/traces", // EU: https://ingest.eu.maple.dev/v1/traces
		headers: { authorization: `Bearer ${process.env.MAPLE_INGEST_KEY}` }, // private key, maple_sk_...
	}),
	instrumentations: [
		getNodeAutoInstrumentations({
			// Skip Astro's hashed JS and CSS, or every asset gets a trace of its own
			"@opentelemetry/instrumentation-http": {
				ignoreIncomingRequestHook: (request) => request.url?.startsWith("/_astro/") ?? false,
			},
		}),
	],
})

sdk.start()
```

Load it before the server (`@astrojs/node`):

```bash
astro build
node --import ./tracing.mjs ./dist/server/entry.mjs
```

Then add a middleware that hands the trace context to the browser:

```ts
// src/middleware.ts
import { context, propagation, trace } from "@opentelemetry/api"
import { defineMiddleware } from "astro:middleware"

export const onRequest = defineMiddleware(async ({ request, routePattern }, next) => {
	// Name the server's request span after the route (GET /projects/[id]), like the browser spans
	trace.getActiveSpan()?.setAttribute("http.route", routePattern).updateName(`${request.method} ${routePattern}`)

	const response = await next()

	// The request span's trace context, as a traceparent string
	const carrier: Record<string, string> = {}
	propagation.inject(context.active(), carrier)

	// Only on HTML pages: the browser SDK reads it from the page's Server-Timing header
	if (carrier.traceparent && response.headers.get("content-type")?.startsWith("text/html")) {
		response.headers.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
	}
	return response
})
```

A direct load of `/projects/8f2a` is then one trace: the server's `GET /projects/[id]` span with `pageload /projects/[id]` under it. A `<ClientRouter />` click to that page puts the server's span under the click's page `fetch`, in the `navigate` trace.

- The middleware writes nothing where no OpenTelemetry SDK runs in the server process, and those page loads start their own traces.
- Don't send the header on responses a CDN or shared cache stores, or every visitor joins one trace.
- Back and forward can load the document from the browser's cache, header included, so that `pageload` joins the earlier visit's trace. `Cache-Control: no-store` on the page avoids it.
- `<ClientRouter />` prefetches links on hover. The prefetch is a server trace of its own; the click still fetches and renders the page under its `navigate` span.

## Verify

Build and start the server (the commands above), load a page and click around, then check **Traces** for your `serviceName`:

- a direct load of an on-demand page: `pageload <route>` under the server's `GET <route>` span;
- a `<ClientRouter />` click: `navigate <route>` > `load page` > `fetch`, with the server's span under the `fetch`;
- a request to your API: the API's span under the `fetch` span.

## Next steps

- [Browser SDK reference](/docs/session-replay/browser-sdk): every option, including sampling, logs, Web Vitals, privacy and consent.
- [Frontend tracing](/docs/frontend): the other framework pages.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped.
