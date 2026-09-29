# Other frameworks

Human version: https://maple.dev/docs/frontend/other

Uses `MapleBrowser.startNavigation` / `endNavigation` / `traced` / `captureException` from `@maple-dev/browser` (0.10.0+) directly, plus `@maple-dev/browser/server` for SSR. For any frontend without its own reference: Solid/SolidStart (a worked Solid Router example is at the end), Qwik, Preact, Astro, Remix v2, Ember, Lit, a hand-rolled router, or a multi-page app. The steps in `SKILL.md` stay the same. This file is how to find where each one goes. Read the framework's installed types (`node_modules/<pkg>/**/*.d.ts`) to confirm every hook before using it.

## 1. Init

Call `MapleBrowser.init` in the module that runs first in the browser: the client entry (`main.ts`, `index.tsx`, `entry-client.tsx`, `client.ts`), or a script tag in the root layout for server-first frameworks (Astro: a `<script>` in the base layout). It must run before the app renders and before other code that wraps `fetch`.

## 2. Navigation start and end

Search the router's API for a pair of hooks, in this order of preference:

| Look for | Examples | Use as |
| --- | --- | --- |
| A "navigation started" event or guard | `beforeNavigate`, `beforeEach`, `NavigationStart`, `onBeforeNavigate`, `useBeforeLeave` | `MapleBrowser.startNavigation(path)` |
| A "navigation finished / route resolved" event | `afterNavigate`, `afterEach`, `NavigationEnd`, `onResolved`, a router `subscribe` whose state goes loading → idle | `MapleBrowser.endNavigation(template)` |
| Failure or cancel events | `NavigationCancel`, `NavigationError`, a `failure` argument | also `MapleBrowser.endNavigation(template)` |

Details to handle:

