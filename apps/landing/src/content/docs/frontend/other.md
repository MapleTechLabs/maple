---
title: "Frontend tracing for other frameworks"
description: "Trace navigations, data loading and caught errors in a single-page app with any router, or in a server-rendered multi-page app, and link them to your backend."
group: "Frontend"
order: 8
navLabel: "Other frameworks"
icon: "javascript"
---

This page covers frontends without a guide of their own: a single-page app with a hand-rolled or third-party router, or a multi-page app where the server renders every page. In both, a few lines of your own code call the `@maple-dev/browser` navigation API, and every click or page view becomes one trace from the browser to your backend.

It covers installing the SDK, linking browser requests to your API, navigation and data-loading spans in a single-page app, page loads in a multi-page app, and errors your code catches.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this page.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses a framework without its own Maple guide (say which one, or "multi-page app").

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**.

## Install and initialize

```bash
npm install @maple-dev/browser
```

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	environment: import.meta.env.MODE,
	tracing: {
		// Your own APIs on another origin. Same-origin requests are covered already.
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

Import `./maple` first in your client entry, before the app renders and before other code that wraps `fetch`. The public key can only write telemetry, so it is safe in browser code. For an EU organization, add `region: "eu"`.

`init()` records a span for every `fetch` and `XMLHttpRequest` call, records uncaught errors and starts session replay. Every other option is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

## Connect browser traces to your backend

Each request span sends a W3C `traceparent` header, and your backend's span joins the same trace. Same-origin requests always send it; a request to another origin only when its URL matches `propagateTraceHeaderCorsUrls`. That API must allow the header in its CORS preflight:

```http
Access-Control-Allow-Headers: content-type, authorization, traceparent, tracestate
```

List only your own APIs: third parties would receive your trace ids, and many reject the preflight. The backend needs OpenTelemetry to read the header; see [Instrument your application](/docs/instrumentation).

## Single-page apps

Three calls turn one route change into one trace:

- `MapleBrowser.startNavigation(path)` opens a span. The first call in a page is `pageload`, later calls are `navigate`. A navigation still open is ended with `maple.navigation.interrupted: true` and keeps the generic name.
- `MapleBrowser.traced(name, fn, { isFailure })` runs a route's data loading in a child span. A throw marks the span `Error` and is rethrown, unless `isFailure` returns `false`.
- `MapleBrowser.endNavigation(template)` renames the span to `navigate /projects/:id` and ends it.

Pass the route template, never the concrete URL: Maple groups by span name, so a template gives one row per route. The concrete path is on the span as `url.path`.

### Wire your router

This is the part of a History API router that runs a route. `match` returns the route whose `path` is the template, and a catch-all route (`"*"`) for unknown URLs. A loader throws `Redirect` to send the user elsewhere.

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

Call it on link clicks, on back and forward, and once at startup:

```ts
// src/main.ts
import "./maple" // first: before the app renders or anything wraps fetch
import { navigate } from "./router"

let path = location.pathname

function onLocationChange() {
	// Query-only and hash-only changes load no data
	if (location.pathname === path) return
	path = location.pathname
	void navigate(path)
}

document.addEventListener("click", (event) => {
	const link = (event.target as Element).closest("a")
	if (!link || link.origin !== location.origin || event.button !== 0 || event.metaKey || event.ctrlKey) return
	event.preventDefault()
	history.pushState(null, "", link.href)
	onLocationChange()
})
window.addEventListener("popstate", onLocationChange)

void navigate(path) // the first call is the page load
```

What you get:

- `pageload /projects/:id` for the first route, then one `navigate <template>` trace per path change, back and forward included, with the `loader` span, its requests and your API's spans under it.
- A click while a route loads ends the first span as interrupted. The `latest` check stops the slow loader from rendering or ending the newer span.
- A redirect is one span named after the destination, with the original path as `url.path`.
- An unknown URL is `navigate *`, with no error.
- A loader that throws is recorded once, on its `loader` span. Render errors are reported by `captureException`, errors in event handlers by the SDK's global handler.

### Using a router library

Look for these in its API and make the same calls:

- **Navigation start** (`beforeNavigate`, `beforeEach`, `NavigationStart`, `useBeforeLeave`): `startNavigation(path)`. If the router emits nothing for the first route, call `startNavigation(location.pathname)` after `init`. Skip redirects the router starts while a navigation is open, or the first span ends as interrupted.
- **Navigation end** (`afterNavigate`, `afterEach`, `NavigationEnd`, a router state going from loading to idle), including failed and cancelled navigations: `endNavigation(template)`.
- **Route template**: a property like `path`, `fullPath`, `pattern` or `routeConfig.path` on the last matched route. Nested routers store a segment per level; join them.
- **Data loading** (`loader`, `load`, `resolve`, a guard that fetches): wrap it in `traced("loader <template>", fn, { isFailure })`. Return `false` from `isFailure` for the router's control-flow throws (redirect, not found).

### Requests after an `await`

The browser has no async context, so a request started after the first `await` inside `traced` is its own trace. Start independent requests together with `Promise.all`. For a request that needs an earlier result, save the context before the first `await`:

```ts
import { context } from "@opentelemetry/api"

async function loadUser({ id }: Params) {
	const ctx = context.active() // before the first await
	const user = await fetchJson(`/api/users/${id}`)
	const team = await context.with(ctx, () => fetchJson(`/api/teams/${user.teamId}`))
	return { user, team }
}
```

Install `@opentelemetry/api` yourself if you use it; strict package managers like pnpm don't resolve the SDK's copy for you.

## Multi-page apps

Every page view is a full page load, so each one is a `pageload` span. Load this on every page:

```ts
// assets/maple.ts, loaded on every page: <script type="module" src="/assets/maple.js">
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "maple_pk_...", // public key
	serviceName: "acme-web",
})

// Every page view is a page load. The server writes the route template into <body data-route>.
MapleBrowser.startNavigation(location.pathname)
window.addEventListener("load", () => MapleBrowser.endNavigation(document.body.dataset.route))
```

Bundle it with your asset pipeline, for example `npx esbuild assets/maple.ts --bundle --format=esm --splitting --outdir=public/assets`. The page load span starts at the browser's navigation start and gets child spans for fetching the HTML (`documentFetch`) and parsing it (`domProcessing`).

### Join the server's trace

The page load joins the trace of the request that rendered the page when the response carries a `Server-Timing: traceparent;desc="…"` entry or the page a `<meta name="traceparent">` tag. Maple has no server helper for this: set up OpenTelemetry on the server ([Instrument your application](/docs/instrumentation)), then write the active span's context into the response. In Node.js:

```ts
import { context, propagation } from "@opentelemetry/api"

// In the request handler, while the server's request span is active
const carrier: Record<string, string> = {}
propagation.inject(context.active(), carrier)
if (carrier.traceparent) res.setHeader("server-timing", `traceparent;desc="${carrier.traceparent}"`)
```

Other languages have the same `inject` call on their OpenTelemetry propagator. A `<meta name="traceparent" content="…">` tag with the same value works too.

- Only the page load joins the server trace. Requests the page makes later start their own traces.
- The browser follows the server's sampling decision: a page load under a trace the server didn't sample isn't recorded.
- Don't let a CDN or shared cache store HTML with this header: every visitor would join the same old trace.

## Report errors your code catches

The SDK's global handlers only see errors nothing caught. Where your app catches rendering or data errors to show an error page (a framework `errorHandler`, a router `onError`, a root error boundary), report them:

```ts
MapleBrowser.captureException(error)
```

It skips errors `traced` already recorded, and records each error object once, so reporting and then rethrowing is safe.

## Next steps

- [Browser SDK reference](/docs/session-replay/browser-sdk): every option, logs, Web Vitals, sampling and privacy.
- [Frontend tracing overview](/docs/frontend): the framework guides.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
