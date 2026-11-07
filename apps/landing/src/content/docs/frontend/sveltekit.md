---
title: "Frontend tracing for SvelteKit"
description: "Trace SvelteKit navigations, universal load functions and client errors with @maple-dev/browser, and join the first page load to SvelteKit's server-side OpenTelemetry spans."
group: "Frontend"
order: 5
navLabel: "SvelteKit"
icon: "svelte"
---

This page sets up frontend tracing for SvelteKit: a span per navigation, a span per universal `load` function with its `fetch` requests and backend spans underneath, a report for every unexpected error, and a page load that joins the server render's trace. The SDK has no SvelteKit-specific entry, so a few lines in SvelteKit's hooks and root layout call the SDK's navigation API.

Tested with SvelteKit 3.1, Svelte 5.57, `adapter-node` 6 and `@maple-dev/browser` 0.14.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this page.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses SvelteKit.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install and initialize

```bash
npm install @maple-dev/browser
```

`src/hooks.client.ts` runs only in the browser, before the app hydrates. Initialize the SDK there, open the page load span in the `init` hook, and report unexpected errors from `handleError`:

```ts
// src/hooks.client.ts
import { MapleBrowser } from "@maple-dev/browser"
import type { ClientInit, HandleClientError } from "@sveltejs/kit/hooks"

MapleBrowser.init({
	ingestKey: "maple_pk_...", // public key from Settings → Ingestion
	serviceName: "acme-web",
	region: "us", // "eu" for EU organizations
	tracing: {
		// Your own APIs on another origin; same-origin requests carry traceparent already
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})

// Runs once, before hydration and the first page's load functions
export const init: ClientInit = () => MapleBrowser.startNavigation(location.pathname)

export const handleError: HandleClientError = ({ kind, error }) => {
	// "app" is error(), "framework" is SvelteKit's own (404s): only "unknown" is a bug
	if (kind === "unknown") MapleBrowser.captureException(error, { name: "sveltekit.client_error" })
}
```

The public key can only write telemetry, so it's safe in browser code. A cross-origin API must allow the `traceparent` header in its CORS preflight (`Access-Control-Allow-Headers`). Every other option, including session replay, consent and URL redaction, is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

## Trace navigations

`beforeNavigate` and `afterNavigate` from `$app/navigation` only work during component initialization, so register them in the root layout, which stays mounted for the whole visit:

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
	import { MapleBrowser } from "@maple-dev/browser"
	import { afterNavigate, beforeNavigate } from "$app/navigation"
	import { navigating, page } from "$app/state"

	let { children } = $props()

	beforeNavigate(({ to, willUnload, complete }) => {
		if (willUnload || !to) return // leaving the app, or a link no route matches
		MapleBrowser.startNavigation(to.url.pathname)
		// A beforeNavigate guard called cancel(): end the span instead of leaving it open
		complete.catch(() => {
			if (!navigating.type) MapleBrowser.endNavigation()
		})
	})

	// page.route.id, not to.route.id: SvelteKit 3.1 passes a null route id on the first load
	afterNavigate(() => MapleBrowser.endNavigation(page.route.id ?? undefined))
</script>

{@render children()}
```

Spans are named after the route id, such as `navigate /projects/[id]`, with the concrete path in `url.path`. SvelteKit's server spans carry the same string in `http.route`.

How SvelteKit's navigations map to spans:

- **Redirects:** a `load` that throws `redirect()` stays in one span, named after the destination, with both loaders under it.
- **A click during a pending navigation:** SvelteKit doesn't call `beforeNavigate` again, so one span covers both clicks. It's named after the route the user ends on, with `url.path` from the first click.
- **`cancel()` in a `beforeNavigate` guard:** the span ends at once with the bare name `navigate`.
- **Back, forward and query-string changes** are navigations. Hash links and shallow routing (`pushState`) start no span, and loads rerun by `invalidate()` or `invalidateAll()` are their own traces.
- **A link to a path no route matches** loads a new document. Its span is a bare `pageload`, since there's no route id.

## Trace load functions

Universal `load` functions in `+page.ts` and `+layout.ts` run in the browser on every client-side navigation. Wrap them in `MapleBrowser.traced` so each gets a span under the navigation. A small helper keeps `redirect()` and 4xx `error()` from marking the span failed:

```ts
// src/lib/trace-load.ts
import { MapleBrowser } from "@maple-dev/browser"
import { isHttpError, isRedirect } from "@sveltejs/kit"

/** Runs a universal load in a `loader <route id>` span under the current navigation. */
export const traceLoad = <T>(routeId: string | null, fn: () => Promise<T>) =>
	MapleBrowser.traced(`loader ${routeId}`, fn, {
		// redirect() and error() below 500 are control flow, not failures
		isFailure: (e) => !isRedirect(e) && !(isHttpError(e) && e.status < 500),
	})
