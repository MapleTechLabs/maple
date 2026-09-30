---
title: "Frontend tracing for SvelteKit"
description: "Trace SvelteKit navigations, load functions and errors in the browser, and connect them to SvelteKit's built-in server-side OpenTelemetry spans in one trace."
group: "Frontend"
order: 5
navLabel: "SvelteKit"
icon: "svelte"
---

SvelteKit has its own OpenTelemetry tracing, but only for the server: it records spans for the `handle` hook, `load` functions and form actions while rendering, and nothing once the page is in the browser. This guide adds the browser half. A click on a link produces one trace with a span for the navigation, a span per `load` function, the fetches they made, and the backend spans behind them, and the first page load starts at SvelteKit's server render. The code was checked against SvelteKit 2.70 and Svelte 5.57.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses SvelteKit.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the browser SDK

```bash
npm install @maple-dev/browser
```

This guide needs `@maple-dev/browser` 0.10.0 or later.

Put `maple.ts` (the `MapleBrowser.init` call) in `src/lib/`, so every file can import it from `$lib`. `import.meta.env.VITE_*` works as it does in any Vite app; if you prefer SvelteKit's own env modules, read the key from `$env/static/public` with a `PUBLIC_` prefix instead.

SvelteKit's entry point in the browser is `src/hooks.client.ts`. Import the SDK there, and export `startPageLoad` as the `init` hook, which opens the `pageload` span:

```ts
// src/hooks.client.ts
import "$lib/maple" // first: starts the SDK before anything else runs
import { startPageLoad } from "@maple-dev/browser/sveltekit"

// Runs once, before hydration and before the first page's load functions
export const init = startPageLoad
```

The first load needs this because SvelteKit's `beforeNavigate` doesn't fire for it. Without it, the first click is recorded as the `pageload`.

`init()` sets up:

- a span for every `fetch()` call;
- error spans for uncaught errors and unhandled promise rejections, which show up on the [Errors](/docs/errors/overview) page;
- session replay, with the same `session.id` on every span and replay event, so a trace links to the recording of the session that produced it;
- export every 2 seconds, plus a flush when the tab is hidden or closed, so the spans from the last moments of a visit aren't lost;
- redaction of credential-looking query parameters (`token`, `code`, `password` and similar) in every URL it sends.

Use the public ingest key (`maple_pk_…`) from **Settings → Ingestion**. It can only write telemetry, so it's safe in browser code. For an EU organization, add `region: "eu"`. Every option is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

## Connect browser traces to your backend

Each `fetch()` span sends a W3C `traceparent` header, and your backend's span joins the same trace. For requests to the page's own origin this happens automatically. For an API on another origin, list it:

```ts
MapleBrowser.init({
	// ...
	tracing: {
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

Then allow the header in the API's CORS configuration. Without it, the browser blocks the request after the preflight:

```http
Access-Control-Allow-Headers: content-type, authorization, traceparent, tracestate
```

Only list your own APIs. Sending `traceparent` to third parties leaks your trace ids, and many of them reject the preflight.

Your backend needs OpenTelemetry to read the header; every OpenTelemetry HTTP server instrumentation does. See [Instrument your application](/docs/instrumentation) for your backend's language or framework.

Browser and server clocks disagree, so a server span can appear to start slightly before the `fetch` that caused it, and a laptop that slept can be minutes off. Durations are accurate; the offsets between browser and server spans are approximate.

## Navigation and data-loading spans

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The SDK fixes that with a span per navigation, and the data-loading and `fetch` spans nested under it. Three calls do the work:

- `MapleBrowser.startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `MapleBrowser.endNavigation(route)` names the span after the route template and ends it.
- `MapleBrowser.traced(name, fn, { isFailure })` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`. An error it recorded isn't reported a second time by `captureException` or the SDK's global error handlers.

The SvelteKit integration below connects them to SvelteKit's router and your `load` functions.

Span names use the route template, like `navigate /projects/:id`, never the concrete URL. Maple groups by span name, so a template gives you one row with a real p95, while concrete URLs give you one row per project. The concrete path is still on the span as `url.path`.

The first page load joins the server render's trace without any browser code: when the server sends its trace context in a `Server-Timing` header or a `<meta name="traceparent">` tag, the `pageload` span becomes part of that trace, and follows its sampling decision: a page load under a trace the server didn't sample isn't recorded. In a client-only app, it starts a trace of its own. The [Browser SDK reference](/docs/session-replay/browser-sdk#navigation-and-data-loading-spans) has the details.

### The await problem

In the browser, a span only stays active until the first `await` inside it. A request that starts after an `await` loses its parent and shows up as a separate trace.

```ts
// ❌ fetchMembers starts after an await, so it becomes its own trace
MapleBrowser.traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id)
	return { project, members }
})
```

```ts
// ✅ Save the context before the first await, and run later requests inside it
import { context } from "@opentelemetry/api"

