---
title: "Frontend tracing for TanStack Router and TanStack Start"
description: "Trace every TanStack Router navigation, loader and server render as one OpenTelemetry trace, linked to your backend and to session replay."
group: "Frontend"
order: 1
navLabel: "TanStack"
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

## Add the tracing helper

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The fix is a span per navigation, with the data-loading and `fetch` spans nested under it. Add this helper as `src/tracing.ts`; the rest of this guide connects it to TanStack Router:

```ts
// src/tracing.ts
import { context, propagation, type Span, SpanStatusCode, trace } from "@opentelemetry/api"

const tracer = trace.getTracer("acme-web")

let navigation: { span: Span; kind: "pageload" | "navigate" } | undefined
let firstLoad = true

/** Call when the router starts a navigation. */
export function startNavigation(path: string) {
	// A click before the last navigation finished replaces it
	navigation?.span.setAttribute("app.navigation.interrupted", true)
	navigation?.span.end()

	const kind = firstLoad ? "pageload" : "navigate"
	// Only the first page load belongs to the server's trace, if there was one
	const parent = firstLoad ? serverContext() : context.active()
	firstLoad = false

	navigation = { kind, span: tracer.startSpan(kind, { attributes: { "url.path": path } }, parent) }
}

/** Call when the new route is ready. `route` is its template, like `/projects/:id`. */
export function endNavigation(route?: string) {
	if (!navigation) return
	if (route) navigation.span.updateName(`${navigation.kind} ${route}`)
	navigation.span.end()
	navigation = undefined
}

const recorded = new WeakSet<object>()

/** Run `fn` in a span under the current navigation. */
export function traced<T>(
	name: string,
	fn: () => Promise<T>,
	isFailure: (error: unknown) => boolean = () => true,
): Promise<T> {
	const parent = navigation ? trace.setSpan(context.active(), navigation.span) : context.active()

	return tracer.startActiveSpan(name, {}, parent, async (span) => {
		try {
			return await fn()
		} catch (error) {
			if (isFailure(error)) {
				// Some libraries throw error-like objects that aren't Error instances
				span.recordException(error instanceof Error ? error : String((error as { message?: unknown })?.message ?? error))
				span.setStatus({ code: SpanStatusCode.ERROR })
				if (typeof error === "object" && error !== null) recorded.add(error)
			}
			throw error
		} finally {
			span.end()
		}
	})
}

/** Whether `traced` already recorded this error on a span. */
export const alreadyRecorded = (error: unknown) =>
	typeof error === "object" && error !== null && recorded.has(error)

/** The trace the server rendered this page under, from a `Server-Timing` header or a `<meta>` tag. */
function serverContext() {
	if (typeof document === "undefined") return context.active()
	const [page] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
	const traceparent =
		page?.serverTiming?.find((entry) => entry.name === "traceparent")?.description ||
		document.querySelector<HTMLMetaElement>('meta[name="traceparent"]')?.content
	return traceparent ? propagation.extract(context.active(), { traceparent }) : context.active()
}
```

- `startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `endNavigation(route)` names the span after the route template and ends it.
- `traced(name, fn, isFailure)` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`.
- `alreadyRecorded(error)` tells you whether `traced` already recorded an error, so it isn't reported twice.
- `serverContext()` joins the first page load to the server's trace when the server sent its trace context, in a `Server-Timing` header or a `<meta name="traceparent">` tag. In a client-only app it does nothing.

Span names use the route template, like `navigate /projects/:id`, never the concrete URL. Maple groups by span name, so a template gives you one row with a real p95, while concrete URLs give you one row per project. The concrete path is still on the span as `url.path`.

### The await problem

Browsers have no equivalent of Node's `AsyncLocalStorage`, so OpenTelemetry's web context manager only tracks the active span synchronously. Inside `traced`, a `fetch()` called before the first `await` nests under the span. A `fetch()` called after it starts a new trace:

```ts
// Both requests nest under the span
traced("load project", () => Promise.all([fetchProject(id), fetchMembers(id)]))

// The second request loses its parent
traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id) // new trace
	return { project, members }
})
```

When a request depends on an earlier one, capture the context before the first `await` with `const ctx = context.active()`, and make the request with `context.with(ctx, () => fetchMembers(project.id))`. Sequential awaits while loading a page are also a request waterfall, so check whether the requests can run in parallel first.

## Trace TanStack Router navigations

The router emits lifecycle events you can subscribe to with `router.subscribe`. Two of them are enough:

- `onBeforeNavigate` fires when a navigation starts, before any loader runs.
- `onResolved` fires once every loader has finished and the new route is committed.

```ts
// src/router-tracing.ts
import { type AnyRouter, isNotFound, isRedirect } from "@tanstack/react-router"
import { endNavigation, startNavigation, traced } from "./tracing"

export function traceRouter(router: AnyRouter) {
	// The router also emits these events while rendering on the server
	if (typeof window === "undefined") return

	router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation, hrefChanged }) => {
		// router.invalidate() reruns loaders without going anywhere
		if (fromLocation && !hrefChanged) return
		startNavigation(toLocation.pathname)
	})

	router.subscribe("onResolved", () => {
		endNavigation(router.state.matches.at(-1)?.fullPath)
	})
}
```

Call it once, right after you create the router:

```ts
// src/router.tsx
import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import { traceRouter } from "./router-tracing"

export const router = createRouter({ routeTree })

traceRouter(router)
```

A few details that are easy to get wrong:

