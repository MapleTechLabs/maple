# React Router (v7.15+, v8)

Tested with react-router 8.5.1 (data mode also 7.18.5) and `@maple-dev/browser` 0.14.0. Human version: https://maple.dev/docs/frontend/react-router

The SDK has no React Router entry. Use the core `MapleBrowser` calls plus `instrumentReactRouter` from `@maple-dev/browser/react`, wired through React Router's own `instrumentations` and `onError` APIs. Never import `@maple-dev/browser/react-router` or `@maple-dev/browser/server`: they don't exist.

Version check: needs 7.15+ (stable `instrumentations`, `ClientInstrumentation` type, `onError` with `pattern`). Below 7.15: tell the user to upgrade. v6 / `react-router-dom` apps: upgrade first. Imports come from `react-router` (`RouterProvider` / `HydratedRouter` from `react-router/dom`).

Pick the mode:

- **Data mode**: `createBrowserRouter` + `RouterProvider`.
- **Framework mode**: `@react-router/dev` Vite plugin, `app/root.tsx`, `HydratedRouter`, usually with SSR.
- **Declarative** (`<BrowserRouter>`): no loaders, no navigation state. Suggest `createBrowserRouter` + `createRoutesFromElements`; don't hand-roll navigation spans.

## Shared: `maple.ts`

`src/maple.ts` (data) or `app/maple.ts` (framework), imported first by the client entry (`src/main.tsx` / `app/entry.client.tsx`). Add the `init` call from `SKILL.md`, then these two exports:

```ts
import { MapleBrowser } from "@maple-dev/browser"
import {
	type ClientInstrumentation,
	type ClientOnErrorFunction,
	type InstrumentationHandlerResult,
	isRouteErrorResponse,
} from "react-router"

// A span for every loader and action, under the open navigation
export const mapleInstrumentation: ClientInstrumentation = {
	route(route) {
		route.instrument({
			loader: (callLoader) => traceHandler(`loader ${route.id}`, callLoader),
			action: (callAction) => traceHandler(`action ${route.id}`, callAction),
		})
	},
}

async function traceHandler(name: string, call: () => Promise<InstrumentationHandlerResult>) {
	// The first page's loaders start inside createBrowserRouter, before instrumentReactRouter
	// opens the page load: wait one tick so they nest under it
	await Promise.resolve()
	return MapleBrowser.traced(name, async () => {
		const result = await call()
		// A navigation that was superseded aborts its loaders: not a failure
		if (result.status === "error" && result.error.name !== "AbortError") throw result.error
	}).catch(() => {}) // recorded on the span; React Router still handles the error
}

// Errors React Router catches for your ErrorBoundary
export const reportRouteError: ClientOnErrorFunction = (error, { pattern }) => {
	if (isRouteErrorResponse(error)) return // thrown responses: 404s, redirects
	MapleBrowser.captureException(error, { name: "react_router.error", attributes: { "app.route": pattern } })
}
```

- Keep the `await Promise.resolve()`: without it, data mode's first-page loaders are their own trace.
- Keep the `.catch(() => {})`: React Router `console.error`s an instrumentation that rejects.
- Existing `instrumentations`: append `mapleInstrumentation`. Existing `onError`: call `reportRouteError(error, info)` from it.
- Only requests a loader starts before its first `await` nest under its span. Rewrite sequential independent fetches to `Promise.all`; don't touch dependent ones.

## Data mode

```tsx
// where the router is created
export const router = createBrowserRouter(routes, { instrumentations: [mapleInstrumentation] })
```

```tsx
// src/main.tsx
import "./maple" // first
import { instrumentReactRouter } from "@maple-dev/browser/react"
import { reportRouteError } from "./maple"

instrumentReactRouter(router) // after init (the import above), before render

<RouterProvider router={router} onError={reportRouteError} />
```

- Loader spans are `loader <route.id>`; ids default to positions (`0-1`). Give routes with loaders a readable `id`.

## Framework mode

