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

The router emits lifecycle events you can subscribe to with `router.subscribe`. Three of them are enough:

- `onBeforeNavigate` fires when a navigation starts, before any loader runs.
- `onResolved` fires once every loader has finished and the new route is committed.
- `onRendered` fires after the new route rendered. It is also the only event TanStack Start emits when it hydrates a server-rendered page.

```ts
// src/router-tracing.ts
import { type AnyRouter, isNotFound, isRedirect, rootRouteId } from "@tanstack/react-router"
import { endNavigation, startNavigation, traced } from "./tracing"

export function traceRouter(router: AnyRouter) {
	// The router also emits these events while rendering on the server
	if (typeof window === "undefined") return

	// The first page load. TanStack Start hydrates a server-rendered page without onBeforeNavigate or onResolved
	startNavigation(window.location.pathname)
	// History index of the navigation in flight
	let pending: number | undefined

	router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
		// No fromLocation: the first load, already open. Same path and search: a hash link or router.invalidate()
		if (!fromLocation || (fromLocation.pathname === toLocation.pathname && fromLocation.searchStr === toLocation.searchStr)) return
		// redirect() replaces the history entry of the navigation it came from: keep that span
		if (toLocation.state.__TSR_index === pending) return
		pending = toLocation.state.__TSR_index
		startNavigation(toLocation.pathname)
	})

	const end = () => {
		pending = undefined
		endNavigation(routeTemplate(router))
	}
	router.subscribe("onResolved", end)
	// Hydration emits only onRendered
	router.subscribe("onRendered", end)
}

/** The matched route's template, like `/projects/$id`. Only the root matched: a URL no route handles */
export function routeTemplate(router: AnyRouter) {
	const leaf = router.state.matches.at(-1)
	return leaf?.routeId === rootRouteId ? "not-found" : leaf?.fullPath
}
```

Call it once, right after you create the router. In TanStack Start, `src/router.tsx` exports a `getRouter()` function, which also runs on the server for every request; the `window` check makes that a no-op:

```ts
// src/router.tsx
import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import { traceRouter } from "./router-tracing"

export function getRouter() {
	const router = createRouter({ routeTree })
	traceRouter(router)
	return router
}
```

In a client-only TanStack Router app that exports `const router = createRouter(...)`, call `traceRouter(router)` right after it.

A few details that are easy to get wrong:

- **Name spans with `fullPath`, not `routeId`.** Both are templates, but `routeId` includes pathless layouts and route groups (`/_authed/(app)/projects/$projectId`). `fullPath` is the URL the user sees, with the dynamic parts left as `$projectId`. When no route matches the URL, only the root route is left, and its `fullPath` is `/`. `routeTemplate` names that case `not-found`, so 404 pages don't count as visits to your home page.
- **The first page load has to be opened by hand.** When TanStack Start hydrates a server-rendered page, the router already has its data and emits neither `onBeforeNavigate` nor `onResolved`, so `traceRouter` opens the `pageload` span as soon as the router exists and ends it on `onRendered`. In a client-only app, the first `router.load()` does emit `onBeforeNavigate`, without a `fromLocation`; the listener skips it because the span is already open.
- **Interrupted navigations never resolve.** If the user clicks a second link before the first finishes loading, TanStack Router abandons the first one and never emits `onResolved` for it. `startNavigation` handles this by ending the previous span when a new one starts.
- **Redirects stay in one span.** A `redirect()` thrown from `beforeLoad` or a loader starts a second navigation that replaces the current history entry. The `__TSR_index` check recognizes it, so the span covers both routes, keeps the original `url.path`, and gets named after the route the user lands on.
- **Search changes are navigations, hash links aren't.** Going from `/projects/1` to `/projects/1?tab=members` makes a `navigate /projects/$projectId` span, with a loader span only if the route's `loaderDeps` read the search. A link to `#section` on the same page makes no span. Back and forward are navigations.

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

Wrap `beforeLoad` the same way if it does I/O or can throw.

TanStack Router runs the loaders of nested routes in parallel, so a layout loader and a page loader show up as sibling spans under the navigation. If they overlap in the waterfall, that's working as intended. If the page loader starts only after the layout loader ends, something is making it wait.

