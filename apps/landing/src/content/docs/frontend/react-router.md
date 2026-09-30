---
title: "Frontend tracing for React Router"
description: "Trace every React Router navigation, loader and action as one OpenTelemetry trace with the router's instrumentation API, and link framework mode's server render to the browser."
group: "Frontend"
order: 2
navLabel: "React Router"
icon: "reactrouter"
---

React Router knows when a navigation starts, which loaders it runs, and when the new route is ready, and since 7.15 it has a stable instrumentation API that wraps every loader and action in one place. This guide turns that into one trace per click: a span for the navigation, a span per loader and action, the fetches those loaders made, and the backend spans behind them. In framework mode, the first page load also includes the server render. It works with React Router 7.15 and later, and was checked against 8.4.

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

## Navigation and data-loading spans

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The SDK fixes that with a span per navigation, and the data-loading and `fetch` spans nested under it. Three calls do the work:

- `MapleBrowser.startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `MapleBrowser.endNavigation(route)` names the span after the route template and ends it.
- `MapleBrowser.traced(name, fn, { isFailure })` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`. An error it recorded isn't reported a second time by `captureException` or the SDK's global error handlers.

The React Router integration below connects them to React Router.

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

## Which React Router mode you're using

`@maple-dev/browser/react-router` needs React Router 7.15 or later, the first version with the stable `instrumentations` API.

