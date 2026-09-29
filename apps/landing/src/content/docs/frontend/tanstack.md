---
title: "Frontend tracing for TanStack Router and TanStack Start"
description: "Trace every TanStack Router navigation, loader and server render as one OpenTelemetry trace, linked to your backend and to session replay."
group: "Frontend"
order: 1
navLabel: "TanStack"
icon: "tanstack"
---

TanStack Router tells you a lot about a navigation before it renders anything: which route matched, which loaders ran, and whether one of them redirected. This guide turns that into one trace per click, with a span for the navigation, a span per loader, the fetches those loaders made, and the backend spans behind them. With TanStack Start, the first page load also includes the server render.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses TanStack Router (and TanStack Start, if it renders on the server).

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the browser SDK

```bash
npm install @maple-dev/browser
```

This guide needs `@maple-dev/browser` 0.10.0 or later.

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	serviceVersion: import.meta.env.VITE_COMMIT_SHA,
	environment: import.meta.env.MODE,
})
```

In a TanStack Router app, import `./maple` first in your client entry (`src/main.tsx`), before anything renders. In TanStack Start, import it at the top of the root route (`src/routes/__root.tsx`); `init()` does nothing during server rendering, so that's safe.

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

The TanStack integration below connects them to TanStack Router.

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

## Trace TanStack Router navigations

`traceRouter` subscribes to the router's lifecycle events and turns each navigation into a span. Call it once, right after you create the router. In TanStack Start, `src/router.tsx` exports a `getRouter()` function, which also runs on the server for every request; `traceRouter` does nothing there:

```ts
// src/router.tsx
import { traceRouter } from "@maple-dev/browser/tanstack"
import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
	const router = createRouter({ routeTree })
	traceRouter(router)
	return router
}
```

In a client-only TanStack Router app that exports `const router = createRouter(...)`, call `traceRouter(router)` right after it. Either way, `MapleBrowser.init()` has to run first, which the import order above takes care of.

What you get:

- **Spans are named after the route's `fullPath`**, like `navigate /projects/$projectId`. That's the URL the user sees with the dynamic parts left as `$projectId`, without the pathless layouts and route groups that `routeId` includes. A URL no route matches, including one a layout matches but none of its children do, is named `not-found`, so 404 pages don't count as visits to your home page. With the deprecated `notFoundRoute` option, unmatched URLs are named after that route instead.
- **The first page load is covered.** `traceRouter` opens the `pageload` span as soon as it runs, and ends it when the first route renders, which also covers TanStack Start hydrating a server-rendered page. A click before the first route resolves ends the page load as interrupted.
- **Interrupted navigations are marked.** If the user clicks a second link before the first finishes loading, TanStack Router abandons the first one, and its span ends as interrupted.
- **Redirects stay in one span.** A `redirect()` thrown from `beforeLoad` or a loader starts a second navigation that replaces the current history entry. It stays in the span of the navigation it came from, which keeps the original `url.path` and is named after the route the user lands on. That includes a redirect during the first page load.
- **Search changes are navigations, hash links aren't.** Going from `/projects/1` to `/projects/1?tab=members` makes a `navigate /projects/$projectId` span, with a loader span only if the route's `loaderDeps` read the search. Back and forward are navigations. A link to `#section`, `router.invalidate()` and a link to the route on screen start no span, and end a navigation still in flight as interrupted.

## Trace route loaders

Loaders are where most of the time in a TanStack Router navigation goes, so each one gets its own span. `tracedLoader` is `MapleBrowser.traced` for TanStack Router: `redirect()` and `notFound()` are thrown, and it doesn't count them as failures:

```ts
// src/routes/projects.$projectId.tsx
import { tracedLoader } from "@maple-dev/browser/tanstack"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/projects/$projectId")({
	loader: ({ params }) =>
		tracedLoader("loader /projects/$projectId", () =>
			Promise.all([fetchProject(params.projectId), fetchMembers(params.projectId)]),
		),
})
```

Wrap `beforeLoad` the same way if it does I/O or can throw.

TanStack Router runs the loaders of nested routes in parallel, so a layout loader and a page loader show up as sibling spans under the navigation. If they overlap in the waterfall, that's working as intended. If the page loader starts only after the layout loader ends, something is making it wait.

