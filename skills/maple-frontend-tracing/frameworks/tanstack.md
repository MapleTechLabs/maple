# TanStack Router and TanStack Start

Written against `@tanstack/react-router` 1.170, `@tanstack/react-start` 1.168, `@maple-dev/browser` 0.10.0. Human version: https://maple.dev/docs/frontend/tanstack

Install `@maple-dev/browser` (0.10.0+). Entries: `@maple-dev/browser/tanstack` (router, loaders, errors; isomorphic) and `@maple-dev/browser/tanstack/server` (Start server entry).

## Init

`MapleBrowser.init` must run before the router is created. Client-only TanStack Router: import a `maple.ts` that calls it as the first import of the client entry (`src/main.tsx`). TanStack Start: the scaffold has no client entry, so make `import "../maple"` the first import of `src/routes/__root.tsx` (or import it first in `src/client.tsx` if the app has one); `init()` is a no-op during SSR.

## Router: navigations and caught errors

Where the router is created (Start: `getRouter()` in `src/router.tsx`, which also runs on the server; client-only: right after `const router = createRouter(...)`):

```ts
// src/router.tsx
import { reportRouterError, traceRouter } from "@maple-dev/browser/tanstack"
import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
	const router = createRouter({
		routeTree,
		// ...existing options
		defaultOnCatch: (error) => reportRouterError(router, error),
	})
	traceRouter(router)
	return router
}
```

- If `defaultOnCatch` already exists, call `reportRouterError(router, error)` inside it. A route's own `onCatch` replaces `defaultOnCatch` for that route: add the call there too.
- `traceRouter` is a no-op on the server. It opens the `pageload` span immediately and ends it when the first route renders (covers Start hydration).
- Names: route `fullPath` (`navigate /projects/$projectId`), without pathless layouts/groups. Unmatched URL, including one a layout matches but no child does: `not-found`. The deprecated `notFoundRoute` option names them after that route instead.
- Redirects (`redirect()` in `beforeLoad`/loader, also during the first load) stay in the originating span: final route's name, original `url.path`.
- A click while loading ends the first span as interrupted (generic `navigate`). A click before a client-only app's first route resolves ends the page load as interrupted.
- Search changes and back/forward are navigations. Hash links, `router.invalidate()` and a link to the route on screen start no span, and end a navigation in flight as interrupted.
- `reportRouterError` reports render errors once as `react.render_error`. It skips any error stored as a route match's `error` (loader and `beforeLoad` errors, including the copies SSR hands the browser), so an unwrapped loader/`beforeLoad` error is not reported at all: wrap them (below).
- `defaultOnCatch` only runs for routes with an `errorComponent` or with `defaultErrorComponent` set; errors reaching the router's global boundary aren't reported. Tell the user if the app has neither.

Known limit: redirect merging uses `location.state.__TSR_index` (undocumented TanStack history field); a `replace` navigation started while another is loading is merged into that span like a redirect.

## Loaders

Wrap each route's `loader`, and any `beforeLoad` that does I/O or can throw:

```ts
import { tracedLoader } from "@maple-dev/browser/tanstack"

export const Route = createFileRoute("/projects/$projectId")({
	loader: ({ params }) =>
		tracedLoader("loader /projects/$projectId", () =>
			Promise.all([fetchProject(params.projectId), fetchMembers(params.projectId)]),
		),
})
```

- `redirect()` and `notFound()` aren't failures. Isomorphic: on the server it spans under the request (Node keeps parents across `await`).
- Nested route loaders run in parallel: sibling spans.
- Preloads (`preload="intent"`, `defaultPreload`) run loaders with no navigation: their spans are their own traces. A click on a preloaded route renders cached data and reloads in the background, so `navigate` can end before its loader span.
- `throw notFound()` after an API 404: loader span Ok; the 404 `fetch` span is Error, like any 4xx client span.
- TanStack Query inside loaders (`queryClient.ensureQueryData`): wrap the loader, not the query functions.

## SSR (TanStack Start)

Server OTel: Node SDK per `maple-nodejs-style` in `src/instrumentation.ts`, imported first in `src/server.ts` (skip that import if the server process already loads it with `node --import`). Server `fetch` spans need the undici instrumentation (in `getNodeAutoInstrumentations()`, or `@opentelemetry/instrumentation-undici`). The scaffold has no `src/server.ts`; creating one replaces the default server entry:

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

- Existing `src/server.ts`: wrap its `fetch` with `traceRequests` and its handler callback (custom stream handler) with `traceRender`.
- `traceRequests`: one span per request (loaders run before the handler callback, so this is what puts them in the render's trace). Method, `url.path`, `http.response.status_code`, Error on 5xx only. Joins an incoming `traceparent` (server functions nest under the browser's `fetch`). Inside an HTTP-instrumentation span it becomes an `INTERNAL` child, never a second server span.
- `traceRender`: renames the span `ssr <fullPath>` and appends `Server-Timing` for the `pageload` span. Requests that don't render (server functions, redirects) keep the method name and get no header.
- The span ends at the first byte (streaming start); deferred data resolved while streaming falls outside it.
- Server `url.path` is the raw path; browser `sanitizeUrl` doesn't apply.
- Start sets no `ETag` on HTML. If a CDN caches HTML, strip `server-timing` from cached responses.

## Check

With the production build (`vite build`, then the app's start command or `vite preview`), in addition to `SKILL.md` Step 7:

- Full page load: one `pageload <template>` span whose parent is the `ssr <template>` span, with the server `loader` spans in the same trace. A reload gets a new trace id. `server-timing` only on HTML, not on assets or redirects.
- Click to a route with a loader: one `navigate <template>` span, `loader <template>` under it, `fetch` spans under the loader.
- A loader that throws, loaded directly and by a click: one `exception` event each time (on the loader span, server or browser).
- `/does-not-exist`: `pageload not-found` under `ssr not-found`.