Run `npx react-router reveal` if `app/entry.client.tsx` / `app/entry.server.tsx` don't exist.

```tsx
// app/entry.client.tsx
import "./maple" // first
import { mapleInstrumentation, reportRouteError } from "./maple"

// in the existing hydrateRoot(...) call
<HydratedRouter instrumentations={[mapleInstrumentation]} onError={reportRouteError} />
```

```tsx
// app/root.tsx: in Layout, not App (Layout also wraps the root ErrorBoundary)
import { instrumentReactRouter } from "@maple-dev/browser/react"
import { useContext, useEffect } from "react"
import { UNSAFE_DataRouterContext } from "react-router"

export function Layout({ children }: { children: React.ReactNode }) {
	// HydratedRouter creates the router itself; this is the only way to reach it
	const router = useContext(UNSAFE_DataRouterContext)?.router
	useEffect(() => (router ? instrumentReactRouter(router) : undefined), [router])
	// ...the existing <html> document, unchanged
}
```

- Don't attach from `entry.client.tsx`: the router doesn't exist until `HydratedRouter` renders. Don't use `window.__reactRouterDataRouter`.
- Tell the user `UNSAFE_DataRouterContext` is React Router internal API; recheck after upgrades.
- Add to `app/maple.ts`'s `init`: `errors: { ignore: ["Unexpected Server Error"] }` (production sends server loader errors to the browser as that placeholder; the server records the real one).

Server (only if the app server-renders). Install `@opentelemetry/api`. Start the Node SDK per the backend instrumentation (`maple-onboard` / the Node.js guide) with `--import`, e.g. `"start": "NODE_OPTIONS='--import ./instrumentation.server.mjs' react-router-serve ./build/server/index.js"`. It must include the HTTP server instrumentation. In `app/entry.server.tsx`:

```tsx
import { context, propagation, trace } from "@opentelemetry/api"
import { type HandleErrorFunction, isRouteErrorResponse } from "react-router"

// Record loader, action and render errors on the request's span
export const handleError: HandleErrorFunction = (error, { request }) => {
	if (request.signal.aborted || isRouteErrorResponse(error)) return
	trace.getActiveSpan()?.recordException(error instanceof Error ? error : String(error))
	console.error(error)
}

// first lines of the generated default handleRequest:
const carrier: { traceparent?: string } = {}
propagation.inject(context.active(), carrier)
if (carrier.traceparent) responseHeaders.append("Server-Timing", `traceparent;desc="${carrier.traceparent}"`)
```

- Existing `handleError`: add the `recordException` line to it instead.
- CDN-cached HTML: skip the header on cached responses.

Known gaps (tell the user):

- A loader redirect, or a click while a navigation is loading, ends the first span unnamed (`navigate`, `maple.navigation.interrupted`) and starts a new trace. In data mode, a click to a route **without** a loader during a pending navigation is merged into the pending span instead (named after the new route, `url.path` of the old one).
- Framework mode: the `.data` request for server loaders (and the server spans behind it) is its own trace on client navigations; every route gets a `loader` span (module loading), even without a loader.
- Framework mode, development only: a server loader error is recorded on both sides.
- Search-only changes and revalidations start no navigation span; their loader spans are their own trace.

## Check

Run the app, click through, then inspect the spans (Maple **Traces**, or a local OTLP sink via `endpoint`):

- Click to a route with a loader: `navigate /projects/:projectId` > `loader <id>` > `GET` fetch spans > API server spans, one trace id.
- Data-mode page load: `pageload /projects/:projectId` with the loader span under it.
- Framework-mode page load: `curl -sD - -o /dev/null <url>` shows `server-timing: traceparent;desc="00-…"`; `.data` URLs don't. In Maple the `pageload` span's parent is the server's HTTP span.
- A loader that throws an `Error`: exactly one `exception` event, on its loader span (framework server loader: on the server's span). A render error: one `react_router.error` span. A thrown 404 `Response`: none.
- Clicking a link during a slow navigation: no span marked failed with an `AbortError`.
