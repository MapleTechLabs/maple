---
title: "Frontend tracing for React Router"
description: "Trace React Router navigations, loaders and actions as OpenTelemetry traces linked to your backend, report route errors, and join framework mode's server render to the browser page load."
group: "Frontend"
order: 2
navLabel: "React Router"
icon: "reactrouter"
---

This page connects a React Router app to Maple with `@maple-dev/browser`: one span per navigation, named after the route pattern, a span per loader and action with their `fetch` calls under them, and the backend spans behind those, all in one trace. In framework mode, the browser's page load also joins the trace of the server render.

It covers data mode (`createBrowserRouter`) and framework mode (`HydratedRouter`, with server rendering). It needs React Router 7.15 or later, the first version with the stable `instrumentations` API, and was tested with React Router 8.5.1 and `@maple-dev/browser` 0.14.0.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses React Router.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install and initialize

```bash
npm install @maple-dev/browser
```

Create `src/maple.ts` (`app/maple.ts` in framework mode):

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"
import {
	type ClientInstrumentation,
	type ClientOnErrorFunction,
	type InstrumentationHandlerResult,
	isRouteErrorResponse,
} from "react-router"

MapleBrowser.init({
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	environment: import.meta.env.MODE,
	tracing: {
		// APIs on another origin that should receive `traceparent`
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

Import it first in your client entry: `src/main.tsx` in data mode, `app/entry.client.tsx` in framework mode. The next sections add two exports to this file.

`init()` instruments `fetch` and `XMLHttpRequest`, records uncaught errors, and starts session replay. Use the public ingest key (`maple_pk_…`); for an EU organization add `region: "eu"`. Every option is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

## Connect browser traces to your API

Requests to the page's own origin carry a W3C `traceparent` header, so your backend's span joins the browser's trace. For an API on another origin, list it in `propagateTraceHeaderCorsUrls` as above, and allow the header in the API's CORS preflight response, or the browser blocks the request:

```http
Access-Control-Allow-Headers: content-type, authorization, traceparent
```

List only your own APIs; third parties get your trace ids and often reject the preflight. The backend needs OpenTelemetry to read the header: see [Instrument your application](/docs/instrumentation).

## Trace loaders and actions

React Router's `instrumentations` API wraps every loader and action in one place. Add this to `src/maple.ts` to run each one in a `MapleBrowser.traced` span under the current navigation:

```ts
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
```

Spans are named after the route id: `loader project`. In data mode, ids default to the route's position (`0-1`), so give routes with loaders an `id`. In framework mode, the id is the route file (`loader routes/project`).

- **Only a thrown `Error` fails the span.** A thrown `redirect()`, `data()` or `Response` is a success, which is right for redirects and 404s; throw an `Error` for real failures.
- **Only requests a loader starts before its first `await` nest under its span**, because the browser has no async context. Start independent requests together with `Promise.all`.

## Trace navigations

`instrumentReactRouter` from `@maple-dev/browser/react` subscribes to the router: a navigation span starts when the router starts loading and ends when its loaders finish. Don't call `MapleBrowser.startNavigation` or `endNavigation` yourself alongside it.

**Data mode:** pass the instrumentation to `createBrowserRouter`, and call `instrumentReactRouter` right after creating the router:

```tsx
// src/router.tsx
import { createBrowserRouter } from "react-router"
import { fetchMembers, fetchProject, ProjectPage, RootLayout } from "./app"
import { mapleInstrumentation } from "./maple"

export const router = createBrowserRouter(
	[
		{
			path: "/",
			Component: RootLayout,
			children: [
				{
					// Loader spans are named after the route id, so give routes with loaders a readable one
					id: "project",
					path: "projects/:projectId",
					loader: ({ params }) => Promise.all([fetchProject(params.projectId!), fetchMembers(params.projectId!)]),
					Component: ProjectPage,
				},
			],
		},
	],
	{ instrumentations: [mapleInstrumentation] },
)
```

```tsx
// src/main.tsx
import "./maple" // first, before anything renders
import { instrumentReactRouter } from "@maple-dev/browser/react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router/dom"
import { reportRouteError } from "./maple"
import { router } from "./router"

instrumentReactRouter(router)

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} onError={reportRouteError} />)
```

`reportRouteError` is defined in [Report route errors](#report-route-errors).

**Framework mode:** `HydratedRouter` creates the router itself and only exposes it through React Router's internal `UNSAFE_DataRouterContext`. Attach from the root route's `Layout`, which also wraps the root `ErrorBoundary`, so error and 404 pages end the page load too:

```tsx
// app/root.tsx
import { instrumentReactRouter } from "@maple-dev/browser/react"
import { useContext, useEffect } from "react"
import { UNSAFE_DataRouterContext } from "react-router"

export function Layout({ children }: { children: React.ReactNode }) {
	// HydratedRouter creates the router itself; this is the only way to reach it
	const router = useContext(UNSAFE_DataRouterContext)?.router
	useEffect(() => (router ? instrumentReactRouter(router) : undefined), [router])

	// ...the rest of the generated Layout, unchanged
}
```

The `UNSAFE_` prefix means React Router may change it in a minor release; recheck this after upgrading.

What you get:

- **Span names use the route pattern**: `pageload /projects/:projectId` for the first route, `navigate /projects/:projectId` after it. The concrete path is the `url.path` attribute.
- **Back and forward buttons** start a navigation span like a click.
- **Search-only changes and revalidations** start no span; the loaders they rerun start their own trace.
- **A redirect from a loader** ends the first span unnamed (`navigate`, with the original `url.path`) and `maple.navigation.interrupted: true`, then starts a `navigate` span for the target route in a new trace. A click while another navigation is still loading ends that one the same way; in data mode, only if the new route has a loader.
- **A URL that matches no route** only matches the root route, so its span is `navigate /`; `url.path` keeps the requested URL.
- **In framework mode, every route gets a `loader` span** on client navigations, including the root and routes without a loader, because React Router loads the route module through it.

## Report route errors

React Router catches loader, action and render errors to show your `ErrorBoundary`, so they never reach the SDK's global handlers. Add this to `src/maple.ts` and pass it as `onError` to `RouterProvider` (data mode) or `HydratedRouter` (framework mode):

```ts
// Errors React Router catches for your ErrorBoundary
export const reportRouteError: ClientOnErrorFunction = (error, { pattern }) => {
	if (isRouteErrorResponse(error)) return // thrown responses: 404s, redirects
	MapleBrowser.captureException(error, { name: "react_router.error", attributes: { "app.route": pattern } })
}
```

A loader or action error is recorded once, on its loader span: `captureException` skips an error `traced` already recorded. A render error becomes one `react_router.error` span. For errors outside the router, see `MapleErrorBoundary` in the [Browser SDK reference](/docs/session-replay/browser-sdk#react).

## Framework mode: client entry and server rendering

Run `npx react-router reveal` if `app/entry.client.tsx` and `app/entry.server.tsx` don't exist yet. Pass the instrumentation and the error handler to `HydratedRouter`:

```tsx
// app/entry.client.tsx
import "./maple" // first, before anything renders
import { startTransition, StrictMode } from "react"
import { hydrateRoot } from "react-dom/client"
import { HydratedRouter } from "react-router/dom"
import { mapleInstrumentation, reportRouteError } from "./maple"

startTransition(() => {
	hydrateRoot(
		document,
		<StrictMode>
			<HydratedRouter instrumentations={[mapleInstrumentation]} onError={reportRouteError} />
		</StrictMode>,
	)
})
```

The page load joins the server render's trace when the HTML response carries a `Server-Timing: traceparent;desc="…"` entry. The SDK has no server helper: start the OpenTelemetry Node SDK as in the [Node.js guide](/docs/guides/instrumentation-nodejs), loaded before the server build:

```json
"start": "NODE_OPTIONS='--import ./instrumentation.server.mjs' react-router-serve ./build/server/index.js"
```

Its HTTP server span is active while React Router renders the page. In `app/entry.server.tsx`, write that span's trace context into the header at the top of `handleRequest`, and record server errors on it with a `handleError` export:

```tsx
// app/entry.server.tsx
import { context, propagation, trace } from "@opentelemetry/api"
import { type HandleErrorFunction, isRouteErrorResponse } from "react-router"

// Record loader, action and render errors on the request's span
export const handleError: HandleErrorFunction = (error, { request }) => {
	if (request.signal.aborted || isRouteErrorResponse(error)) return
	trace.getActiveSpan()?.recordException(error instanceof Error ? error : String(error))
	console.error(error)
}

export default function handleRequest(
	request: Request,
	responseStatusCode: number,
	responseHeaders: Headers,
	routerContext: EntryContext,
	loadContext: RouterContextProvider,
) {
	// Hand this request's trace to the browser, so its page load joins it
	const carrier: { traceparent?: string } = {}
	propagation.inject(context.active(), carrier)
	if (carrier.traceparent) responseHeaders.append("Server-Timing", `traceparent;desc="${carrier.traceparent}"`)

	// ...the rest of the generated handleRequest, unchanged
```

Install `@opentelemetry/api` in the app for these imports. Defining `handleError` replaces React Router's default logging, hence the `console.error`.

In production, React Router sends a server loader's error to the browser as `Unexpected Server Error`, without the message, and the loader span would record it a second time. Drop it in the browser, since `handleError` already recorded the real error on the server:

```ts
// app/maple.ts, in MapleBrowser.init({ ... })
errors: { ignore: ["Unexpected Server Error"] },
```

In development the real message reaches the browser, so the error is recorded on both sides.

What you get:

- **The first page load is one trace:** the server's HTTP span, with `pageload /projects/:projectId` under it. The page load ends when the page hydrates, or, for a route whose `clientLoader` runs on hydration, when that loader finishes, with the loader span and its `fetch` spans under it.
- **Errors during the server render** (a server loader or a component, on the first page load) are recorded on the server's HTTP span only.
- **Server loader data is a separate trace on client navigations.** React Router fetches it in one `.data` request per navigation, started after an internal `await`, so the request and the server spans behind it are not under the navigation span. The loader spans under the navigation still show how long the browser waited.
- **Only page responses carry the header.** `.data` requests and static assets don't go through `handleRequest`. If a CDN caches your HTML, skip the header on those responses, or every visitor's page load joins the same trace.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): sampling, consent, masking and URL redaction.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
