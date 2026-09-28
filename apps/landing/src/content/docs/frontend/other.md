---
title: "Frontend tracing for other frameworks"
description: "Trace navigations, data loading and caught errors in any browser app with OpenTelemetry, whatever router it uses, and link them to your backend and server render."
group: "Frontend"
order: 7
navLabel: "Other frameworks"
icon: "javascript"
---

Use this guide when your frontend has no guide of its own: Solid, Qwik, Preact, Astro, Remix v2, Ember, Lit, a hand-rolled router, or a multi-page app. The setup is the same everywhere. What changes is where each piece plugs in, and this page shows how to find those places in your framework's API.

By the end, a click produces one trace with a span for the navigation, spans for the data it loads, the fetches those make, and the backend spans behind them.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses a framework without its own Maple guide (say which one).

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

Import `./maple` first in the module that runs first in the browser: the client entry (`main.ts`, `entry-client.tsx`, `client.ts`), or a `<script>` in the base layout for server-first frameworks like Astro. It must run before the app renders and before other code that wraps `fetch`.

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

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The fix is a span per navigation, with the data-loading and `fetch` spans nested under it. Add this helper as `src/tracing.ts`; the rest of this guide connects it to your router:

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

## Trace navigations

Look for two hooks in your router's API: one that fires when a navigation starts, and one that fires when the new route is ready.

| Look for | Examples | Call |
| --- | --- | --- |
| A "navigation started" event or guard | `beforeNavigate`, `beforeEach`, `NavigationStart`, `onBeforeNavigate`, `useBeforeLeave` | `startNavigation(path)` |
| A "navigation finished" or "route resolved" event | `afterNavigate`, `afterEach`, `NavigationEnd`, `onResolved`, a router `subscribe` whose state goes from loading to idle | `endNavigation(template)` |
| Failed or cancelled navigations | `NavigationCancel`, `NavigationError`, a `failure` argument | `endNavigation(template)` too |

Some details to handle:

- **The first load.** The first call to `startNavigation` becomes the `pageload` span. If your router doesn't emit a start event for the initial route, call `startNavigation(location.pathname)` yourself right after `init`, before the router's first render.
- **Query-only and hash-only changes.** Skip them unless they load data.
- **No start event at all.** Wrap `history.pushState` and `history.replaceState` and listen to `popstate` to call `startNavigation`, and end the span on the framework's "route rendered" hook. As a last resort, calling `startNavigation` and `endNavigation` together from a route-change effect still names and counts every route change.
- **Multi-page apps**, where every navigation is a full page load: call `startNavigation(location.pathname)` right after `init` and `endNavigation(template)` on the window `load` event. Each page load becomes a `pageload` span, and [linking it to the server render](#link-the-first-page-load-to-the-server-render) puts it in the server's trace.

### Find the route template

The span name needs the matched route's pattern, not the URL. Look on the matched route, or the last of the matches, for a property like `path`, `fullPath`, `route.id`, `pattern`, `routeConfig.path` or `matched[].path`. Nested routers often store a relative path per level; join them. If the router exposes no pattern, rebuild one by replacing the known param values in the pathname with `:name`. If there are no params either, call `endNavigation()` without a template and keep the generic span name rather than a concrete URL.

## Trace data loading

Find your router's route-level data mechanism: `loader`, `load`, `resolve`, `routeData`, `createAsync`, or a guard that fetches. Wrap each one with `traced("loader <template>", fn, isFailure)`.

Most routers throw on purpose for control flow: redirects, not-found, HTTP error helpers. They usually export a guard like `isRedirect` or `isHttpError`. Return `false` from `isFailure` for those, so a redirect isn't recorded as an error.

If the app fetches data in components and has no route-level mechanism, don't wrap every component. Requests started while the navigation is in progress still show up as `fetch` spans, just as their own traces.

## Report errors your framework catches

The SDK's global handlers only see errors that nothing caught. Most frameworks catch rendering and data-loading errors to show an error page, so those errors never reach `window.onerror`. Find the one place they flow through: a framework error handler (`app.config.errorHandler`, an `ErrorHandler` provider, a `handleError` hook), a router `onError`, or the root error boundary component. Report from there:

```ts
import { MapleBrowser } from "@maple-dev/browser"
import { alreadyRecorded } from "./tracing"

function reportCaughtError(error: unknown) {
	// Errors thrown inside traced() are already on their span
	if (!alreadyRecorded(error)) MapleBrowser.captureException(error)
}
```

The `alreadyRecorded` check matters because a loader that throws usually ends up in the same handler. Without it, one failed loader shows up as two errors. `captureException` also records each error object only once, so reporting and rethrowing is safe.

## Link the first page load to the server render

If your framework renders the first page on the server, that render is part of what the user waits for. The server side is ordinary backend tracing: set up OpenTelemetry for your server's runtime from [Instrument your application](/docs/instrumentation), and add a span around the render in the hook that sees the response before it's sent (a server entry, a request middleware, a `handle` hook).

Then, from inside that span, write the trace context into a `Server-Timing` response header:

```ts
import { context, propagation } from "@opentelemetry/api"

const carrier: Record<string, string> = {}
propagation.inject(context.active(), carrier)
if (carrier.traceparent) {
	response.headers.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
}
```

The browser can read that header from the Navigation Timing API, and `serverContext()` in the helper uses it to parent the `pageload` span, so the first page load is one trace from the incoming request to the first route in the browser. If your framework already renders a `<meta name="traceparent">` tag, `serverContext()` reads that instead. If you're adding it yourself, prefer the header: it keeps the value out of the HTML, so the server and client versions of your `<head>` can't disagree during hydration.

- Only the `pageload` span joins the server trace. Later navigations are new work and get their own traces.
- If a CDN caches your HTML, it caches the header too, and every visitor joins the same old trace. Skip the header on cached responses.
- If the framework sends an `ETag` with HTML, a reload gets a 304 without your header, and the browser reuses the one it cached with the page. Drop the `ETag` on responses that carry the header.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Can OpenTelemetry trace a browser application?

Yes. OpenTelemetry's JavaScript SDK has a web tracer and instrumentations for `fetch`, `XMLHttpRequest` and document load. Browser support is still marked experimental, and the biggest gap is async context: the default context manager loses the active span after an `await`.

### Why are my browser and backend spans in separate traces?

Usually one of three things: the API's origin isn't in `propagateTraceHeaderCorsUrls`, the API's CORS preflight doesn't allow the `traceparent` header, or the backend isn't instrumented to read it. Check the request headers in your browser's network tab first. If there's no `traceparent`, it's the frontend config; if it's there, it's the backend.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
