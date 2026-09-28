# React Router (v7 and v8)

Written against react-router 8.4 (APIs stable since 7.15). Human version: https://maple.dev/docs/frontend/react-router

Version check: `instrumentations` was `unstable_instrumentations` from 7.9.5 to 7.15; `onError` was `unstable_onError` before 7.11. Below 7.9.5, wrap loaders with `traced` by hand. Imports come from `react-router` (and `react-router/dom` for `RouterProvider` / `HydratedRouter`); v6 apps using `react-router-dom` should be told the instrumentation API needs an upgrade.

Pick the mode:

- **Data mode** (`createBrowserRouter` + `RouterProvider`): full setup below.
- **Framework mode** (`@react-router/dev` Vite plugin, `app/entry.client.tsx`): same instrumentation, `navigate` hook instead of subscribe, plus SSR.
- **Declarative mode** (`<BrowserRouter>`): no loaders, no navigation state. Don't migrate the app yourself; say in the hand-off that `createBrowserRouter` + `createRoutesFromElements` enables navigation spans. Steps 1 to 3 and 5 of `SKILL.md` still apply.

## Shared: `src/router-tracing.ts`

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

Behavior: redirects and second clicks during loading are one span named after the final route; routes without loaders produce zero-length spans; back/forward and search changes are navigations; hash changes are skipped; fetcher loaders make their own traces.

## Framework mode

Run `npx react-router reveal` if `app/entry.client.tsx` / `app/entry.server.tsx` don't exist. There is no router object to subscribe to (`window.__reactRouterDataRouter` is internal: don't use it). Replace `tracing` with the `navigate` hook, and drop `traceNavigations`:

```ts
let latest = 0

export const tracing: ClientInstrumentation = {
	router({ instrument }) {
		startNavigation(window.location.pathname)

		instrument({
			navigate: async (navigate, { to }) => {
				// navigate(-1) is a history navigation, like the back button
				if (typeof to === "number") return
				const id = ++latest
				startNavigation(to)
				const { meta } = await navigate()
				// A newer navigation has already replaced this one
				if (id === latest) endNavigation(meta && routePattern(meta.pattern))
			},
		})
	},
	route: traceRouteHandlers,
}
```

- `<HydratedRouter instrumentations={[tracing]} onError={reportRouteError} />` in `app/entry.client.tsx`, with `import "./maple"` first.
- End the SSR pageload once hydrated: in the root route component, `useEffect(() => endNavigation(), [])`.
- Known gaps (tell the user): back/forward buttons aren't traced; the `.data` request for server loaders starts after an internal `await`, so it and its server spans are a separate trace; redirected navigations are named after the clicked route; `to` can be relative.

Server (`app/entry.server.tsx`): Node SDK per `maple-nodejs-style`, loaded before the server build. Add:

```ts
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
```

And at the top of the default `handleRequest` (it runs inside the request span):

```ts
const carrier: Record<string, string> = {}
propagation.inject(context.active(), carrier)
if (carrier.traceparent) responseHeaders.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
```

If you add a `handleError` export, it replaces React Router's default logging: keep a `console.error`, skip `request.signal.aborted` and `alreadyRecorded(error)`.
