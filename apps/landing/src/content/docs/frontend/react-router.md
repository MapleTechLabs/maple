---
title: "Frontend tracing for React Router"
description: "Trace every React Router navigation, loader and action as one OpenTelemetry trace with the router's instrumentation API, and link framework mode's server render to the browser."
group: "Frontend"
order: 2
navLabel: "React Router"
icon: "reactrouter"
---

React Router knows when a navigation starts, which loaders it runs, and when the new route is ready, and since 7.15 it has a stable instrumentation API that wraps every loader and action in one place. This guide turns that into one trace per click: a span for the navigation, a span per loader and action, the fetches those loaders made, and the backend spans behind them. In framework mode, the first page load also includes the server render. The code uses APIs that are stable in React Router 7.15 and later, and was checked against 8.4.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses React Router.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the browser SDK

```bash
npm install @maple-dev/browser @opentelemetry/api
```

`@opentelemetry/api` is for the tracing helper below. The SDK already depends on it, but strict package managers like pnpm only resolve packages you list yourself.

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

Import `./maple` first in your client entry: `src/main.tsx` in data mode, `app/entry.client.tsx` in framework mode.

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

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The fix is a span per navigation, with the data-loading and `fetch` spans nested under it. Add this helper as `src/tracing.ts`; the rest of this guide connects it to React Router:

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

In the browser, a span only stays active until the first `await` inside it. A request that starts after an `await` loses its parent and shows up as a separate trace.

```ts
// ❌ fetchMembers starts after an await, so it becomes its own trace
traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id)
	return { project, members }
})
```

```ts
// ✅ Save the context before the first await, and run later requests inside it
import { context } from "@opentelemetry/api"

traced("load project", async () => {
	const ctx = context.active()
	const project = await fetchProject(id)
	const members = await context.with(ctx, () => fetchMembers(project.id))
	return { project, members }
})
```

If the requests don't depend on each other, start them together with `Promise.all` instead. Both nest under the span, and the page stops waiting on one request before starting the next.

This happens because browsers have no equivalent of Node's `AsyncLocalStorage`, which is what carries the active span across `await` on the server.

## Which React Router mode you're using