Watch out for sequential `await`s inside a loader: only requests started before the first `await` nest under the loader span. [The await problem](#the-await-problem) explains why, and how to pass the context along when a request really does depend on the previous one.

A loader that turns an API 404 into `throw notFound()` leaves its span Ok, since `loaderSpan` doesn't count `notFound()` as a failure. The `fetch` span that got the 404 is still marked as an error, like every 4xx client span.

Loaders also run when TanStack Router preloads a route, for example when the user hovers a link with `preload="intent"`. There's no navigation in progress then, so those loader spans become their own traces. That's accurate: the work happened before the click. If the user then clicks, the router renders the preloaded data right away and reloads it in the background, so the navigation span is very short and can end before its loader span does.

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

export function getRouter() {
	const router = createRouter({
		routeTree,
		defaultOnCatch: (error) => {
			// Loader errors are already on their loader span, in the browser or, for the first page load, on the server
			if (alreadyRecorded(error) || router.state.matches.some((match) => match.error === error)) return
			MapleBrowser.captureException(error, { name: "react.render_error" })
		},
	})
	traceRouter(router)
	return router
}
```

A loader that throws ends up in the same boundary, and both checks keep it from being reported twice. `alreadyRecorded` matches errors from loaders that ran in the browser. The `matches` check covers a loader that failed during server rendering: the server recorded it on its own loader span, and the browser only receives a copy of the error, which `alreadyRecorded` can't recognize. That check also skips errors from `beforeLoad`, which is one more reason to wrap a `beforeLoad` that can throw.

What's left are render errors. Each one is reported once, as a `react.render_error` span.

## Trace server rendering in TanStack Start

TanStack Start renders the first page on the server, which means the first page load has a server half you can trace too. Start the OpenTelemetry Node SDK as in the [Node.js guide](/docs/guides/instrumentation-nodejs), in a `src/instrumentation.ts` file, and import it before anything else in your server entry. If your server process already loads the SDK with `node --import`, skip that import. That gives you spans for the HTTP calls your loaders make on the server.

The Start scaffold doesn't include a server entry, so create `src/server.ts`. TanStack Start uses it instead of its default one. It opens a span for every request, names it after the route once the route is known, and hands its trace context to the browser in a `Server-Timing` header:

```ts
// src/server.ts
import "./instrumentation" // starts the OpenTelemetry Node SDK; must load first
import { context, propagation, SpanKind, trace } from "@opentelemetry/api"
import { createStartHandler, defaultStreamHandler, defineHandlerCallback } from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"
import { routeTemplate } from "./router-tracing"

const tracer = trace.getTracer("acme-web")

const handler = defineHandlerCallback((ctx) => {
	// Loaders have already run by now, so the matched route is known
	trace.getActiveSpan()?.updateName(`ssr ${routeTemplate(ctx.router)}`)

	// Hand this trace to the browser so its pageload span can join it
	const carrier: Record<string, string> = {}
	propagation.inject(context.active(), carrier)
	if (carrier.traceparent) {
		ctx.responseHeaders.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
	}
	return defaultStreamHandler(ctx)
})

const startHandler = createStartHandler(handler)

export default createServerEntry({
	// One span per request, so the server loaders and the render share a trace
	fetch: (request, opts) =>
		tracer.startActiveSpan(
			request.method,
			{ kind: SpanKind.SERVER, attributes: { "url.path": new URL(request.url).pathname } },
			async (span) => {
				try {
					return await startHandler(request, opts)
				} finally {
					span.end()
				}
			},
		),
})
```

If your app already has a `src/server.ts`, keep its handler and wrap it the same way.

On the browser side there's nothing to add. `startNavigation` reads the header through `serverContext()` and parents the `pageload` span to the `ssr` span, so the first page load becomes one trace: the request, the loaders that ran on the server, their fetches and your backend's spans, and the page load in the browser.

`loaderSpan` works on the server too, and better than in the browser: Node has `AsyncLocalStorage`, so fetches after an `await` keep their parent. Server-side fetches get spans from OpenTelemetry's undici instrumentation, which the Node.js guide's auto-instrumentations include.

A few things to know about the `ssr` span:

- It has to be opened in the `fetch` wrapper. The router runs the loaders before it calls the handler callback, so a span opened inside the callback would leave every loader in a trace of its own. The HTTP server instrumentation doesn't help here either: a server entry is imported after the server is already listening (as with `vite preview`), too late to be instrumented.
- Requests that don't render a page, like server functions and redirects, keep the HTTP method as their span name and get no `server-timing` header.
- `defaultStreamHandler` returns as soon as React starts streaming, so the span measures the time to the first byte of HTML, not the time to the last.

If your pages are cached by a CDN, skip the `server-timing` header on those responses, or every visitor's page load will join the same old trace. TanStack Start doesn't set an `ETag` on HTML, so a browser revalidation can't reuse an old header.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does TanStack Router have built-in OpenTelemetry support?

No, not today. The TanStack Start docs have an observability page with examples, and first-class OpenTelemetry support is on their roadmap. This setup uses the router's public events, plus the history index TanStack Router keeps in `location.state.__TSR_index` to recognize redirects.

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
