# Other frameworks

For any frontend without its own reference: Solid/SolidStart, Qwik, Preact, Astro, Remix v2, Ember, Lit, a hand-rolled router, or a multi-page app. The steps in `SKILL.md` stay the same. This file is how to find where each one goes. Read the framework's installed types (`node_modules/<pkg>/**/*.d.ts`) to confirm every hook before using it.

## 1. Init

Call `MapleBrowser.init` in the module that runs first in the browser: the client entry (`main.ts`, `entry-client.tsx`, `client.ts`), or a script tag in the root layout for server-first frameworks (Astro: a `<script>` in the base layout). It must run before the app renders and before other code that wraps `fetch`.

## 2. Navigation start and end

Search the router's API for a pair of hooks, in this order of preference:

| Look for | Examples | Use as |
| --- | --- | --- |
| A "navigation started" event or guard | `beforeNavigate`, `beforeEach`, `NavigationStart`, `onBeforeNavigate`, `useBeforeLeave` | `startNavigation(path)` |
| A "navigation finished / route resolved" event | `afterNavigate`, `afterEach`, `NavigationEnd`, `onResolved`, a router `subscribe` whose state goes loading → idle | `endNavigation(template)` |
| Failure or cancel events | `NavigationCancel`, `NavigationError`, a `failure` argument | also `endNavigation(template)` |

Details to handle:

- **First load.** Make sure the first navigation also calls `startNavigation` (it becomes the `pageload` span). If the router doesn't emit a start event for the initial route, call `startNavigation(location.pathname)` yourself right after init, before the router's first render.
- **Query-only or hash-only changes.** Skip them unless they load data.
- **No start event at all.** Wrap `history.pushState` and `history.replaceState` and listen to `popstate` to call `startNavigation`, and end on the framework's "route rendered" hook. As a last resort, a route-change effect that only marks the end is still worth having: call `startNavigation` and `endNavigation` together so each route change is at least named and counted.
- **Multi-page apps** (every navigation is a full page load): call `startNavigation(location.pathname)` right after init and `endNavigation(template)` on the window `load` event. Each page load becomes a `pageload` span, and Step 6 of `SKILL.md` joins it to the server's trace.

## 3. Route template

The span name needs the matched route's pattern, not the URL. Look for, on the matched route or its last match: `path`, `fullPath`, `route.id`, `pattern`, `routeConfig.path`, `matched[].path`. Nested routers often store relative segments per level; join them. If the router exposes no pattern at all, rebuild one by replacing the known param values in the pathname with `:<name>`. If there are no params either, pass nothing to `endNavigation` and keep the generic span name rather than using a concrete URL.

## 4. Data loading

Find the router's route-level data mechanism: `loader`, `load`, `resolve`, `routeData`, `query`/`createAsync`, `beforeEnter` guards that fetch. Wrap each one with `traced("loader <template>", fn, isFailure)`. Find what the framework **throws on purpose** (redirects, not-found, HTTP error helpers, often with an `isRedirect`/`isHttpError`-style guard exported) and return `false` for those from `isFailure`.

If data is fetched in components with no route-level mechanism, don't wrap every component. The `fetch` spans still nest under the navigation span when started during the navigation's synchronous part, and they stay individually traced otherwise.

## 5. Caught errors

Find the single place caught errors flow through: a framework-level error handler (`app.config.errorHandler`, `ErrorHandler` provider, `handleError` hook), a router `onError`, or the root error boundary component. Call `MapleBrowser.captureException(error)` there unless `alreadyRecorded(error)`. If errors are only caught by many local boundaries, add the call to the shared boundary component.

## 6. SSR

Find the server hook that sees the response before it is sent: a server entry `handleRequest`/`fetch` handler, a request middleware, a `handle` hook, a response hook. Wrap the render in an `ssr <template>` span there and append the `server-timing` header from inside it (see `SKILL.md` Step 6). If the framework already creates OpenTelemetry spans for rendering, inject from within the active context instead of adding a second render span.