Watch out for sequential `await`s inside a loader: only requests started before the first `await` nest under the loader span. [The await problem](#the-await-problem) explains why, and how to pass the context along when a request really does depend on the previous one.

A loader that turns an API 404 into `throw notFound()` leaves its span Ok. The `fetch` span that got the 404 is still marked as an error, like every 4xx client span.

Loaders also run when TanStack Router preloads a route, for example when the user hovers a link with `preload="intent"`. There's no navigation in progress then, so those loader spans become their own traces. That's accurate: the work happened before the click. If the user then clicks, the router renders the preloaded data right away and reloads it in the background, so the navigation span is very short and can end before its loader span does.

## Report errors caught by TanStack Router

TanStack Router wraps every route in an error boundary. That's why a failing loader or a component that throws shows your `errorComponent` instead of a blank page, and it's also why those errors never reach the browser SDK's global handlers.

The errors those boundaries catch go through the router's `defaultOnCatch` option. Report from there with `reportRouterError`:

```ts
// src/router.tsx
import { reportRouterError, traceRouter } from "@maple-dev/browser/tanstack"
import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
	const router = createRouter({
		routeTree,
		defaultOnCatch: (error) => reportRouterError(router, error),
	})
	traceRouter(router)
	return router
}
```

A loader that throws ends up in the same boundary, and `reportRouterError` skips it, because its loader span already recorded it: in the browser, or on the server for the first page load, where the browser only receives a copy of the error. It recognizes loader errors by the route match they're stored on, so errors from a loader or `beforeLoad` that isn't wrapped in `tracedLoader` aren't reported at all. That's one more reason to wrap a `beforeLoad` that can throw.

What's left are render errors. Each one is reported once, as a `react.render_error` span.

TanStack Router only calls `defaultOnCatch` for routes that have an `errorComponent`, or when `defaultErrorComponent` is set, and a route's own `onCatch` replaces it. Errors that reach the router's global boundary aren't reported.

## Trace server rendering in TanStack Start

TanStack Start renders the first page on the server, which means the first page load has a server half you can trace too. Start the OpenTelemetry Node SDK as in the [Node.js guide](/docs/guides/instrumentation-nodejs), in a `src/instrumentation.ts` file, and import it before anything else in your server entry. If your server process already loads the SDK with `node --import`, skip that import. That gives you spans for the HTTP calls your loaders make on the server.

The Start scaffold doesn't include a server entry, so create `src/server.ts`. TanStack Start uses it instead of its default one:

```ts
// src/server.ts
import "./instrumentation" // starts the OpenTelemetry Node SDK; must load first
import { traceRender, traceRequests } from "@maple-dev/browser/tanstack/server"
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"

export default createServerEntry({
	fetch: traceRequests(createStartHandler(traceRender(defaultStreamHandler))),
})
```

If your app already has a `src/server.ts`, wrap its `fetch` with `traceRequests` and its handler callback with `traceRender` the same way.

- **`traceRequests` opens a span for every request**, so a page's server loaders and its render share a trace. It has to wrap `fetch`, because the router runs the loaders before it calls the handler callback. The span records the method, `url.path` and the status code, and it's only marked as an error for a 5xx response. If the server's HTTP instrumentation already opened a span for the request, it becomes a child of that span instead, so a request never gets two server spans. A request that carries a `traceparent`, like a server function called from the browser, joins that trace.
- **`traceRender` names the span after the route**, like `ssr /projects/$projectId`, and sends its trace context to the browser in a `Server-Timing` header. On the browser side there's nothing to add: the `pageload` span joins the `ssr` span, so the first page load becomes one trace with the request, the loaders that ran on the server, their fetches, your backend's spans, and the page load in the browser.
- **Requests that don't render a page**, like server functions and redirects, keep the HTTP method as their span name and get no `Server-Timing` header.
- **The span ends at the first byte.** `defaultStreamHandler` returns as soon as React starts streaming, so the span measures the time to the first byte of HTML, not the time to the last. Deferred data that resolves while the page streams falls outside it.

`tracedLoader` works on the server too, and better than in the browser: it nests under the request span, and Node has `AsyncLocalStorage`, so fetches after an `await` keep their parent. Server-side fetches get spans from OpenTelemetry's undici instrumentation, which the Node.js guide's auto-instrumentations include. The server span's `url.path` is the raw path, like OpenTelemetry's HTTP instrumentation records it: the browser's `sanitizeUrl` option doesn't apply on the server.

If a CDN caches your HTML, it stores the `Server-Timing` header with it, and every visitor's page load joins the same old trace. Remove the header from responses the CDN caches. TanStack Start doesn't set an `ETag` on HTML, so a browser revalidation can't reuse an old header.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does TanStack Router have built-in OpenTelemetry support?

No, not today. The TanStack Start docs have an observability page with examples, and first-class OpenTelemetry support is on their roadmap. `@maple-dev/browser/tanstack` uses the router's public events, plus the history index TanStack Router keeps in `location.state.__TSR_index` to recognize redirects. That index isn't documented API, and it has one side effect: a `replace` navigation started while another one is still loading lands on the same index, so it's merged into that span like a redirect.

### Why are my TanStack Router loader spans not connected to the navigation?

Either the loader ran as a preload (there's no navigation to attach to yet), or the fetch happened after an `await` inside the loader. Start the requests before the first `await`, for example with `Promise.all`, or pass the context along explicitly.

### Can I use this with TanStack Router without TanStack Start?

Yes. Everything up to the server rendering section works in a client-only TanStack Router app. Without a server render, there's no `Server-Timing` header to join, and the `pageload` span starts its own trace.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