MapleBrowser.traced("load project", async () => {
	const ctx = context.active()
	const project = await fetchProject(id)
	const members = await context.with(ctx, () => fetchMembers(project.id))
	return { project, members }
})
```

`context` comes from `@opentelemetry/api`, so add it with `npm install @opentelemetry/api` if you use this pattern. The SDK already depends on it, but strict package managers like pnpm only resolve packages you list yourself.

If the requests don't depend on each other, start them together with `Promise.all` instead. Both nest under the span, and the page stops waiting on one request before starting the next.

This happens because browsers have no equivalent of Node's `AsyncLocalStorage`, which is what carries the active span across `await` on the server.

## Trace SvelteKit navigations with beforeNavigate and afterNavigate

Two lifecycle functions from `$app/navigation` cover a client-side navigation: `beforeNavigate` runs when a navigation starts, before any `load` function, and `afterNavigate` runs once the new page has rendered, including after the first load. Both must be called while a component initializes, and they stay active while it's mounted. The root layout is mounted for the whole session, so `traceNavigation` goes there:

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
	import { afterNavigate, beforeNavigate } from "$app/navigation"
	import { navigating, page } from "$app/state"
	import { traceNavigation } from "@maple-dev/browser/sveltekit"

	let { children } = $props()

	traceNavigation({ beforeNavigate, afterNavigate, navigating, page })
</script>

{@render children()}
```

You pass in the four `$app` imports because only your app can import SvelteKit's `$app` modules. `$app/state` needs SvelteKit 2.12 or later. On 2.10 and 2.11, pass `navigating: { get type() { return get(navigatingStore)?.type ?? null } }` and `page: { get route() { return get(pageStore).route } }` instead, with both stores from `$app/stores` and `get` from `svelte/store`.

The span name comes from the route id, which is the file-system path of the route: `/projects/[id]`, not `/projects/8f2a-4c11`. It includes route groups, so a page in `src/routes/(app)/projects/[id]` is named `/(app)/projects/[id]`. SvelteKit puts the same string in the `http.route` attribute of its server spans, so browser and server spans group under the same name.

The edge cases are where SvelteKit differs from other routers:

- **A click during a pending navigation continues the same span.** SvelteKit skips the callbacks while a navigation is in progress, so you get one span covering both clicks, named after the route the user ended up on, with `url.path` from the first click.
- **Cancelled navigations end right away, as interrupted.** When a page calls `cancel()` in `beforeNavigate` (to guard unsaved changes, say), the span ends with the plain name `navigate` and `app.navigation.interrupted` set.
- **Redirects stay in one span.** A `load` function that throws `redirect()` starts a new navigation internally, but without calling `beforeNavigate`. The span covers both routes and is named after the destination.
- **Back and forward are navigations.** Both hooks fire, so each gets a `navigate` span, and the page's universal `load` functions run again under it.
- **Hash links don't navigate.** A click on `#section` on the same page is handled without a navigation, so there's no span. Query-string changes like `?tab=2` are real navigations and do, but only `load` functions that read `url.searchParams` run again.
- **Unknown routes reload the page.** A link to a path that matches no route makes SvelteKit load a new document. Its span is a plain `pageload`, since there's no route id to name it after.
- **`invalidate()`, `invalidateAll()`, and shallow routing** (`pushState` and `replaceState` from `$app/navigation`) start no span. Load functions rerun by `invalidate` show up as their own traces.
- **Hash routing** (`router.type: "hash"`) names spans correctly, but their `url.path` is the document's path, `/`.

## Trace universal load functions

Universal `load` functions in `+page.ts` and `+layout.ts` run in the browser on every client-side navigation, so each one gets a span. Wrap them in `loadSpan`:

```ts
// src/routes/projects/[id]/+page.ts
import { loadSpan } from "@maple-dev/browser/sveltekit"
import { error } from "@sveltejs/kit"
import type { PageLoad } from "./$types"

export const load: PageLoad = async ({ fetch, params, route }) =>
	loadSpan(`loader ${route.id}`, async () => {
		// Start both requests before the first await, so both nest under the span
		const [project, members] = await Promise.all([
			fetch(`/api/projects/${params.id}`),
			fetch(`/api/projects/${params.id}/members`),
		])
		if (project.status === 404) error(404, "Project not found")

		return { project: await project.json(), members: await members.json() }
	})
```

