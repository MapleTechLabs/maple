# React Router (v7 and v8)

Written against react-router 8.4 (APIs stable since 7.15). Human version: https://maple.dev/docs/frontend/react-router

Version check: `instrumentations` was `unstable_instrumentations` from 7.9.5 to 7.15; `onError` was `unstable_onError` before 7.11. Below 7.9.5, wrap loaders with `traced` by hand. Imports come from `react-router` (and `react-router/dom` for `RouterProvider` / `HydratedRouter`); v6 apps using `react-router-dom` should be told the instrumentation API needs an upgrade.

Pick the mode:

- **Data mode** (`createBrowserRouter` + `RouterProvider`): full setup below.
- **Framework mode** (`@react-router/dev` Vite plugin, `app/entry.client.tsx`): same instrumentation, `navigate` hook instead of subscribe, plus SSR.

Files: `maple.ts` (the `MapleBrowser.init` call), `tracing.ts` (copied verbatim) and `router-tracing.ts` go in `src/` in data mode and in `app/` in framework mode.
- **Declarative mode** (`<BrowserRouter>`): no loaders, no navigation state. Don't migrate the app yourself; say in the hand-off that `createBrowserRouter` + `createRoutesFromElements` enables navigation spans. Steps 1 to 3 and 5 of `SKILL.md` still apply.

## Shared: `router-tracing.ts`

```ts
import { MapleBrowser } from "@maple-dev/browser"
import {
	type ClientInstrumentation,
	type ClientOnErrorFunction,
	type DataRouteMatch,
	type DataRouter,
	type InstrumentationHandlerResult,
	type InstrumentRouteFunction,
	isRouteErrorResponse,
} from "react-router"
import { alreadyRecorded, endNavigation, startNavigation, traced } from "./tracing"

/** Adds the leading slash that framework mode's patterns leave off. */
export const routePattern = (pattern: string) => `/${pattern}`.replace(/\/+/g, "/")

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

export const reportRouteError: ClientOnErrorFunction = (error, { pattern }) => {
	// Thrown responses, like a 404 from a loader, are expected
	if (isRouteErrorResponse(error)) return
	// Loader and action errors are already on their span
	if (alreadyRecorded(error)) return
	MapleBrowser.captureException(error, { name: "react_router.error", attributes: { "app.route": routePattern(pattern) } })
}
```

- The instrumented handler never throws; it resolves to `{ status, error }`. Only thrown `Error`s are `"error"`: `redirect()`, `data()` and thrown Responses count as success, so no `isFailure` argument is needed.
- Loader spans are named by route id. Data mode ids default to tree positions (`0-1`): add readable `id`s to routes that have loaders. Framework mode ids are file-based and fine.
- `onError` receives loader, action and render errors once each; prefer it over reporting from `ErrorBoundary` components (they can render twice).

## Data mode

Add to `src/router-tracing.ts`:

```ts
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

export const tracing: ClientInstrumentation = {
	// Runs once, when the router is created and before it loads the first route
	router: () => startNavigation(window.location.pathname),
	route: traceRouteHandlers,
}
```

Wire it: `createBrowserRouter(routes, { instrumentations: [tracing] })` (merge into existing options and any existing `instrumentations` array), then `traceNavigations(router)` right after, and `<RouterProvider router={router} onError={reportRouteError} />`. If `onError` already exists, call `reportRouteError` from it.

Behavior: redirects and second clicks during loading are one span named after the final route; routes without loaders produce zero-length spans; back/forward and search changes are navigations; hash changes are skipped; fetcher loaders make their own traces; a URL that matches no route is named after the root route (`navigate /`).

## Framework mode

Run `npx react-router reveal` if `app/entry.client.tsx` / `app/entry.server.tsx` don't exist. There is no router object to subscribe to (`window.__reactRouterDataRouter` is internal: don't use it). Replace `tracing` with the `navigate` hook, and drop `traceNavigations`:

```ts
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

- `app/entry.client.tsx`: `import "./maple"` first, then `<HydratedRouter instrumentations={[tracing]} onError={reportRouteError} />`.
- End the SSR pageload once hydrated, in the root route's `Layout` (it also wraps the root `ErrorBoundary`, so 404 and error pages end it too; the default `App` export doesn't render there):

	```tsx
	// app/root.tsx: add useMatches to the react-router import
	import { useEffect } from "react"
	import { matchesPattern } from "./router-tracing"
	import { endNavigation } from "./tracing"

	export function Layout({ children }: { children: React.ReactNode }) {
		const matches = useMatches()
		// The server already ran the loaders, so the first page is ready once it hydrates
		useEffect(() => endNavigation(matchesPattern(matches)), [])
		// ...the existing <html> document, unchanged
	```

- Known gaps (tell the user): back/forward buttons aren't traced, and the loaders they run start their own traces; the `.data` request for server loaders starts after an internal `await`, so it and its server spans are a separate trace; redirected navigations are named after the clicked route; a `clientLoader` that runs on hydration (`clientLoader.hydrate`, or a route with only a `clientLoader`) usually starts after the pageload span ended, so its spans are their own trace; a URL that matches no route is named after the root, `/` (a 404 `http.response.status_code` on the server span tells them apart).
- Every route gets a `loader` span on client navigations, even without a loader: React Router loads the route's module and styles through it.

Server (`app/entry.server.tsx`): start the Node SDK per `maple-nodejs-style` before the server build, with Node's `--import` flag (`"start": "NODE_OPTIONS='--import ./instrumentation.server.mjs' react-router-serve ./build/server/index.js"`, or the flag on your own server's `node` command). It needs the HTTP server instrumentation (part of the Node SDK's auto-instrumentations): that span reads the incoming `traceparent`, so a `.data` request's server spans join the browser's request, and the React Router span below nests under it. Add:

```ts
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
		route: traceRouteHandlers,
	},
]

// Render errors during SSR reach neither onError nor a loader span: record them here
export const handleError: HandleErrorFunction = (error, { request }) => {
	// Aborted requests aren't failures
	if (request.signal.aborted) return
	// Defining handleError replaces React Router's default logging
	console.error(error)
	// Thrown responses, like a 404, are expected, and loader errors are already on their span
	if (isRouteErrorResponse(error) || alreadyRecorded(error)) return
	trace.getActiveSpan()?.recordException(error instanceof Error ? error : String(error))
}
```

Merge the `react-router` import into the generated one. At the top of the default `handleRequest` (it runs inside the request span):

```ts
const carrier: Record<string, string> = {}
propagation.inject(context.active(), carrier)
if (carrier.traceparent) responseHeaders.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
```

`react-router-serve` sets no `ETag` on HTML, so there is nothing to delete. `.data` and asset responses don't go through `handleRequest`, so they never carry the header.
