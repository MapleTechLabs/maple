# Other frameworks

Human version: https://maple.dev/docs/frontend/other

For a single-page app with a hand-rolled or unlisted router (Solid, Qwik, Preact, Lit, page.js, a custom History API router), or a server-rendered multi-page app. Uses only the core API of `@maple-dev/browser`: `MapleBrowser.startNavigation(path)`, `MapleBrowser.traced(name, fn, { isFailure })`, `MapleBrowser.endNavigation(template)`, `MapleBrowser.captureException(error)`. There are no framework entries and no server helper; the package exports only `@maple-dev/browser` and `@maple-dev/browser/react`. Read the router's installed types (`node_modules/<pkg>/**/*.d.ts`) to confirm every hook before using it.

## 1. Init

- Put `MapleBrowser.init` in its own module and import it first in the client entry (`main.ts`, `index.tsx`, `entry-client.tsx`): before the app renders and before anything wraps `fetch`.
- Multi-page app: one module script on every page (step 3).
- `fetch` and `XMLHttpRequest` are both instrumented; no client switch needed.
- `propagateTraceHeaderCorsUrls`: use RegExps (`/^https:\/\/api\.acme\.com\//`). A string is an exact URL match in 0.14.0.

## 2. Single-page app

Find in the router, in this order:

- **Navigation start** (`beforeNavigate`, `beforeEach`, `NavigationStart`, `useBeforeLeave`, or your own `navigate()`): call `startNavigation(path)`. The first call in the page is the `pageload` span; later calls are `navigate`. If the router fires nothing for the initial route, call `startNavigation(location.pathname)` right after init.
- **Navigation end** (`afterNavigate`, `afterEach`, `NavigationEnd`, loading → idle), including failed and cancelled navigations: call `endNavigation(template)`.
- **Template**: the matched route's pattern (`path`, `fullPath`, `pattern`, `routeConfig.path`, `matched[].path`); join nested segments; root `""` → `/`. Never the concrete URL. Catch-all → its own pattern (`*`). No pattern available → `endNavigation()` with no argument (generic name), not the URL.
- **Data loading** (`loader`, `load`, `resolve`, a fetching guard): wrap in `traced("loader <template>", fn, { isFailure })`. `isFailure` returns `false` for the router's control-flow throws (redirect, not found).
- **Caught errors**: in the router's catch or error hook, call `captureException(error)` unconditionally. It skips what `traced` recorded.

Rules the wiring must keep:

- **Stale navigations.** `endNavigation` ends whatever navigation is open. A slow loader that settles after a newer navigation started must not render or call `endNavigation`; guard with a counter.
- **Redirects** continue the open navigation: don't call `startNavigation` for them (it would end the first span as interrupted). The span ends named after the destination, with the original `url.path`.
- **Query-only and hash-only changes**: no `startNavigation`.
- **The `await` rule.** Inside `traced`, only requests started before the first `await` nest under the span. Use `Promise.all` for independent requests. For dependent ones: `const ctx = context.active()` before the first `await`, then `context.with(ctx, () => fetch(...))` (`context` from `@opentelemetry/api`; add it to `package.json`).

Reference wiring for a History API router (tested). `match(path)` returns `{ route, params }` with `route.path` the template and a `"*"` catch-all; loaders throw `Redirect`:

```ts
// src/router.ts
import { MapleBrowser } from "@maple-dev/browser"
import { match, Redirect, renderError } from "./routes"

// A loader throws Redirect to send the user elsewhere: not a failure
const isFailure = (error: unknown) => !(error instanceof Redirect)

let latest = 0

export async function navigate(path: string, redirected = false): Promise<void> {
	// A redirect continues the open navigation: its span ends named after the destination
	if (!redirected) MapleBrowser.startNavigation(path)
	const id = ++latest
	const { route, params } = match(path) // route.path is the template: "/projects/:id"
	const { load } = route
	try {
		const data = load && (await MapleBrowser.traced(`loader ${route.path}`, () => load(params), { isFailure }))
		if (id !== latest) return // a newer navigation owns the open span
		route.render(data, params)
	} catch (error) {
		if (id !== latest) return
		if (error instanceof Redirect) {
			history.replaceState(null, "", error.to)
			return navigate(error.to, true)
		}
		// Skips errors `traced` already recorded, so a failed loader is reported once
		MapleBrowser.captureException(error)
		renderError(error)
	}
	MapleBrowser.endNavigation(route.path)
}
```

Call `navigate(location.pathname)` once at startup (after the init import), after `history.pushState` on link clicks, and on `popstate`, skipping calls where `location.pathname` didn't change.

If the router has no start event at all: wrap `history.pushState`/`replaceState` and listen to `popstate` to call `startNavigation`, and end on the framework's "route rendered" hook.

## 3. Multi-page app

Browser, on every page (bundle with the app's asset pipeline, e.g. `esbuild assets/maple.ts --bundle --format=esm --splitting --outdir=public/assets`, load with `<script type="module">`):

```ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({ ingestKey: "MAPLE_TEST", serviceName: "acme-web" })

// Every page view is a page load. The server writes the route template into <body data-route>.
MapleBrowser.startNavigation(location.pathname)
window.addEventListener("load", () => MapleBrowser.endNavigation(document.body.dataset.route))
```

Render `data-route="<route template>"` on `<body>` from the server's router.

## 4. Join the page load to the server render

Only if the server renders the HTML. The server must run OpenTelemetry (`maple-nodejs-style` skill for Node). Write the active span's context into the document response, in the request handler while the server's request span is active:

```ts
import { context, propagation } from "@opentelemetry/api"

const carrier: Record<string, string> = {}
propagation.inject(context.active(), carrier)
if (carrier.traceparent) res.setHeader("server-timing", `traceparent;desc="${carrier.traceparent}"`)
```

- Alternative: `<meta name="traceparent" content="<carrier.traceparent>">` in `<head>`.
- Other languages: the OpenTelemetry propagator's `inject` into a map, same header.
- Node ESM servers: HTTP auto-instrumentation needs OpenTelemetry's ESM loader hook (`@opentelemetry/instrumentation/hook.mjs`). Without it no span is active and `carrier.traceparent` is missing.
- Don't send the header on responses a CDN or shared cache stores.
- Only the page load joins the server trace. An unsampled server trace means no `pageload` span.

## 5. Verify

Point `endpoint` at a local sink or read the JSON bodies of `POST /v1/traces` in the network tab.

- Reload: one `pageload <template>` span, `url.path` = concrete path. Never a bare `pageload` unless the route has no template.
- With SSR: the document response has `server-timing: traceparent;desc="00-…"`, and the `pageload` span's `traceId`/`parentSpanId` equal the server request span's ids.
- One click: one `navigate <template>`; its `loader …` span has the navigation's `spanId` as `parentSpanId`, and the request spans have the loader's. The API's server span has the request span as parent (cross-origin: the request carries `traceparent` and passes preflight).
- Param-only change (`/items/1` → `/items/2`): a new `navigate` span. Query-only change: none.
- Slow route, then another link before it finishes: first span has `maple.navigation.interrupted: true` and the generic name `navigate`; the second is named; the slow route does not render afterwards.
- Redirecting loader: one span named after the destination, `url.path` = original path, redirect loader span not `Error`.
- Throwing loader: exactly one `exception` event (on the `loader` span, status `Error`), no `browser.unhandled_rejection`. Throwing click handler: one `browser.uncaught_error` span.
- Unknown URL: `navigate *` (or the catch-all's pattern), no `Error` span.