`redirect()` and `error()` both work by throwing, and `loadSpan` doesn't count either as a failure when the status is below 500. That's also the rule SvelteKit's own server spans use. On the server, `loadSpan` only runs your function, because SvelteKit's own tracing already records a span per load.

`route.id` gives the span the same template the navigation uses. Use the `fetch` that SvelteKit passes to `load`: it calls `window.fetch` when the request is made, so it goes through the SDK's instrumentation and carries `traceparent`.

The [`await` problem](#the-await-problem) applies here too: only requests started before the first `await` nest under the span. That's why the example starts both with `Promise.all`.

Four things to know about load spans:

- **On the first page load, the load span is nearly empty.** Load functions run again in the browser during hydration, but their `fetch` calls are answered from responses the server inlined into the HTML. There are no network requests, so the span lasts about 0ms. The real requests are in the server half of the trace.
- **Preloading moves loads before the click.** The default `app.html` sets `data-sveltekit-preload-data="hover"`, so load functions often run when the user hovers a link. There's no navigation yet, so those load spans and their fetches become their own traces. The `navigate` span after the click has no children and lasts a few milliseconds, because the data is already there.
- **Server `load` functions get their own trace.** `+page.server.ts` runs on the server, and the browser fetches its result from a `__data.json` URL. SvelteKit starts that request outside any `load` span, so its `fetch` span, and the server's `sveltekit.load` span behind it, form a separate trace next to the navigation.
- **A 404 from your API isn't a failure.** When a load calls `error(404)` after a 404 response, the navigation and load spans stay OK. The `fetch` span for the 404 itself is marked as an error, as OpenTelemetry does for any 4xx response to a client request.

## Report errors from SvelteKit's handleError hook

SvelteKit catches errors thrown in `load` functions to render your `+error.svelte` page, and passes the unexpected ones to the `handleError` hook in `hooks.client.ts`. Errors from `error()` and `redirect()` never get there. Add `handleErrorWithMaple` to the client hooks file:

```ts
// src/hooks.client.ts
import "$lib/maple" // first: starts the SDK before anything else runs
import { handleErrorWithMaple, startPageLoad } from "@maple-dev/browser/sveltekit"

export const init = startPageLoad
export const handleError = handleErrorWithMaple()
```

If you already have a `handleError`, pass it in, `handleErrorWithMaple(handleError)`, and what it returns is kept. Errors are reported as `sveltekit.client_error`, with two kinds skipped: errors `loadSpan` already recorded on a load span, and 404s, because a link to a route that doesn't exist also reaches `handleError`, and you probably don't want every mistyped URL as an issue.

Errors thrown while a component renders don't go through `handleError` by default. In the browser they escape to the window, and the SDK's global handlers record them once as `browser.uncaught_error`. SvelteKit has an experimental `handleRenderingErrors` option that wraps components in `<svelte:boundary>`, renders your `+error.svelte` page in place of the broken component, and sends those errors through `handleError` too, where they're reported as `sveltekit.client_error`.

On the server, SvelteKit's tracing records an unexpected error on the `load` or `handle` span it was thrown in, so a server `handleError` would record those twice. Errors thrown while rendering on the server are the gap: the response is a 500 and the server span is marked as an error, but no span records the exception itself.

## Server-side tracing with SvelteKit's built-in OpenTelemetry

Since version 2.31, SvelteKit can emit OpenTelemetry spans for the server side of a request. Both switches are under `experimental`, which means they can change in any release. Projects created with `sv create` on SvelteKit 2.62 or later keep their SvelteKit options in `vite.config.ts`, passed to the `sveltekit()` plugin, with no `kit` key:

```ts
// vite.config.ts
import adapter from "@sveltejs/adapter-node"
import { sveltekit } from "@sveltejs/kit/vite"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter(),
			experimental: {
				tracing: { server: true },
				instrumentation: { server: true },
			},
		}),
	],
})
```

If your project has a `svelte.config.js` instead, put the same `experimental` object under `kit` there. SvelteKit ignores `svelte.config.js` when options are passed to the plugin.

`tracing.server` turns on the spans. `instrumentation.server` makes SvelteKit load `src/instrumentation.server.ts` before your app code, which is where the OpenTelemetry Node SDK starts:

```ts
// src/instrumentation.server.ts
import { register } from "node:module"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { createAddHookMessageChannel } from "import-in-the-middle"

// Lets the auto-instrumentations patch ES modules, not only CommonJS
const { registerOptions } = createAddHookMessageChannel()
register("import-in-the-middle/hook.mjs", import.meta.url, registerOptions)

const MAPLE_ENDPOINT = "https://ingest.maple.dev" // EU: https://ingest.eu.maple.dev
const MAPLE_KEY = "YOUR_INGEST_KEY"

const sdk = new NodeSDK({
	serviceName: "acme-web-server",
	traceExporter: new OTLPTraceExporter({
		url: `${MAPLE_ENDPOINT}/v1/traces`,
		headers: { authorization: `Bearer ${MAPLE_KEY}` },
	}),
	instrumentations: [
		getNodeAutoInstrumentations({
			// Hashed JS and CSS files: otherwise one trace per asset on every page load
			"@opentelemetry/instrumentation-http": {
				ignoreIncomingRequestHook: (request) => request.url?.startsWith("/_app/immutable/") ?? false,
			},
		}),
	],
})

sdk.start()
```

The [Node.js guide](/docs/guides/instrumentation-nodejs) covers logs and metrics too, if you want them from the server. Install `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-proto`, and `import-in-the-middle` as `dependencies`, not `devDependencies`: `adapter-node` bundles devDependencies into the build and only leaves `dependencies` as imports, which is what the instrumentation needs to patch them.

The `/_app/immutable/` filter matches SvelteKit's default `appDir`. Without it, the HTTP instrumentation starts a trace for every script and stylesheet the browser downloads.

Every request then gets an HTTP server span with a `sveltekit.handle.root` span under it, which has the route in `http.route`, a `sveltekit.resolve` span for rendering, and a `sveltekit.load` span per `load` function. SvelteKit also reads an incoming `traceparent`, which is what connects the browser's `__data.json` requests to the server's spans. One thing to know when you query these: every load span has the same name, and `sveltekit.load.node_id` tells you which file it came from.

### Hand the server's trace to the browser

The last piece joins the first page load to the server render. `mapleHandle` is a `handle` hook that adds the trace context of SvelteKit's root span, `event.tracing.root`, to rendered pages in a `Server-Timing` header:

```ts
// src/hooks.server.ts
import { mapleHandle } from "@maple-dev/browser/sveltekit/server"

export const handle = mapleHandle
```

If you already have a `handle`, put `mapleHandle` first: `export const handle = sequence(mapleHandle, yourHandle)`, with `sequence` from `@sveltejs/kit/hooks`.

The browser side needs nothing more: the `pageload` span becomes a child of `sveltekit.handle.root`. Only HTML responses get the header, and without server tracing, or before SvelteKit 2.31, `mapleHandle` passes every response through unchanged.

`mapleHandle` also drops the `ETag` from the responses it adds the header to. SvelteKit adds an `ETag` to every page it renders without streaming, and answers a matching `If-None-Match` with a 304 that doesn't include the `server-timing` header. The browser then reuses the header it cached with the page, and a reload joins the trace of an earlier visit. Dropping the `ETag` costs you those 304s on HTML, which are rare for pages that render per request anyway. For the same reason, leave `mapleHandle` out for pages a CDN caches, or every visitor joins the same trace.

## SvelteKit tracing gotchas

- **Call `traceNavigation` in the root layout.** In a nested layout, it misses every navigation outside it, and stops when the layout unmounts.
- **Keep typed `load` functions `async`.** With `export const load: PageLoad`, a non-async arrow that returns `loadSpan(...)` can leave `data` typed as `{}`. The `async` version infers the real type.
- **The browser tracing code runs on the server too.** The root layout and universal loads run during server rendering, where the navigation hooks never fire and `loadSpan` only runs your function. It does nothing there, but adapters that bundle ship it in the server bundle.
- **Check your adapter.** `instrumentation.server.ts` only runs first if the adapter supports it. `adapter-node` does; check the docs of any other.
- **Measure the overhead.** SvelteKit's docs point out that tracing has a cost, and a span per `load` adds up on busy pages.
- **Node 26 warns about `module.register()`.** The ES module hook still works. `import-in-the-middle` also ships a synchronous `register-hooks.mjs` entry for newer Node versions.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does SvelteKit have built-in OpenTelemetry support?

Yes, on the server. Since SvelteKit 2.31, `kit.experimental.tracing.server` emits spans for the `handle` hook, `load` functions, form actions, and remote functions, and `instrumentation.server.ts` is where you start the Node SDK. It's experimental, and there's no browser tracing, which is what the rest of this guide adds.

### Why are my SvelteKit load spans not connected to the navigation?

Usually because the load ran during a preload, when the user hovered a link, or because of `invalidate()`. Neither has a navigation to attach to. Server `load` functions in `+page.server.ts` are always in their own trace, since the browser requests their data outside any span. The other cause is a `fetch` after an `await` inside the load, which loses its parent span.

### Does this work with a SvelteKit SPA or adapter-static?

Yes. Everything before the server section works without a server. Without a `server-timing` header, the `pageload` span starts its own trace.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
