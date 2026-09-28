# TanStack Router and TanStack Start

Written against `@tanstack/react-router` 1.170 and `@tanstack/react-start` 1.168. Human version: https://maple.dev/docs/frontend/tanstack

## Init

Client-only TanStack Router: import a `maple.ts` that calls `MapleBrowser.init` as the first import of the client entry (`src/main.tsx`). TanStack Start: call it from the client entry (`src/client.tsx` if the app has one), or from a module imported by the root route; `init()` is a no-op during SSR.

## Navigations

Wire the helper to router events right after `createRouter`:

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

// redirect() and notFound() are thrown, but they aren't failures
export const loaderSpan = <T>(name: string, fn: () => Promise<T>) =>
	traced(name, fn, (error) => !isRedirect(error) && !isNotFound(error))
```

```ts
// src/router.tsx
export const router = createRouter({ routeTree /* , ...existing options */ })
traceRouter(router)
```

- Template: `match.fullPath` (`/projects/$projectId`). Not `routeId`, which includes pathless layouts and groups.
- Superseded navigations never emit `onResolved`; `startNavigation` ends the previous span.
- A loader `redirect()` doesn't emit a new `onBeforeNavigate`; the one span ends named after the final route.
- `onBeforeNavigate` also fires during SSR, hence the `window` guard.

## Loaders

Wrap each route's `loader` (and `beforeLoad` if it does I/O):

```ts
export const Route = createFileRoute("/projects/$projectId")({
	loader: ({ params }) =>
		loaderSpan("loader /projects/$projectId", () =>
			Promise.all([fetchProject(params.projectId), fetchMembers(params.projectId)]),
		),
})
```

- Nested route loaders run in parallel and show up as sibling spans.
- Preloads (`preload="intent"`, `defaultPreload`) run loaders with no navigation in progress; those spans become their own traces. That's expected.
- If the app uses TanStack Query inside loaders (`queryClient.ensureQueryData`), wrap the loader, not the query functions.

## Caught errors

Every route has an error boundary. Report from the router option `defaultOnCatch` (a route's own `onCatch` overrides it for that route):

```ts
export const router = createRouter({
	routeTree,
	defaultOnCatch: (error) => {
		// Loader errors are already on their loader span
		if (!alreadyRecorded(error)) MapleBrowser.captureException(error, { name: "react.render_error" })
	},
})
```

If `defaultOnCatch` is already set, add the call inside it.

## SSR (TanStack Start)

Server OTel: Node SDK per `maple-nodejs-style`, imported first in `src/server.ts`. On Cloudflare Workers or another runtime, follow that runtime's Maple guide instead. Then wrap the handler callback:

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

- If `src/server.ts` already exists, keep its handler (custom stream handler, context) and wrap it the same way.
- The `ssr` span starts after server loaders ran; loaders are its siblings under the request span.
- The span ends when streaming starts (time to first byte), not when the stream finishes.
- `loaderSpan` works on the server unchanged, and Node's `AsyncLocalStorage` keeps parents across `await` there.