```

```ts
// src/routes/projects/[id]/+page.ts
import { traceLoad } from "#lib/trace-load.js"
import { error } from "@sveltejs/kit"
import type { PageLoad } from "./$types"

export const load: PageLoad = ({ fetch, params, route }) =>
	traceLoad(route.id, async () => {
		// Both requests start before the first await, so both nest under the span
		const [project, members] = await Promise.all([
			fetch(`/api/projects/${params.id}`),
			fetch(`https://api.acme.com/projects/${params.id}/members`),
		])
		if (project.status === 404) error(404, "Project not found")
		return { project: await project.json(), members: await members.json() }
	})
```

On the server, `traced` only runs the function; SvelteKit's own tracing spans server-side loads.

- **The `await` limit:** the browser has no async context, so only requests started before the function's first `await` nest under its span. Start independent requests together with `Promise.all`.
- **A thrown error** marks the loader span `Error` and is recorded once; `handleError` doesn't report it again.
- **`error(404)`** leaves the navigation and loader spans OK. The `fetch` span for the 404 response is `Error`, as OpenTelemetry marks any 4xx client request.
- **First page load:** loads rerun during hydration against responses the server inlined in the HTML, so their spans last about 0 ms. The real requests are in the server half of the trace.
- **Hover preloading:** the default `app.html` sets `data-sveltekit-preload-data="hover"`, so loads often run before the click, as their own traces. The `navigate` span after the click then has no children.
- **Server `load` functions** (`+page.server.ts`): the browser fetches their data from `__data.json` outside any span, so that request and the server's `sveltekit.load` span form their own trace.

## Errors

Where each kind of error is recorded. None is recorded twice:

- A universal `load` that throws in the browser: on its `loader` span.
- A component that throws while rendering in the browser: `handleError` reports it as `sveltekit.client_error`.
- An event handler that throws: the SDK's global handler reports it as `browser.uncaught_error`.
- A `load` that throws during server rendering: SvelteKit records it on its server `sveltekit.load` span.
- A component that throws during server rendering: the response is a 500, but no span records the exception.

## Join the page load to the server render

SvelteKit can emit OpenTelemetry spans for the `handle` hook, `load` functions, form actions and `+server` endpoints, and reads an incoming `traceparent`. Turn it on in the options you pass to the `sveltekit()` plugin:

```ts
// vite.config.ts
import adapter from "@sveltejs/adapter-node"
import { sveltekit } from "@sveltejs/kit/vite"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [sveltekit({ adapter: adapter(), tracing: { server: true } })],
})
```

Start the OpenTelemetry Node SDK in `src/instrumentation.server.ts`, which SvelteKit loads before your app code when the adapter supports it (`adapter-node` does):

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

```ts
// src/instrumentation.server.ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { NodeSDK } from "@opentelemetry/sdk-node"

new NodeSDK({
	serviceName: "acme-web-server",
	traceExporter: new OTLPTraceExporter({
		url: "https://ingest.maple.dev/v1/traces", // EU: https://ingest.eu.maple.dev/v1/traces
		headers: { authorization: `Bearer ${process.env.MAPLE_INGEST_KEY}` },
	}),
}).start()
```

Each request then gets a `sveltekit.handle.root` span, with `sveltekit.resolve` and a `sveltekit.load` per load under it. A same-origin `fetch` from the browser joins the server's trace through its `traceparent`. A load's server-side `fetch` to another origin carries no `traceparent` unless you add HTTP instrumentation; see the [Node.js guide](/docs/guides/instrumentation-nodejs).

The browser joins the server's trace when the page has a `<meta name="traceparent">` tag. Add a placeholder to `src/app.html`:

```html
<meta name="traceparent" content="%maple.traceparent%" />
```

Then fill it with the root span's trace context in `src/hooks.server.ts`:

```ts
// src/hooks.server.ts
import { context, propagation, trace } from "@opentelemetry/api"
import type { Handle } from "@sveltejs/kit/hooks"

export const handle: Handle = ({ event, resolve }) => {
	// The trace context of SvelteKit's root span for this request
	const carrier: { traceparent?: string } = {}
	propagation.inject(trace.setSpan(context.active(), event.tracing.root), carrier)

	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace("%maple.traceparent%", carrier.traceparent ?? ""),
	})
}
```

The `pageload` span becomes a child of `sveltekit.handle.root`, and every reload gets a new trace, because SvelteKit computes the `ETag` after `transformPageChunk`. Don't add the tag to pages a CDN caches, or every visitor joins the same trace. Without server tracing, the placeholder becomes an empty string and the page load starts a trace of its own.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): sampling, logs, Web Vitals, consent and URL redaction.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