- **Name spans with `fullPath`, not `routeId`.** Both are templates, but `routeId` includes pathless layouts and route groups (`/_authed/(app)/projects/$projectId`). `fullPath` is the URL the user sees, with the dynamic parts left as `$projectId`.
- **Interrupted navigations never resolve.** If the user clicks a second link before the first finishes loading, TanStack Router abandons the first one and never emits `onResolved` for it. `startNavigation` handles this by ending the previous span when a new one starts.
- **Redirects stay in one span.** A loader that throws `redirect()` doesn't start a new navigation event, so the span covers both routes and gets named after the one the user lands on.

## Trace route loaders

Loaders are where most of the time in a TanStack Router navigation goes, so each one gets its own span. `traced` from the helper does the work. The one TanStack-specific part is that `redirect()` and `notFound()` are thrown, and they aren't failures:

```ts
// src/router-tracing.ts, continued
export const loaderSpan = <T>(name: string, fn: () => Promise<T>) =>
	traced(name, fn, (error) => !isRedirect(error) && !isNotFound(error))
```

```ts
// src/routes/projects.$projectId.tsx
import { createFileRoute } from "@tanstack/react-router"
import { loaderSpan } from "../router-tracing"

export const Route = createFileRoute("/projects/$projectId")({
	loader: ({ params }) =>
		loaderSpan("loader /projects/$projectId", () =>
			Promise.all([fetchProject(params.projectId), fetchMembers(params.projectId)]),
		),
})
```

TanStack Router runs the loaders of nested routes in parallel, so a layout loader and a page loader show up as sibling spans under the navigation. If they overlap in the waterfall, that's working as intended. If the page loader starts only after the layout loader ends, something is making it wait.

Watch out for sequential `await`s inside a loader: only requests started before the first `await` nest under the loader span. [The await problem](#the-await-problem) explains why, and how to pass the context along when a request really does depend on the previous one.

Loaders also run when TanStack Router preloads a route, for example when the user hovers a link with `preload="intent"`. There's no navigation in progress then, so those loader spans become their own traces. That's accurate: the work happened before the click. If the user then clicks, the navigation span is often very short, because the data is already cached.

## Report errors caught by TanStack Router

TanStack Router wraps every route in an error boundary. That's why a failing loader or a component that throws shows your `errorComponent` instead of a blank page, and it's also why those errors never reach the browser SDK's global handlers.

Every error caught by those boundaries goes through the router's `defaultOnCatch` option (or a route's own `onCatch`). Report from there:

```ts
// src/router.tsx
import { MapleBrowser } from "@maple-dev/browser"
import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import { traceRouter } from "./router-tracing"
import { alreadyRecorded } from "./tracing"

export const router = createRouter({
	routeTree,
	defaultOnCatch: (error) => {
		// Loader errors are already on their loader span
		if (!alreadyRecorded(error)) MapleBrowser.captureException(error, { name: "react.render_error" })
	},
})

traceRouter(router)
```

A loader that throws ends up in the same boundary, which is what the `alreadyRecorded` check is for: the error is recorded once, on the loader span, where it has the navigation around it.

## Trace server rendering in TanStack Start

TanStack Start renders the first page on the server, which means the first page load has a server half you can trace too. Start the OpenTelemetry Node SDK as in the [Node.js guide](/docs/guides/instrumentation-nodejs) and import it before anything else in your server entry. That gives you a span for every incoming request and for the database and HTTP calls your loaders make on the server.

Then add a span around the render, and hand its trace context to the browser in a `Server-Timing` header:

```ts
// src/server.ts
import "./instrumentation" // starts the OpenTelemetry Node SDK; must load first
import { context, propagation, trace } from "@opentelemetry/api"
import { createStartHandler, defaultStreamHandler, defineHandlerCallback } from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"

const tracer = trace.getTracer("acme-web")

const handler = defineHandlerCallback((ctx) => {
	// Loaders have already run by now, so the matched route is known
	const leaf = ctx.router.state.matches.at(-1)

	return tracer.startActiveSpan(`ssr ${leaf?.fullPath ?? "unknown"}`, async (span) => {
		// Hand this trace to the browser so its pageload span can join it
		const carrier: Record<string, string> = {}
		propagation.inject(context.active(), carrier)
		if (carrier.traceparent) {
			ctx.responseHeaders.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
		}

		try {
			return await defaultStreamHandler(ctx)
		} finally {
			span.end()
		}
	})
})

export default createServerEntry({ fetch: createStartHandler(handler) })
```

On the browser side there's nothing to add. `startNavigation` reads the header through `serverContext()` and parents the `pageload` span to the server render, so the first page load becomes one trace from the incoming request to the first route resolving in the browser.

`loaderSpan` works on the server too, and better than in the browser: Node has `AsyncLocalStorage`, so fetches after an `await` keep their parent. Server-side loader spans show up under the request span without any changes.

Two things to know about the `ssr` span:

- It starts after the loaders have run, because the handler callback only runs once the router has loaded. The loaders are its siblings under the request span, not its children.
- `defaultStreamHandler` returns as soon as React starts streaming, so the span measures the time to the first byte of HTML, not the time to the last.

If your pages are cached by a CDN, skip the `server-timing` header on those responses, or every visitor's page load will join the same old trace.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does TanStack Router have built-in OpenTelemetry support?

No, not today. The TanStack Start docs have an observability page with examples, and first-class OpenTelemetry support is on their roadmap. The router events used here are part of the stable public API, so this setup doesn't depend on internals.

### Why are my TanStack Router loader spans not connected to the navigation?

Either the loader ran as a preload (there's no navigation to attach to yet), or the fetch happened after an `await` inside the loader. Start the requests before the first `await`, for example with `Promise.all`, or pass the context along explicitly.

### Can I use this with TanStack Router without TanStack Start?

Yes. Everything up to the server rendering section works in a client-only TanStack Router app. Without a server render, `serverContext()` finds no header and the `pageload` span starts its own trace.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