- **Data mode** (`createBrowserRouter` and `RouterProvider`) is the main path here. You create the router object, so you can subscribe to it.
- **Framework mode** (the Vite plugin, formerly Remix) uses the same instrumentation API, but creates the router for you. It has [its own section](#react-router-framework-mode-entryclient-and-server-rendering), including server rendering.
- **Declarative mode** (`<BrowserRouter>`) has no loaders and no navigation state, so there's no start event to measure from. If you want navigation spans, move to `createBrowserRouter`; `createRoutesFromElements` lets you keep your `<Route>` JSX.

## Trace React Router navigations with `router.subscribe`

A data router calls your subscriber on every state change. `state.navigation.state` is `"idle"` when nothing is happening, `"loading"` or `"submitting"` while a navigation runs its loaders or action, and `"idle"` again once the new route is committed. That's your start and end:

```ts
// src/router-tracing.ts
import type { DataRouteMatch, DataRouter } from "react-router"
import { endNavigation, startNavigation } from "./tracing"

/** Adds the leading slash that framework mode's patterns leave off. */
export const routePattern = (pattern: string) => `/${pattern}`.replace(/\/+/g, "/")

// Each route's path is relative to its parent. Layout and index routes have none.
const matchedPattern = (matches: DataRouteMatch[]) =>
	routePattern(matches.map((match) => match.route.path).filter(Boolean).join("/"))

export function traceNavigations(router: DataRouter) {
	// The first route's loaders may still be running
	let loading = !router.state.initialized
	let pathname = router.state.location.pathname
	if (!loading) endNavigation(matchedPattern(router.state.matches))

	router.subscribe((state) => {
		if (state.navigation.state !== "idle") {
			// A redirect or a second click while loading continues the same span
			if (!loading) startNavigation(state.navigation.location.pathname)
			loading = true
			return
		}

		// Fetcher loads, revalidations, and hash changes aren't navigations
		if (!loading && state.location.pathname === pathname) return
		// Routes without loaders go straight to the new location
		if (!loading) startNavigation(state.location.pathname)

		endNavigation(matchedPattern(state.matches))
		loading = false
		pathname = state.location.pathname
	})
}
```

The span name comes from `state.matches`. Each route's `path` is relative to its parent, and layout and index routes have none, so joining the matched paths gives you `/projects/:projectId`, a route template rather than a concrete URL.

A few cases worth knowing:

- **The first page load is already running** when you subscribe, because `createBrowserRouter` starts the first route's loaders immediately. The next section starts the `pageload` span earlier; `traceNavigations` ends it once `router.state.initialized` turns true.
- **Redirects and interrupted navigations are one span.** A loader that throws `redirect()` keeps the router in `"loading"`, and so does a second click. The span is named after the route the user ended up on, and `url.path` keeps the path they started from.
- **Routes without loaders never enter `"loading"`**, so their span starts and ends in the same callback. It has no duration, but it still counts the view.
- **Back and forward buttons and search param changes** are traced like any other navigation. Hash changes run nothing and are skipped.
- **A URL that matches no route** only matches the root route, so its span is named `navigate /`, like the home page. `url.path` keeps the URL that was requested.

## Trace loaders and actions with React Router's instrumentation API

Loaders are where most of the time in a navigation goes. React Router's `instrumentations` option lets you wrap every route's loader and action in one place, and the helper's `traced` does the span work:

```ts
// src/router-tracing.ts, continued
import type { ClientInstrumentation, InstrumentationHandlerResult, InstrumentRouteFunction } from "react-router"
import { traced } from "./tracing"

async function handlerSpan(name: string, handler: () => Promise<InstrumentationHandlerResult>) {
	try {
		await traced(name, async () => {
			const result = await handler()
			if (result.status === "error") throw result.error
		})
	} catch {
		// Only the span needs the error; React Router rethrows it to your app itself
	}
}

export const traceRouteHandlers: InstrumentRouteFunction = (route) => {
	route.instrument({
		loader: (handler) => handlerSpan(`loader ${route.id}`, handler),
		action: (handler) => handlerSpan(`action ${route.id}`, handler),
	})
}

export const tracing: ClientInstrumentation = {
	// Runs once, when the router is created and before it loads the first route
	router: () => startNavigation(window.location.pathname),
	route: traceRouteHandlers,
}
```

Pass it to the router, and call `traceNavigations` right after:

```tsx
// src/router.tsx
import { createBrowserRouter } from "react-router"
import { traceNavigations, tracing } from "./router-tracing"
import { fetchMembers, fetchProject, ProjectPage, RootLayout } from "./app"

export const router = createBrowserRouter(
	[
		{
			id: "root",
			path: "/",
			Component: RootLayout,
			children: [
				{
					// Loader spans are named after the route id, so give routes a readable one
					id: "project",
					path: "projects/:projectId",
					loader: ({ params }) => Promise.all([fetchProject(params.projectId!), fetchMembers(params.projectId!)]),
					Component: ProjectPage,
				},
			],
		},
	],
	{ instrumentations: [tracing] },
)

traceNavigations(router)
```

The instrumented handler never throws. It resolves to `{ status, error }`, and React Router passes the loader's real result or error to your app on its own. So `handlerSpan` rethrows the error into `traced`, which records it on the span, and then swallows it.

React Router also decides what counts as a failure: only a thrown `Error`. A thrown `redirect()`, `data()`, or `Response` is reported as success, which is right for redirects and 404s, so `traced` doesn't need its `isFailure` argument here. The flip side is that `throw data("...", { status: 500 })` won't mark the span as failed. Throw an `Error` for real failures.

In data mode, route ids default to their position in the tree, like `0-1`, so give your routes an `id`.

Nested routes' loaders run in parallel and show up as sibling spans. Only requests started before a loader's first `await` nest under its span; see [the await problem](#the-await-problem). Loaders called by a fetcher (`useFetcher().load()`) run outside any navigation, so they start their own traces.

## Report errors caught by React Router with `onError`

React Router catches every loader, action, and render error to show your `ErrorBoundary`, which keeps them away from the browser SDK's global handlers. `RouterProvider` takes an `onError` callback that gets each of those errors once, with the route pattern:

```ts
// src/router-tracing.ts, continued
import { MapleBrowser } from "@maple-dev/browser"
import { type ClientOnErrorFunction, isRouteErrorResponse } from "react-router"
import { alreadyRecorded } from "./tracing"

export const reportRouteError: ClientOnErrorFunction = (error, { pattern }) => {
	// Thrown responses, like a 404 from a loader, are expected
	if (isRouteErrorResponse(error)) return
	// Loader and action errors are already on their span
	if (alreadyRecorded(error)) return
	MapleBrowser.captureException(error, {
		name: "react_router.error",
		attributes: { "app.route": routePattern(pattern) },
	})
}
```

```tsx
// src/main.tsx
import "./maple" // first, before anything renders
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router/dom"
import { router } from "./router"
import { reportRouteError } from "./router-tracing"

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} onError={reportRouteError} />)
```

This beats reporting from inside an `ErrorBoundary`, which can render more than once for the same error. Loader errors reach `onError` too, so the `alreadyRecorded` check keeps them to one report, on the loader span.

## React Router framework mode: entry.client and server rendering

Framework mode uses the same `instrumentations` and `onError`, passed to `HydratedRouter` in `app/entry.client.tsx`. Run `npx react-router reveal` first if you don't have the entry files yet:

```tsx
// app/entry.client.tsx
import "./maple"
import { startTransition, StrictMode } from "react"
import { hydrateRoot } from "react-dom/client"
import { HydratedRouter } from "react-router/dom"
import { reportRouteError, tracing } from "./router-tracing"

startTransition(() => {
	hydrateRoot(
		document,
		<StrictMode>
			<HydratedRouter instrumentations={[tracing]} onError={reportRouteError} />
		</StrictMode>,
	)
})
```

The catch is that `HydratedRouter` creates the router itself, so there's nothing to subscribe to. The closest official hook is the `navigate` instrumentation, which wraps each call to the router's `navigate` and reports the matched pattern. In framework mode, the helper, `maple.ts` and `router-tracing.ts` live in `app/`. Keep `routePattern`, `traceRouteHandlers`, and `reportRouteError` from above in `app/router-tracing.ts`, drop `traceNavigations`, and replace `tracing`:

```ts
// app/router-tracing.ts
import type { ClientInstrumentation } from "react-router"
import { endNavigation, startNavigation } from "./tracing"

// Route ids to their paths, for naming the pageload span
const routePaths = new Map<string, string | undefined>()

/** The template of the matched routes, from `useMatches()`. */
export const matchesPattern = (matches: { id: string }[]) =>
	routePattern(matches.map((match) => routePaths.get(match.id)).filter(Boolean).join("/"))

let latest = 0

export const tracing: ClientInstrumentation = {
	router({ instrument }) {
		startNavigation(window.location.pathname)

		instrument({
			navigate: async (navigate, { to }) => {
				// navigate(-1) is a history navigation, like the back button; hash links run nothing
				if (typeof to === "number" || to.startsWith("#")) return
				const id = ++latest
				// `to` can carry a query string, or be relative, like `edit`
				startNavigation(new URL(to, window.location.href).pathname)
				const { meta } = await navigate()
				// A newer navigation has already replaced this one
				if (id === latest) endNavigation(meta && routePattern(meta.pattern))
			},
		})
	},
	route(route) {
		routePaths.set(route.id, route.path)
		traceRouteHandlers(route)
	},
}
```

With server rendering, the loaders for the first page already ran on the server, so the `pageload` span ends once the page hydrates. End it in the root route's `Layout`, not in `App`: `Layout` also wraps the root `ErrorBoundary`, so 404 and error pages end the span too. `routePaths` maps the matched route ids to their paths, which gives the span its template:

```tsx
// app/root.tsx
import { useEffect } from "react"
import { useMatches } from "react-router"
import { matchesPattern } from "./router-tracing"
import { endNavigation } from "./tracing"

export function Layout({ children }: { children: React.ReactNode }) {
	const matches = useMatches()
	// The server already ran the loaders, so the first page is ready once it hydrates
	useEffect(() => endNavigation(matchesPattern(matches)), [])
	// ...the rest of the generated Layout, unchanged
}
```

Framework mode's client side has gaps that data mode doesn't:

- **Back and forward buttons aren't traced.** They go through the browser's history, not `navigate`, so there's no navigation span and their loaders start their own traces.
- **Server loader requests are separate traces.** React Router fetches server loader data in one `.data` request per navigation, and starts it after an `await`. That's the [`await` problem](#the-await-problem) inside React Router itself: the request and the server spans behind it land in their own trace. The loader span under your navigation still shows how long the browser waited.
- **Redirected navigations are named after the route that was clicked**, not the one the user landed on.
- **Client loaders that run on hydration are usually their own trace.** A route with only a `clientLoader`, or with `clientLoader.hydrate`, loads its data after the page hydrates, which is after the `pageload` span ended.
- **A URL that matches no route is named after the root route**, `navigate /` or `pageload /`. The server span's 404 `http.response.status_code` tells it apart from the home page.
- **Every route gets a `loader` span**, even routes without a loader, because React Router loads the route's module and styles through it. Those spans show the time spent downloading code.

### Trace the server render and link it to the pageload

Start the OpenTelemetry Node SDK as in the [Node.js guide](/docs/guides/instrumentation-nodejs), loaded before the server build with Node's `--import` flag:

```json
"start": "NODE_OPTIONS='--import ./instrumentation.server.mjs' react-router-serve ./build/server/index.js"
```

That gives you a span for every incoming request and for the database and HTTP calls your loaders make. The HTTP server span also reads the `traceparent` header, so a `.data` request's server spans join the browser request that made it.

The server entry takes its own `instrumentations` export. Add a span per request, named after the matched pattern, and reuse `traceRouteHandlers` for server loaders:

```ts
// app/entry.server.tsx: add to the file that `react-router reveal` generates
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api"
import { type HandleErrorFunction, isRouteErrorResponse, type ServerInstrumentation } from "react-router"
import { routePattern, traceRouteHandlers } from "./router-tracing"
import { alreadyRecorded } from "./tracing"

const tracer = trace.getTracer("acme-web")

export const instrumentations: ServerInstrumentation[] = [
	{
		handler: ({ instrument }) =>
			instrument({
				// Page requests, and the .data requests of client-side navigations
				request: (handle, { request }) =>
					tracer.startActiveSpan(request.method, async (span) => {
						const { meta, statusCode } = await handle()
						if (meta) span.updateName(`${request.method} ${routePattern(meta.pattern)}`)
						span.setAttribute("http.response.status_code", statusCode)
						if (statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
						span.end()
					}),
			}),
		// Loader and action spans on the server, the same as in the browser
		route: traceRouteHandlers,
	},
]

// Render errors during a page request reach neither onError nor a loader span
export const handleError: HandleErrorFunction = (error, { request }) => {
	// Aborted requests aren't failures
	if (request.signal.aborted) return
	console.error(error)
	// Thrown responses, like a 404, are expected, and loader errors are already on their span
	if (isRouteErrorResponse(error) || alreadyRecorded(error)) return
	trace.getActiveSpan()?.recordException(error instanceof Error ? error : String(error))
}
```

Then hand the trace to the browser at the top of the generated `handleRequest`, which renders the page:

```tsx
export default function handleRequest(
	request: Request,
	responseStatusCode: number,
	responseHeaders: Headers,
	routerContext: EntryContext,
	loadContext: RouterContextProvider,
) {
	// Hand this trace to the browser so its pageload span can join it
	const carrier: Record<string, string> = {}
	propagation.inject(context.active(), carrier)
	if (carrier.traceparent) {
		responseHeaders.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
	}

	// ...the rest of the generated handleRequest, unchanged
```

`handleRequest` runs inside the request span, so `context.active()` is that span. The browser needs nothing more: `startNavigation` reads the header through `serverContext()` and parents the `pageload` span to the server request, so the first page load is one trace from the request arriving to the page hydrating.

Some things to know about the server side:

- **The request span nests under the Node SDK's HTTP span**, which only knows the URL. The React Router span adds the route pattern and the loader spans.
- **It ends when the response starts streaming**, because the default entry resolves the response once React's shell is ready. It measures time to first byte, not the full stream.
- **Defining `handleError` replaces React Router's default logging**, which is why it calls `console.error` itself. React Router also calls it for URLs that match no route, with a 404 response, so the `isRouteErrorResponse` check keeps those off the error list.
- **Only page responses carry the header.** `.data` requests and static assets don't go through `handleRequest`.
- **Cached HTML shares one trace.** If a CDN caches your pages, skip the `server-timing` header on those responses.

## React Router tracing gotchas

- **Framework mode patterns have no leading slash.** The root route's path is empty, so `pattern` is `projects/:projectId`. `routePattern` adds the slash so browser and server spans get the same names.
- **Older versions use `unstable_` names.** `instrumentations` was `unstable_instrumentations` from 7.9.5 until 7.15, and `onError` was `unstable_onError` until 7.11. Before 7.9.5, wrap loaders with `traced` by hand.
- **A throwing instrumentation doesn't break your app.** React Router catches and logs the error, then runs the loader anyway.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does React Router have built-in OpenTelemetry support?

Not directly. Since 7.15 it has a stable, vendor-neutral instrumentation API with hooks around navigations, fetcher calls, loaders, actions, middleware, and server requests. It doesn't create spans or export anything, so you plug your own tracer in, as this guide does.

### Why are my React Router loader spans not connected to the navigation?

Usually one of three things: the loader ran for a fetcher, so there was no navigation; you're in framework mode and the user pressed back or forward; or the loader made its request after an `await`. Start requests before the first `await`, for example with `Promise.all`.

### Can I trace navigations with `<BrowserRouter>`?

Only partly. Declarative mode has no loaders and no navigation state, so you can record that a route rendered, but not how long the navigation took. `createBrowserRouter` with `createRoutesFromElements` keeps your route components and gives you everything in this guide.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
