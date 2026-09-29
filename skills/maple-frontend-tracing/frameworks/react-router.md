# React Router (v7 and v8)

Written against react-router 8.4, `@maple-dev/browser` 0.10.0. Human version: https://maple.dev/docs/frontend/react-router

Install `@maple-dev/browser` (0.10.0+). Entries: `@maple-dev/browser/react-router` (client) and `@maple-dev/browser/react-router/server` (framework-mode server), plus `serverTiming` from `@maple-dev/browser/server`.

Version check: needs React Router 7.15+ (stable `instrumentations`). Framework mode names navigations and server requests after the route only from 8.1 (`meta` on instrumentation results); on 7.15 to 8.0 those spans keep plain names (`navigate`, `GET`), data mode and the page load are unaffected. Below 7.15: tell the user to upgrade, or wrap loaders with `MapleBrowser.traced` by hand. v6 apps on `react-router-dom`: the instrumentation API needs an upgrade. Imports come from `react-router` (and `react-router/dom` for `RouterProvider` / `HydratedRouter`).

Pick the mode:

- **Data mode** (`createBrowserRouter` + `RouterProvider`).
- **Framework mode** (`@react-router/dev` Vite plugin, `app/entry.client.tsx`), with SSR.
- **Declarative** (`<BrowserRouter>`): no loaders, no navigation state. Suggest `createBrowserRouter` + `createRoutesFromElements`; don't hand-roll navigation spans.

`maple.ts` (the `MapleBrowser.init` call) goes in `src/` (data mode) or `app/` (framework mode), imported first by the client entry.

## Data mode

```tsx
// where the router is created
import { dataRouterInstrumentation, traceNavigations } from "@maple-dev/browser/react-router"

export const router = createBrowserRouter(routes, { instrumentations: [dataRouterInstrumentation] })
traceNavigations(router)
```

```tsx
// src/main.tsx
import { reportRouteError } from "@maple-dev/browser/react-router"

<RouterProvider router={router} onError={reportRouteError} />
```

- Merge into existing router options and any existing `instrumentations` array. If `onError` exists, call `reportRouteError(error, info)` from it.
- `dataRouterInstrumentation` starts the page load before the first loaders run and spans every loader/action as `loader <route.id>` / `action <route.id>`. Route ids default to positions (`0-1`): give routes with loaders a readable `id`.
- `traceNavigations` (call right after `createBrowserRouter`) ends each navigation named after the joined route pattern (`navigate /projects/:projectId`). It waits for `state.initialized` for the page load.
- Behavior: redirects and second clicks during loading are one span named after the final route (`url.path` keeps the first path); routes without loaders give zero-length spans; back/forward and search changes are navigations; hash changes, revalidations and fetchers aren't; fetcher loaders are their own traces; a URL no route matches is `navigate /`.
- Hash router (`createHashRouter`): the page load's `url.path` is `/`.

## Framework mode

Run `npx react-router reveal` if `app/entry.client.tsx` / `app/entry.server.tsx` don't exist. Don't use `window.__reactRouterDataRouter` (internal).

```tsx
// app/entry.client.tsx
import "./maple"
import { frameworkInstrumentation, reportRouteError } from "@maple-dev/browser/react-router"

// in the existing hydrateRoot(...) call
<HydratedRouter instrumentations={[frameworkInstrumentation]} onError={reportRouteError} />
```

```tsx
// app/root.tsx: in Layout (not App; Layout also wraps the root ErrorBoundary and HydrateFallback)
import { useMaplePageload } from "@maple-dev/browser/react-router"

export function Layout({ children }: { children: React.ReactNode }) {
	useMaplePageload()
	// ...the existing <html> document, unchanged
}
```

- `frameworkInstrumentation`: page load start, a span per `navigate()` call (latest click wins; the previous one ends interrupted; back/forward during a pending click ends it interrupted), hash links skipped, loader/action spans. `useMaplePageload` ends the page load once, named from `useMatches()`.
- Known gaps (tell the user): back/forward aren't traced (their loaders start their own traces); the `.data` request for server loaders is a separate trace; redirected navigations are named after the clicked route; `clientLoader.hydrate` (or a route with only a `clientLoader`) loads after the page load ended; a URL no route matches is `/` (the server span's 404 status tells it apart); every route gets a `loader` span on client navigations (module and style loading). Relative `to` (`edit`) resolves `url.path` against the URL, not the route (name is right); with a `basename`, the page load's `url.path` includes it and navigations' don't.

Server: start the Node SDK per `maple-nodejs-style` before the server build with Node's `--import` flag (`"start": "NODE_OPTIONS='--import ./instrumentation.server.mjs' react-router-serve ./build/server/index.js"`, or the flag on your own server's `node` command). It needs the HTTP server instrumentation (in the Node SDK's auto-instrumentations): that span reads incoming `traceparent`, so `.data` requests join the browser's request, and the React Router span nests under it. In `app/entry.server.tsx`:

```tsx
import { serverInstrumentation } from "@maple-dev/browser/react-router/server"
import { serverTiming } from "@maple-dev/browser/server"

export { handleError } from "@maple-dev/browser/react-router/server"
export const instrumentations = [serverInstrumentation]

// first lines of the generated default handleRequest (it runs inside the request span):
const timing = serverTiming()
if (timing) responseHeaders.append("server-timing", timing)
```

- Existing `handleError` export: keep it and call the SDK's `handleError(error, args)` from it instead of logging (it logs like React Router's default). Existing `instrumentations`: add `serverInstrumentation` to the array.
- `serverInstrumentation`: request span renamed `GET /projects/:id` (8.1+), `http.response.status_code`, Error on 5xx only, server loader/action spans under it.
- `handleError`: records render errors (which reach no loader span) on the request span; skips aborted requests, route error responses (incl. no-match 404s) and errors already recorded.
- Server loader errors: recorded once, on the server's loader span. In production the browser gets `Unexpected Server Error` and skips it; in development the real message reaches the browser, so it's recorded on both sides.
- The request span ends when the shell streams (time to first byte).
- `react-router-serve` sets no `ETag` on HTML. `.data` and asset responses don't go through `handleRequest`, so they never carry the header. CDN-cached HTML: skip the header.

## Check

Production build, in addition to `SKILL.md` Step 7:

- Framework mode page load: `GET` (HTTP) → `GET /projects/:id` → `pageload /projects/:id`; `server-timing` on the HTML only; new trace per reload.
- Click: `navigate /projects/:id` with `loader <route id>` spans under it and `fetch` under those.
- A loader that throws: exactly one `exception` event (on the loader span; for a framework-mode server loader, on the server). A render error: one `react_router.error` in the browser; during SSR, the request span is 500 with one exception.