- **First load.** Make sure the first navigation also calls `MapleBrowser.startNavigation` (it becomes the `pageload` span). If the router doesn't emit a start event for the initial route, call `MapleBrowser.startNavigation(location.pathname)` yourself right after init, before the router's first render.
- **First load end.** Routers often run no transition for the first render, so the end event never fires for it (Solid Router's `useIsRouting()` stays `false`). End the `pageload` span when the first route has rendered with its data: from an effect inside the root `Suspense` (it runs when the boundary resolves), and also from the root error boundary, because a first page that fails never resolves. Until then, ignore the end event: a redirect during the first load can end its transition before the data arrives.
- **Start events without a path.** Some pass a history delta for back/forward (Solid Router's `useBeforeLeave` gives `to: -1`). The URL has already changed by then: use `window.location.pathname`.
- **Redirects.** If a loader redirect starts a second navigation while the first is loading, don't call `startNavigation` for it, or the first span ends as interrupted. Solid Router's `redirect()` navigates with `replace: true`: skip replace navigations while one is in flight, and the open span ends named after the destination.
- **Query-only or hash-only changes.** Skip them unless they load data.
- **No start event at all.** Wrap `history.pushState` and `history.replaceState` and listen to `popstate` to call `startNavigation`, and end on the framework's "route rendered" hook. As a last resort, a route-change effect that only marks the end is still worth having: call `startNavigation` and `endNavigation` together so each route change is at least named and counted.
- **Multi-page apps** (every navigation is a full page load): call `MapleBrowser.startNavigation(location.pathname)` right after init and `MapleBrowser.endNavigation(template)` on the window `load` event. Each page load becomes a `pageload` span, and Step 6 of `SKILL.md` joins it to the server's trace.

## 3. Route template

The span name needs the matched route's pattern, not the URL. Look for, on the matched route or its last match: `path`, `fullPath`, `route.id`, `pattern`, `routeConfig.path`, `matched[].path`. Nested routers often store relative segments per level; join them. If the router exposes no pattern at all, rebuild one by replacing the known param values in the pathname with `:<name>`. If there are no params either, pass nothing to `endNavigation` and keep the generic span name rather than using a concrete URL. The root route's pattern can be an empty string (Solid Router); use `/`, or the span keeps its generic name.

## 4. Data loading

Find the router's route-level data mechanism: `loader`, `load`, `resolve`, `query`/`createAsync`, `beforeEnter` guards that fetch. Wrap each one with `MapleBrowser.traced("loader <template>", fn, { isFailure })`. Find what the framework **throws on purpose** (redirects, not-found, HTTP error helpers, often with an `isRedirect`/`isHttpError`-style guard exported) and return `false` for those from `isFailure`. Some throw a `Response` for redirects (Solid Router's `redirect()`): `(error) => !(error instanceof Response)`.

Wrap the function that runs on every navigation that needs the data. A route `preload` hook can be the wrong place: Solid Router doesn't rerun it when only params change (`/projects/1` → `/projects/2`, the component's `createAsync` refetches instead), and it ignores the promise `preload` returns, so a rejection becomes an unhandled rejection. With cached query functions (Solid's `query`), wrap inside the query: one `loader` span per query, and cache hits make none.

Routers that preload on hover or focus (Solid Router's `<A>` by default, TanStack's `preload="intent"`) run loaders with no navigation in progress; those spans become their own traces. A navigation served from that cache has no loader span under it. That's expected.

If data is fetched in components with no route-level mechanism, don't wrap every component. The `fetch` spans still nest under the navigation span when started during the navigation's synchronous part, and they stay individually traced otherwise.

## 5. Caught errors

Find the single place caught errors flow through: a framework-level error handler (`app.config.errorHandler`, `ErrorHandler` provider, `handleError` hook), a router `onError`, or the root error boundary component. Call `MapleBrowser.captureException(error)` there, unconditionally: it skips errors `traced` recorded and records each error object once. If errors are only caught by many local boundaries, add the call to the shared boundary component.

## 6. SSR

Find the server hook that sees the response before it is sent: a server entry `handleRequest`/`fetch` handler, a request middleware, a `handle` hook, a response hook. Wrap the render in an `ssr <template>` span there and append `serverTiming()` from `@maple-dev/browser/server` as the `server-timing` header from inside it (see `SKILL.md` Step 6). If the framework already creates OpenTelemetry spans for rendering, call `serverTiming()` within that span's context instead of adding a second render span. Server-side loaders: `traced` from `@maple-dev/browser/server`.

## 7. Example: Solid Router

Written against `@solidjs/router` 1.0 and `solid-js` 1.9, client-only (`npm create solid`, template `with-solid-router`). Not tested with SolidStart.

```ts
// src/index.tsx, after MapleBrowser.init(...) and before render()
MapleBrowser.startNavigation(location.pathname) // the first render emits no start event
```

```tsx
// src/app.tsx, the <Router root={...}> component
import { MapleBrowser } from "@maple-dev/browser"
import { useBeforeLeave, useCurrentMatches, useIsRouting } from "@solidjs/router"
import { createEffect, ErrorBoundary, on, onMount, Suspense, type ParentComponent } from "solid-js"

const App: ParentComponent = (props) => {
	const matches = useCurrentMatches()
	const isRouting = useIsRouting()
	// The root route's pattern is ""
	const template = () => {
		const match = matches().at(-1)
		return match && (match.route.pattern || "/")
	}

	// The first render runs no transition: its span ends when the root Suspense resolves
	let firstLoad = true
	const endFirstLoad = () => {
		firstLoad = false
		MapleBrowser.endNavigation(template())
	}
	// Effects under a pending Suspense run when it resolves
	const FirstLoadEnd = () => {
		onMount(endFirstLoad)
		return null
	}

	useBeforeLeave((e) => {
		if (e.defaultPrevented) return
		// `to` is a history delta for back/forward; the URL has already changed
		const path = typeof e.to === "number" ? window.location.pathname : new URL(e.to, window.location.href).pathname
		// Query-only and hash-only changes load no data
		if (path === e.from.pathname) return
		// A query's redirect() navigates with `replace` while the first navigation is loading: keep its span
		if (e.options?.replace && (firstLoad || isRouting())) return
		MapleBrowser.startNavigation(path)
	})

	createEffect(
		on(isRouting, (routing, wasRouting) => {
			if (wasRouting && !routing && !firstLoad) MapleBrowser.endNavigation(template())
		}),
	)

	return (
		<ErrorBoundary
			fallback={(error) => {
				MapleBrowser.captureException(error)
				// A failed first page never resolves its Suspense
				endFirstLoad()
				return <p role="alert">Something went wrong.</p>
			}}
		>
			<Suspense>
				<FirstLoadEnd />
				{props.children}
			</Suspense>
		</ErrorBoundary>
	)
}

export default App
```

```ts
// Data: wrap inside query(), not in the route's preload
import { MapleBrowser } from "@maple-dev/browser"
import { query } from "@solidjs/router"

// redirect() is thrown as a Response; it isn't a failure
const isFailure = (error: unknown) => !(error instanceof Response)

export const getProject = query(
	(id: string) => MapleBrowser.traced("loader /projects/:id", () => fetchProject(id), { isFailure }),
	"project",
)
```

- If the app already has a root `ErrorBoundary`/`Suspense`, add the calls to those instead of nesting new ones.
- Template: `useCurrentMatches().at(-1).route.pattern` (`/projects/:id`; a `*404` catch-all is `/*404`).
- Behavior: one `navigate` span per path change, with one `loader` span per query under it; param changes too, since `createAsync` refetches inside the transition. Query-only and hash-only changes make no span. Back/forward are navigations. A second click while loading ends the first span as interrupted (generic name `navigate`). A redirect is one span named after the destination, with the original `url.path`.
- `<A>` preloads on hover and focus: those loader spans are their own traces, and a click within the `query` cache window (about 5 seconds) shows a `navigate` span without a loader. Back/forward within that window also make no loader span.
- Errors: a query that throws is recorded once, on its `loader` span; `captureException` in the boundary skips it. Render errors are reported from the boundary. Errors in event handlers reach the SDK's global handler.