- **Data mode** (`createBrowserRouter` and `RouterProvider`) is the main path here. You create the router object, so the SDK can subscribe to it.
- **Framework mode** (the Vite plugin, formerly Remix) uses the same instrumentation API, but creates the router for you. It has [its own section](#react-router-framework-mode-entryclient-and-server-rendering), including server rendering. Naming its navigation spans after the route needs React Router 8.1 or later.
- **Declarative mode** (`<BrowserRouter>`) has no loaders and no navigation state, so there's no start event to measure from. If you want navigation spans, move to `createBrowserRouter`; `createRoutesFromElements` lets you keep your `<Route>` JSX.

## Trace React Router navigations, loaders and actions

Two pieces cover data mode. `dataRouterInstrumentation` goes in React Router's `instrumentations` option: it starts the `pageload` span before the first route's loaders run, and wraps every loader and action in a span. `traceNavigations` subscribes to the router and turns each navigation into a span. Call it right after you create the router:

```tsx
// src/router.tsx
import { dataRouterInstrumentation, traceNavigations } from "@maple-dev/browser/react-router"
import { createBrowserRouter } from "react-router"
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
	{ instrumentations: [dataRouterInstrumentation] },
)

traceNavigations(router)
```

Navigation spans are named after the matched route pattern, like `navigate /projects/:projectId`, a route template rather than a concrete URL. Loader and action spans are named after the route id, like `loader project`. In data mode, route ids default to their position in the tree, like `0-1`, so give routes with loaders an `id`.

A few cases worth knowing:

- **Redirects and interrupted navigations are one span.** A loader that throws `redirect()` keeps the router loading, and so does a second click. The span is named after the route the user ended up on, and `url.path` keeps the path they started from.
- **Routes without loaders** go straight to the new location, so their span starts and ends at once. It has no duration, but it still counts the view.
- **Back and forward buttons and search param changes** are traced like any other navigation. Hash changes, revalidations and fetcher loads start no span.
- **A URL that matches no route** only matches the root route, so its span is named `navigate /`, like the home page. `url.path` keeps the URL that was requested.
- **Only a thrown `Error` fails a loader span.** React Router reports a thrown `redirect()`, `data()` or `Response` as success, which is right for redirects and 404s. The flip side is that `throw data("...", { status: 500 })` won't mark the span as failed. Throw an `Error` for real failures.

Nested routes' loaders run in parallel and show up as sibling spans. Only requests started before a loader's first `await` nest under its span; see [the await problem](#the-await-problem). Loaders called by a fetcher (`useFetcher().load()`) run outside any navigation, so they start their own traces.

## Report errors caught by React Router with `onError`

React Router catches every loader, action, and render error to show your `ErrorBoundary`, which keeps them away from the browser SDK's global handlers. `RouterProvider` takes an `onError` callback that gets each of those errors once. Pass `reportRouteError`:

```tsx
// src/main.tsx
import "./maple" // first, before anything renders
import { reportRouteError } from "@maple-dev/browser/react-router"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router/dom"
import { router } from "./router"

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} onError={reportRouteError} />)
```

It reports each error as a `react_router.error` span with the route pattern in `app.route`, and skips two kinds: thrown responses, like a 404 from a loader, which are expected, and errors a loader or action span already recorded, so a failed loader is one report, on its span. If you have your own `onError`, call `reportRouteError` from it.

This beats reporting from inside an `ErrorBoundary`, which can render more than once for the same error.

## React Router framework mode: entry.client and server rendering

Framework mode uses its own instrumentation, `frameworkInstrumentation`, and the same `onError`, passed to `HydratedRouter` in `app/entry.client.tsx`. Run `npx react-router reveal` first if you don't have the entry files yet:

```tsx
// app/entry.client.tsx
import "./maple"
import { frameworkInstrumentation, reportRouteError } from "@maple-dev/browser/react-router"
import { startTransition, StrictMode } from "react"
import { hydrateRoot } from "react-dom/client"
import { HydratedRouter } from "react-router/dom"

startTransition(() => {
	hydrateRoot(
		document,
		<StrictMode>
			<HydratedRouter instrumentations={[frameworkInstrumentation]} onError={reportRouteError} />
		</StrictMode>,
	)
})
```

`HydratedRouter` creates the router itself, so there's nothing to subscribe to. `frameworkInstrumentation` uses React Router's `navigate` instrumentation instead, which wraps each call to the router's `navigate` and, from React Router 8.1, reports the matched pattern. On 7.15 to 8.0, navigation spans keep the plain name `navigate`.

With server rendering, the loaders for the first page already ran on the server, so the `pageload` span ends once the page hydrates. Call `useMaplePageload()` in the root route's `Layout`, not in `App`: `Layout` also wraps the root `ErrorBoundary`, so 404 and error pages end the span too:

```tsx
// app/root.tsx
import { useMaplePageload } from "@maple-dev/browser/react-router"

export function Layout({ children }: { children: React.ReactNode }) {
	useMaplePageload()
	// ...the rest of the generated Layout, unchanged
}
```

React Router mounts `Layout` more than once, around the page, the `ErrorBoundary` and the `HydrateFallback`, and `useMaplePageload` only ends the page load the first time.

Framework mode's client side has gaps that data mode doesn't:

- **Back and forward buttons aren't traced.** They go through the browser's history, not `navigate`, so there's no navigation span and their loaders start their own traces. Pressing back while a click is still loading ends that click's span as interrupted.
- **A click while another is loading** ends the first span as interrupted, instead of merging the two.
- **Server loader requests are separate traces.** React Router fetches server loader data in one `.data` request per navigation, and starts it after an `await`. That's the [`await` problem](#the-await-problem) inside React Router itself: the request and the server spans behind it land in their own trace. The loader span under your navigation still shows how long the browser waited.
- **Redirected navigations are named after the route that was clicked**, not the one the user landed on.
- **Client loaders that run on hydration are usually their own trace.** A route with only a `clientLoader`, or with `clientLoader.hydrate`, loads its data after the page hydrates, which is after the `pageload` span ended.
- **A URL that matches no route is named after the root route**, `navigate /` or `pageload /`. The server span's 404 `http.response.status_code` tells it apart from the home page.
- **Every route gets a `loader` span**, even routes without a loader, because React Router loads the route's module and styles through it. Those spans show the time spent downloading code.
- **Relative links and `basename`.** For a relative `to`, like `edit`, `url.path` is resolved against the URL rather than the route, so it can differ from where React Router goes; the span name is right. With a `basename`, the page load's `url.path` includes it and navigations' don't.

### Trace the server render and link it to the pageload

Start the OpenTelemetry Node SDK as in the [Node.js guide](/docs/guides/instrumentation-nodejs), loaded before the server build with Node's `--import` flag:

```json
"start": "NODE_OPTIONS='--import ./instrumentation.server.mjs' react-router-serve ./build/server/index.js"
```

That gives you a span for every incoming request and for the database and HTTP calls your loaders make. The HTTP server span also reads the `traceparent` header, so a `.data` request's server spans join the browser request that made it.

The server entry takes its own `instrumentations` and `handleError` exports. Add both to the `app/entry.server.tsx` that `react-router reveal` generates, and hand the trace to the browser at the top of `handleRequest`, which renders the page:

```tsx
// app/entry.server.tsx
import { serverInstrumentation } from "@maple-dev/browser/react-router/server"
import { serverTiming } from "@maple-dev/browser/server"
import type { EntryContext, RouterContextProvider } from "react-router"

export { handleError } from "@maple-dev/browser/react-router/server"
export const instrumentations = [serverInstrumentation]

export default function handleRequest(
	request: Request,
	responseStatusCode: number,
	responseHeaders: Headers,
	routerContext: EntryContext,
	loadContext: RouterContextProvider,
) {
	// Hand this trace to the browser so its pageload span can join it
	const timing = serverTiming()
	if (timing) responseHeaders.append("server-timing", timing)

	// ...the rest of the generated handleRequest, unchanged
```

- **`serverInstrumentation`** opens a span per request, named after the matched pattern, like `GET /projects/:projectId`, with the status code, and a span for every server loader and action under it. It's marked as an error for a 5xx response only. From React Router 8.1; on earlier versions the request span keeps the plain method name.
- **`handleError`** logs like React Router's default, because defining `handleError` replaces that logging. It records render errors, which reach no loader span, on the request span, and skips aborted requests, thrown responses like the 404 React Router reports for a URL that matches no route, and errors a loader span already recorded. If you have your own `handleError`, call it from there instead of logging.
- **`serverTiming()`** returns the `Server-Timing` value for the active span. `handleRequest` runs inside the request span, so the browser's `pageload` span joins it, and the first page load is one trace from the request arriving to the page hydrating.

Some things to know about the server side:

- **The request span nests under the Node SDK's HTTP span**, which only knows the URL. The React Router span adds the route pattern and the loader spans.
- **It ends when the response starts streaming**, because the default entry resolves the response once React's shell is ready. It measures time to first byte, not the full stream.
- **A server loader error is recorded once, on the server.** In production, the error reaches the browser as `Unexpected Server Error`, without its message, and `reportRouteError` skips it. In development the browser gets the real message, so the error is recorded on both sides.
- **Only page responses carry the header.** `.data` requests and static assets don't go through `handleRequest`.
- **Cached HTML shares one trace.** If a CDN caches your pages, skip the `server-timing` header on those responses.

## React Router tracing gotchas

- **Hash routers.** Data mode starts the page load from `window.location.pathname`, so with `createHashRouter` the page load's `url.path` is `/`.
- **Older versions use `unstable_` names.** `instrumentations` was `unstable_instrumentations` before 7.15. On those versions, wrap loaders with `MapleBrowser.traced` by hand.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does React Router have built-in OpenTelemetry support?

Not directly. Since 7.15 it has a stable, vendor-neutral instrumentation API with hooks around navigations, fetcher calls, loaders, actions, middleware, and server requests. It doesn't create spans or export anything, so you plug a tracer in, which is what `@maple-dev/browser/react-router` does.

### Why are my React Router loader spans not connected to the navigation?

Usually one of three things: the loader ran for a fetcher, so there was no navigation; you're in framework mode and the user pressed back or forward; or the loader made its request after an `await`. Start requests before the first `await`, for example with `Promise.all`.

### Does navigation tracing work with `<BrowserRouter>`?

Only partly. Declarative mode has no loaders and no navigation state, so you can record that a route rendered, but not how long the navigation took. `createBrowserRouter` with `createRoutesFromElements` keeps your route components and gives you everything in this guide.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
