# TanStack Router and TanStack Start

Written against `@tanstack/react-router` 1.170 and `@tanstack/react-start` 1.168. Human version: https://maple.dev/docs/frontend/tanstack

## Init

Client-only TanStack Router: import a `maple.ts` that calls `MapleBrowser.init` as the first import of the client entry (`src/main.tsx`). TanStack Start: the scaffold has no client entry, so make `import "../maple"` the first import of `src/routes/__root.tsx` (or import it first in `src/client.tsx` if the app has one); `init()` is a no-op during SSR.

## Navigations

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

// redirect() and notFound() are thrown, but they aren't failures
export const loaderSpan = <T>(name: string, fn: () => Promise<T>) =>
	traced(name, fn, (error) => !isRedirect(error) && !isNotFound(error))
```

Call `traceRouter` right after the router is created. TanStack Start's `src/router.tsx` exports `getRouter()`, which also runs on the server for every request (the `window` guard handles that). A client-only app that exports `const router = createRouter(...)` calls `traceRouter(router)` after it.

```ts
// src/router.tsx
export function getRouter() {
	const router = createRouter({ routeTree /* , ...existing options */ })
	traceRouter(router)
	return router
}
```

- Template: `match.fullPath` (`/projects/$projectId`). Not `routeId`, which includes pathless layouts and groups. A URL no route matches is named `not-found`, not `/`.
- Server-rendered first load: `pageload <template>`, a child of the `ssr` span. Hydration emits no `onBeforeNavigate` or `onResolved`, only `onRendered`, hence the `startNavigation` call up front. In a client-only app, the first `router.load()` emits `onBeforeNavigate` without `fromLocation`; that one is skipped for the same reason.
- Redirects (`redirect()` in `beforeLoad` or a loader) emit a second `onBeforeNavigate` that replaces the history entry. The `__TSR_index` check keeps one span, named after the final route, with the original `url.path`.
- Search-only changes (`?tab=members`) are navigations: `navigate <same template>`, with a loader span only if the route's `loaderDeps` read the search. Hash links make no span. Back/forward are navigations.
- A second click while loading ends the first span as interrupted (generic name `navigate`); its loader span still ends when the loader settles.

## Loaders

Wrap each route's `loader` (and `beforeLoad` if it does I/O or can throw):

```ts
export const Route = createFileRoute("/projects/$projectId")({
	loader: ({ params }) =>
		loaderSpan("loader /projects/$projectId", () =>
			Promise.all([fetchProject(params.projectId), fetchMembers(params.projectId)]),
		),
})
```

- Nested route loaders run in parallel and show up as sibling spans.
- Preloads (`preload="intent"`, `defaultPreload`) run loaders with no navigation in progress; those spans become their own traces. That's expected. A click on a preloaded route renders the cached data and reloads it in the background, so the `navigate` span can end before its loader span.
- `throw notFound()` after an API 404 isn't an error: the loader span stays Ok. The 404 `fetch` span itself is marked Error by the SDK, like any 4xx client span.
- If the app uses TanStack Query inside loaders (`queryClient.ensureQueryData`), wrap the loader, not the query functions.

## Caught errors

Every route has an error boundary. Report from the router option `defaultOnCatch` (a route's own `onCatch` overrides it for that route), inside `getRouter()`:

```ts
// src/router.tsx
import { MapleBrowser } from "@maple-dev/browser"
import { alreadyRecorded } from "./tracing"

const router = createRouter({
	routeTree,
	defaultOnCatch: (error) => {
		// Loader errors are already on their loader span, in the browser or, for the first page load, on the server
		if (alreadyRecorded(error) || router.state.matches.some((match) => match.error === error)) return
		MapleBrowser.captureException(error, { name: "react.render_error" })
	},
})
```

- The `matches` check covers a loader that failed during SSR: the browser receives a copy of the error, which `alreadyRecorded` can't match. It also skips `beforeLoad` errors, hence wrapping any `beforeLoad` that can throw.
- Render errors are reported once, as a `react.render_error` span in its own trace.
- If `defaultOnCatch` is already set, add the check and the call inside it.

## SSR (TanStack Start)

Server OTel: Node SDK per `maple-nodejs-style` in `src/instrumentation.ts`, imported first in `src/server.ts` (skip that import if the server process already loads it with `node --import`). On Cloudflare Workers or another runtime, follow that runtime's Maple guide instead. The scaffold has no `src/server.ts`; creating one replaces the default server entry:

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

- If `src/server.ts` already exists, keep its handler (custom stream handler, context) and wrap it the same way.
- Server loaders run before the handler callback. Without the request span each request's loaders are a separate trace, and an SDK imported inside the server bundle starts too late for HTTP server auto-instrumentation (`vite preview`, the scaffold's production server, is already listening). The span is renamed `ssr <template>` once the route is known; requests that don't render (server functions, redirects) keep the method as their name.
- The span ends when streaming starts (time to first byte), not when the stream finishes.
- `loaderSpan` works on the server unchanged, and Node's `AsyncLocalStorage` keeps parents across `await` there. Server `fetch` calls need the undici instrumentation (part of `getNodeAutoInstrumentations()`, or `@opentelemetry/instrumentation-undici`).
- Only rendered HTML gets `server-timing`; redirects and static assets don't. Start sets no `ETag` on HTML.

## Check

With the production build (`vite build`, then the app's start command or `vite preview`), in addition to `SKILL.md` Step 7:

- Full page load: one `pageload <template>` span whose parent is the `ssr <template>` span, with the server `loader` spans in the same trace. A reload gets a new trace id.
- Click to a route with a loader: one `navigate <template>` span, `loader <template>` under it, `fetch` spans under the loader.
- A loader that throws, loaded directly and by a click: one `exception` event each time.
