---
title: "Frontend tracing for Astro"
description: "Trace Astro page loads, ClientRouter navigations and island errors in the browser, and join the first page load to the server render of on-demand pages in one OpenTelemetry trace."
group: "Frontend"
order: 7
navLabel: "Astro"
icon: "astro"
---

Astro ships HTML first and JavaScript only where you ask for it, so its frontend tracing looks different from a single-page app. By default every link loads a new document, and each page load becomes one `pageload` span named after the page's route. With `<ClientRouter />`, links are fetched and swapped in place, and each one becomes a `navigate` span with the page request and, for pages rendered on demand, the server's spans under it. This guide covers both, plus errors from islands and the server half for on-demand rendering. The code was checked against Astro 7.3.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-frontend-tracing](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing) skill, which contains every step of this guide.

```text
Set up Maple frontend tracing in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-frontend-tracing -y`, then follow it. This app uses Astro.

My Maple public ingest key is maple_pk_... and my organization is in the US region.
```

Use your public key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install the browser SDK

```bash
npm install @maple-dev/browser @opentelemetry/api
```

`@opentelemetry/api` is for the tracing helper below. The SDK already depends on it, but strict package managers like pnpm only resolve packages you list yourself.

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: import.meta.env.PUBLIC_MAPLE_INGEST_KEY, // public key, maple_pk_...
	serviceName: "acme-web",
	serviceVersion: import.meta.env.PUBLIC_COMMIT_SHA,
	environment: import.meta.env.MODE,
})
```

Astro only exposes environment variables with the `PUBLIC_` prefix to browser code, so the key and version come from `PUBLIC_MAPLE_INGEST_KEY` and `PUBLIC_COMMIT_SHA`. Import `./maple` first in a `<script>` in your base layout, which [the next sections](#trace-page-loads-and-navigations) build. It must run before other code that wraps `fetch`.

`init()` sets up:

- a span for every `fetch()` call;
- error spans for uncaught errors and unhandled promise rejections, which show up on the [Errors](/docs/errors/overview) page;
- session replay, with the same `session.id` on every span and replay event, so a trace links to the recording of the session that produced it;
- export every 2 seconds, plus a flush when the tab is hidden or closed, so the spans from the last moments of a visit aren't lost;
- redaction of credential-looking query parameters (`token`, `code`, `password` and similar) in every URL it sends.

Use the public ingest key (`maple_pk_…`) from **Settings → Ingestion**. It can only write telemetry, so it's safe in browser code. For an EU organization, add `region: "eu"`. Every option is in the [Browser SDK reference](/docs/session-replay/browser-sdk).

## Connect browser traces to your backend

Each `fetch()` span sends a W3C `traceparent` header, and your backend's span joins the same trace. For requests to the page's own origin this happens automatically. For an API on another origin, list it:

```ts
MapleBrowser.init({
	// ...
	tracing: {
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

Then allow the header in the API's CORS configuration. Without it, the browser blocks the request after the preflight:

```http
Access-Control-Allow-Headers: content-type, authorization, traceparent, tracestate
```

Only list your own APIs. Sending `traceparent` to third parties leaks your trace ids, and many of them reject the preflight.

Your backend needs OpenTelemetry to read the header; every OpenTelemetry HTTP server instrumentation does. See [Instrument your application](/docs/instrumentation) for your backend's language or framework.

Browser and server clocks disagree, so a server span can appear to start slightly before the `fetch` that caused it, and a laptop that slept can be minutes off. Durations are accurate; the offsets between browser and server spans are approximate.

## Add the tracing helper

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The fix is a span per navigation, with the data-loading and `fetch` spans nested under it. Add this helper as `src/tracing.ts`; the rest of this guide connects it to Astro:

```ts
// src/tracing.ts
import { context, propagation, type Span, SpanStatusCode, trace } from "@opentelemetry/api"

const tracer = trace.getTracer("acme-web")

let navigation: { span: Span; kind: "pageload" | "navigate" } | undefined
let firstLoad = true

/** Call when the router starts a navigation. */
export function startNavigation(path: string) {
	// A click before the last navigation finished replaces it
	navigation?.span.setAttribute("app.navigation.interrupted", true)
	navigation?.span.end()

	const kind = firstLoad ? "pageload" : "navigate"
	// Only the first page load belongs to the server's trace, if there was one
	const parent = firstLoad ? serverContext() : context.active()
	firstLoad = false

	navigation = { kind, span: tracer.startSpan(kind, { attributes: { "url.path": path } }, parent) }
}

/** Call when the new route is ready. `route` is its template, like `/projects/:id`. */
export function endNavigation(route?: string) {
	if (!navigation) return
	if (route) navigation.span.updateName(`${navigation.kind} ${route}`)
	navigation.span.end()
	navigation = undefined
}

const recorded = new WeakSet<object>()

/** Run `fn` in a span under the current navigation. */
export function traced<T>(
	name: string,
	fn: () => Promise<T>,
	isFailure: (error: unknown) => boolean = () => true,
): Promise<T> {
	const parent = navigation ? trace.setSpan(context.active(), navigation.span) : context.active()

	return tracer.startActiveSpan(name, {}, parent, async (span) => {
		try {
			return await fn()
		} catch (error) {
			if (isFailure(error)) {
				// Some libraries throw error-like objects that aren't Error instances
				span.recordException(error instanceof Error ? error : String((error as { message?: unknown })?.message ?? error))
				span.setStatus({ code: SpanStatusCode.ERROR })
				if (typeof error === "object" && error !== null) recorded.add(error)
			}
			throw error
		} finally {
			span.end()
		}
	})
}

/** Whether `traced` already recorded this error on a span. */
export const alreadyRecorded = (error: unknown) =>
	typeof error === "object" && error !== null && recorded.has(error)

/** The trace the server rendered this page under, from a `Server-Timing` header or a `<meta>` tag. */
function serverContext() {
	if (typeof document === "undefined") return context.active()
	const [page] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
	const traceparent =
		page?.serverTiming?.find((entry) => entry.name === "traceparent")?.description ||
		document.querySelector<HTMLMetaElement>('meta[name="traceparent"]')?.content
	return traceparent ? propagation.extract(context.active(), { traceparent }) : context.active()
}
```

- `startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `endNavigation(route)` names the span after the route template and ends it.
- `traced(name, fn, isFailure)` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`.
- `alreadyRecorded(error)` tells you whether `traced` already recorded an error, so it isn't reported twice.
- `serverContext()` joins the first page load to the server's trace when the server sent its trace context, in a `Server-Timing` header or a `<meta name="traceparent">` tag. In a client-only app it does nothing.

Span names use the route template, like `navigate /projects/:id`, never the concrete URL. Maple groups by span name, so a template gives you one row with a real p95, while concrete URLs give you one row per project. The concrete path is still on the span as `url.path`.

### The await problem

Browsers have no equivalent of Node's `AsyncLocalStorage`, so OpenTelemetry's web context manager only tracks the active span synchronously. Inside `traced`, a `fetch()` called before the first `await` nests under the span. A `fetch()` called after it starts a new trace:

```ts
// Both requests nest under the span
traced("load project", () => Promise.all([fetchProject(id), fetchMembers(id)]))

// The second request loses its parent
traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id) // new trace
	return { project, members }
})
```

When a request depends on an earlier one, capture the context before the first `await` with `const ctx = context.active()`, and make the request with `context.with(ctx, () => fetchMembers(project.id))`. Sequential awaits while loading a page are also a request waterfall, so check whether the requests can run in parallel first.

## Trace page loads and navigations

Everything on the browser side goes in one `<script>` in the base layout that every page renders. The layout also writes the page's route template into the document, so the script can name spans after it:

```astro
---
// src/layouts/Layout.astro
const { title } = Astro.props
---

<html lang="en" data-route={Astro.routePattern}>
	<head>
		<meta charset="utf-8" />
		<title>{title}</title>
		<script>
			import "../maple" // first: starts the SDK before anything else runs
			import { endNavigation, startNavigation } from "../tracing"

			// The route template the server rendered into <html data-route>, like /projects/[id]
			const template = () => document.documentElement.dataset.route

			// Every document load
			startNavigation(location.pathname)
			addEventListener("load", () => endNavigation(template()))
		</script>
	</head>
	<body>
		<slot />
	</body>
</html>
```

Without `<ClientRouter />`, that's all you need. Each link loads a new document, the script runs once per document, and each page load becomes a `pageload` span that ends at the window `load` event.

Keep the `<script>` a plain one, with no `is:inline` and no attributes. Astro then bundles it as a module, resolves its imports, and includes it once per page even if the layout renders twice. If your app has several base layouts, move the `<script>` into a small component, like `src/components/Tracing.astro`, and render that from each layout. Two separate scripts would each call `startNavigation`, and the second would end the first as interrupted.

### Name spans after the route

`Astro.routePattern` is the route of the page being rendered, as a path relative to `src/pages` without the extension. In a layout it's still the page's route, not the layout's:

| Page file | `Astro.routePattern` |
| --- | --- |
| `src/pages/index.astro` | `/` |
| `src/pages/projects/[id].astro` | `/projects/[id]` |
| `src/pages/blog/[slug].astro`, prerendered with `getStaticPaths` | `/blog/[slug]` |
| `src/pages/docs/[...path].astro` | `/docs/[...path]` |
| `src/pages/404.astro` | `/404` |

Keep the brackets. The server span in [the server section](#server-side-tracing-for-on-demand-pages) uses the same string, so browser and server spans for a route share a name.

### How long the pageload span is

The script is a module, so it runs once the HTML has been parsed, and the span ends when the page's images and stylesheets have loaded. On a light page that can be under a millisecond. The time before it, the request and the server render, belongs to the server's half of the trace, which [the server section](#server-side-tracing-for-on-demand-pages) connects for pages rendered on demand.

### Navigations with ClientRouter

`<ClientRouter />` from `astro:transitions` turns links into client-side navigations: it fetches the next page's HTML, swaps it into the current document, and animates the change with view transitions. There's no new document, so the script above doesn't run again. Instead, the router fires events on `document`:

| Event | When it fires |
| --- | --- |
| `astro:before-preparation` | A navigation starts, before the next page is fetched. `event.to` is the destination URL, and `event.loader` is the function that fetches it. |
| `astro:after-preparation` | The next page has loaded. |
| `astro:before-swap` | Right before the new page replaces the old one. |
| `astro:after-swap` | The new page is in the DOM; its scripts haven't run yet. |
| `astro:page-load` | The new page's scripts have run. Also fires once on the first page load. |

Start the span in `astro:before-preparation`, end it in `astro:page-load`, and wrap the loader, so the request for the next page sits under the navigation span:

```ts
// Navigations handled by <ClientRouter />
document.addEventListener("astro:before-preparation", (event) => {
	startNavigation(event.to.pathname)
	const load = event.loader
	event.loader = async () => {
		// The request for the next page's HTML, and the server render behind it
		await traced("load page", load)
		// Astro falls back to a full page load, which gets its own pageload span
		if (event.defaultPrevented && !event.signal.aborted) endNavigation()
	}
})
document.addEventListener("astro:page-load", () => endNavigation(template()))
```

Add it to the layout's script, below the `load` listener, and import `traced` next to the other two. The [worked example](#worked-example) has the complete file.

Why this works:

- **The template follows the swap.** The router copies the new page's `<html>` attributes onto the document when it swaps, so by `astro:page-load`, `data-route` holds the new page's template.
- **The script runs once per session.** Bundled scripts that already ran are skipped after a swap, so the listeners are registered once. Don't add `data-astro-rerun` to the script: the listeners would pile up.
- **The first load ends once.** On the first page, both `load` and `astro:page-load` fire. Whichever comes second finds no open span and does nothing.
- **The page request joins the click.** `traced` makes the `fetch` for the next page's HTML a child of the `navigate` span, and that request carries `traceparent`. For a page rendered on demand, the server's spans for that render land in the same trace.

The edge cases:

- **A second click aborts the first.** The router cancels the first navigation, and `startNavigation` ends its span as interrupted, under the generic name `navigate`. The `signal.aborted` check stops the cancelled loader from ending the new span.
- **Some links fall back to a full page load.** When the response isn't HTML (a link to `/report.pdf`), the page has no `<ClientRouter />`, or a redirect leads to another origin, the router loads the URL as a new document. The `navigate` span ends with the generic name, and the new document gets its own `pageload` span.
- **Redirects on the same origin stay in one span.** The fetch follows the redirect, and the span is named after the page you land on. Its `url.path` is the path you clicked.
- **Query changes are navigations.** A link to `?tab=2` fetches the page again and gets a `navigate` span. A hash link on the same page fires no event and gets no span. Back and forward are navigations.
- **Prefetching moves the page request before the click.** `<ClientRouter />` prefetches every link on hover unless you set `prefetch: false`. Browsers that support `<link rel="prefetch">` use it, which makes no `fetch` span; the server renders the prefetch as its own trace, and the click's `load page` span can then be served from the prefetch cache with no server spans under it. Where `rel="prefetch"` isn't supported, Astro prefetches with `fetch()`, which shows up as its own trace.

## Data loading in Astro

An Astro page loads its data in the frontmatter, the code between the `---` fences. That code runs on the server when the page is rendered on demand, or once at build time when it's prerendered. There's no loader running in the browser, so there's nothing to wrap with `traced` there. On the server, frontmatter requests nest under the middleware span from [the server section](#server-side-tracing-for-on-demand-pages).

Client-side requests come from islands, the `client:*` components. Astro loads each island's code after the page, and in testing even `client:load` islands mounted after the window `load` event, when the `pageload` span has already ended. Their `fetch` spans are their own traces, each still joined to your backend's spans through `traceparent`. Don't wrap them in `traced`; there's no navigation left for them to join.

Two kinds of requests don't join the page's trace:

- **Server islands.** A `server:defer` component is fetched by a small inline script Astro adds to the page. On the first load it runs before the bundled layout script has started the SDK. In testing, the request carried no `traceparent` either way, on the first load and after a `<ClientRouter />` swap, so the server renders each server island in its own trace, as `ssr /_server-islands/[name]`.
- **`is:inline` scripts.** They run while the page is parsed, before any bundled script, so requests they make right away aren't traced.

## Report errors from islands

Astro has no client-side error hook of its own: the page is HTML, and the JavaScript on it belongs to islands and scripts. Three kinds of errors need covering:

- **Uncaught errors reach the SDK by themselves.** An error thrown in a script or an event handler, or a React island that throws while rendering with no error boundary around it, reaches `window.onerror`. The SDK records it as `browser.uncaught_error`.
- **Islands whose code fails to load.** When an island's JavaScript can't be fetched, often a chunk that a new deploy removed, Astro retries once, catches the error, and logs it. Since Astro 6.3 it also dispatches an `astro:hydration-error` event, which the layout script can report.
- **Errors your island framework catches.** Each framework's error boundary stops errors from reaching the SDK. Report from the boundary.

For the `astro:hydration-error` event, add a listener to the layout's script:

```ts
import { MapleBrowser } from "@maple-dev/browser"

// An island whose code failed to load: Astro catches the error and only logs it
document.addEventListener("astro:hydration-error", (event) => {
	const { error } = (event as CustomEvent<{ error: unknown }>).detail
	MapleBrowser.captureException(error, { name: "astro.hydration_error" })
})
```

For React islands, report from the error boundary's `componentDidCatch`. React calls it once per error, and the error doesn't reach the SDK's global handler:

```tsx
// src/components/ErrorBoundary.tsx
import { MapleBrowser } from "@maple-dev/browser"
import { Component, type ReactNode } from "react"

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false }

	static getDerivedStateFromError() {
		return { failed: true }
	}

	componentDidCatch(error: unknown) {
		MapleBrowser.captureException(error, { name: "react.render_error" })
	}

	render() {
		return this.state.failed ? <p role="alert">Something went wrong.</p> : this.props.children
	}
}
```

Vue islands need a handler even if you have no error boundary. A production Vue build only logs component errors with `console.error`, so without `app.config.errorHandler` the SDK never sees them. `@astrojs/vue` gives you access to the app through an `appEntrypoint` file:

```js
// astro.config.mjs
import vue from "@astrojs/vue"
import { defineConfig } from "astro/config"

export default defineConfig({
	integrations: [vue({ appEntrypoint: "/src/vue-app" })],
})
```

```ts
// src/vue-app.ts
import { MapleBrowser } from "@maple-dev/browser"
import type { App } from "vue"

export default (app: App) => {
	// Setting a handler turns off Vue's own logging, so keep it
	app.config.errorHandler = (error, _instance, info) => {
		console.error(error)
		MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } })
	}
}
```

If you already have an `appEntrypoint`, add the handler to it. For Svelte islands, use `<svelte:boundary onerror={(error) => MapleBrowser.captureException(error)}>`; for Solid, call `captureException` in the `ErrorBoundary` fallback.

The `alreadyRecorded` check from the other guides isn't needed here: nothing in this setup runs island code inside `traced`.

## Server-side tracing for on-demand pages

What happens on the server depends on how the page is built.

### Static output

With the default `output: "static"` and no adapter, every page is prerendered at build time. No server runs when a visitor loads a page, so there's no server trace to join, and each `pageload` span starts its own trace. The same goes for prerendered pages in a project that also renders others on demand: they're served as files, with no `server-timing` header. Skip the rest of this section.

### On-demand rendering

A page is rendered on demand when the project has an adapter and either sets `output: "server"` or the page exports `prerender = false`. For those, Astro middleware wraps each request in a span and hands its trace context to the browser in a `server-timing` header:

```ts
// src/middleware.ts
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api"
import { defineMiddleware } from "astro:middleware"

const tracer = trace.getTracer("acme-web")

export const onRequest = defineMiddleware((ctx, next) => {
	// Prerendered pages run this at build time, with no request to trace
	if (ctx.isPrerendered) return next()

	return tracer.startActiveSpan(`ssr ${ctx.routePattern}`, async (span) => {
		try {
			const response = await next()
			if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })

			// Only HTML documents, and not ones Astro's route cache stores and replays to other visitors
			const cached = ctx.cache.options.maxAge !== undefined
			if (response.headers.get("content-type")?.startsWith("text/html") && !cached) {
				const carrier: Record<string, string> = {}
				propagation.inject(context.active(), carrier)
				if (carrier.traceparent) {
					response.headers.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
				}
			}
			return response
		} catch (error) {
			span.recordException(error as Error)
			span.setStatus({ code: SpanStatusCode.ERROR })
			throw error
		} finally {
			span.end()
		}
	})
})
```

If you already have a `src/middleware.ts`, combine the two with `sequence()` from `astro:middleware` and put this one first. The `serverContext()` function in the helper reads the header, so the browser side needs nothing more: the `pageload` span becomes a child of the `ssr` span.

What to know about the span:

- **It ends when streaming starts.** Astro runs the page's frontmatter, then streams the HTML while it renders the components inside the page. The span ends at that point. Requests made by those components still nest under it, because Node's `AsyncLocalStorage` carries the context, but they run past its end. The HTTP server span from the Node instrumentation covers the whole response.
- **Errors in the page's frontmatter are recorded.** They reject `next()`: the span records the exception, the response is a 500, and it has no `server-timing` header. An error in a component further down the page is different. The 200 status has already been sent, the page ends with `Internal server error`, and nothing records the error.
- **Endpoints get the span too.** API routes like `src/pages/api/*.ts` and Astro's server island route are named `ssr /api/...` and `ssr /_server-islands/[name]`. Their responses don't get the header, or don't use it.
- **Caching.** The `cached` check skips pages that Astro 7's route cache stores (`Astro.cache.set()` or `routeRules`), since every visitor would get the first request's header and join its trace. On Astro 6 or older, remove that check. Skip the header the same way on pages a CDN caches. Astro sets no `ETag` on pages rendered on demand, so a 304 can't replay an old header.

### Set up OpenTelemetry on the server

The middleware uses the OpenTelemetry API, which does nothing until an SDK is running in the server process. Which one depends on the adapter.

**Node adapter (`@astrojs/node`).** Follow the [Node.js guide](/docs/guides/instrumentation-nodejs) and preload the SDK with `--import`, so it starts before Astro:

```bash
node --import ./instrumentation.mjs ./dist/server/entry.mjs
```

Three details matter for Astro:

- Astro's server build is ES modules. Register OpenTelemetry's ES module hook before `sdk.start()`, with `register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)` from `node:module`. Without it, `node:http` is never patched: there's no HTTP server span, and an incoming `traceparent` isn't continued, so the page requests `<ClientRouter />` makes don't join the click's trace.
- Ignore Astro's hashed assets in the HTTP instrumentation, or every script and stylesheet the browser downloads gets its own trace:

	```js
	getNodeAutoInstrumentations({
		// Hashed JS and CSS files: otherwise one trace per asset on every page load
		"@opentelemetry/instrumentation-http": {
			ignoreIncomingRequestHook: (request) => request.url?.startsWith("/_astro/") ?? false,
		},
	})
	```

	`/_astro/` is the default `build.assets` directory; use your value if you changed it.
- Install the OpenTelemetry packages as `dependencies`. The preload file isn't part of Astro's build, so they have to be installed where the server runs.

**Cloudflare adapter (`@astrojs/cloudflare`).** Export the Worker's traces with [Workers Observability](/docs/guides/instrumentation-cloudflare-workers). The Workers runtime records the spans itself, but your code can't read their trace ids yet, and no OpenTelemetry SDK is registered in the Worker, so the middleware would find no trace context to send. Leave it out: the `pageload` span starts its own trace, and the Worker's request shows up as a separate trace in Maple.

For any other adapter, see [Instrument your application](/docs/instrumentation) for its runtime, and keep the middleware only if an OpenTelemetry SDK runs in the same process.

## Worked example

A project with a base layout, `<ClientRouter />`, prerendered blog pages, and project pages rendered on demand by the Node adapter. This is the complete layout:

```astro
---
// src/layouts/Layout.astro
import { ClientRouter } from "astro:transitions"

const { title } = Astro.props
---

<html lang="en" data-route={Astro.routePattern}>
	<head>
		<meta charset="utf-8" />
		<title>{title}</title>
		<ClientRouter />
		<script>
			import "../maple" // first: starts the SDK before anything else runs
			import { MapleBrowser } from "@maple-dev/browser"
			import { endNavigation, startNavigation, traced } from "../tracing"

			// The route template the server rendered into <html data-route>, like /projects/[id]
			const template = () => document.documentElement.dataset.route

			// Every document load: the first one, and each navigation without <ClientRouter />
			startNavigation(location.pathname)
			addEventListener("load", () => endNavigation(template()))

			// Navigations handled by <ClientRouter />
			document.addEventListener("astro:before-preparation", (event) => {
				startNavigation(event.to.pathname)
				const load = event.loader
				event.loader = async () => {
					// The request for the next page's HTML, and the server render behind it
					await traced("load page", load)
					// Astro falls back to a full page load, which gets its own pageload span
					if (event.defaultPrevented && !event.signal.aborted) endNavigation()
				}
			})
			document.addEventListener("astro:page-load", () => endNavigation(template()))

			// An island whose code failed to load: Astro catches the error and only logs it
			document.addEventListener("astro:hydration-error", (event) => {
				const { error } = (event as CustomEvent<{ error: unknown }>).detail
				MapleBrowser.captureException(error, { name: "astro.hydration_error" })
			})
		</script>
	</head>
	<body>
		<slot />
	</body>
</html>
```

Together with `src/maple.ts`, `src/tracing.ts`, `src/middleware.ts` and the preloaded Node SDK, you get these traces:

- **Loading `/projects/8f2a` directly.** The HTTP server span, `ssr /projects/[id]` under it with the frontmatter's requests, and `pageload /projects/[id]` from the browser as a child of the `ssr` span. A reload starts a new trace.
- **Loading `/blog/hello` directly.** A `pageload /blog/[slug]` span with no parent. The page is a prerendered file, so there's no server span.
- **Clicking from a blog post to `/projects/8f2a`.** `navigate /projects/[id]` with `load page` under it, the `fetch` for the page's HTML under that, and the server's HTTP and `ssr /projects/[id]` spans under the `fetch`: one trace for the click, from the browser to the frontmatter's requests.
- **Clicking to a blog post.** `navigate /blog/[slug]` with `load page` and its `fetch`, and no server spans.

## Astro tracing gotchas

- **One script, in the base layout.** A page that doesn't render the layout has no `data-route` and no tracing. With `<ClientRouter />`, a navigation to such a page falls back to a full page load.
- **Use `PUBLIC_` environment variables.** Astro only exposes variables with that prefix to browser code. `VITE_*` variables are `undefined` in the browser unless you change `vite.envPrefix`.
- **Hidden tabs abort view transitions.** In Chromium, a `<ClientRouter />` navigation that finishes while the tab is in the background can't run its view transition, and the browser rejects it with `InvalidStateError: Transition was aborted because of invalid state`. Astro doesn't handle that rejection, so the SDK records it as `browser.unhandled_rejection`. The navigation itself completes.
- **Test with a production build.** `astro dev` doesn't bundle scripts the same way, and the middleware needs the OpenTelemetry SDK that only the start command preloads. Run `astro build`, then the adapter's start command, or `astro preview` for a static site.
- **Node 26 warns about `module.register()`.** The ES module hook still works.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does Astro have built-in OpenTelemetry support?

No. Astro doesn't create spans on the server or in the browser. On the server, the Node SDK's HTTP instrumentation gives you a span per request, and the middleware in this guide adds one named after the route. In the browser, the layout script in this guide adds the page load and navigation spans.

### Does this work with a fully static Astro site?

Yes. Everything before the server section works without a server: each page load is a `pageload` span, and with `<ClientRouter />` each click is a `navigate` span. Without a `server-timing` header, `serverContext()` finds nothing and the `pageload` span starts its own trace.

### Why is my navigate span missing the server's spans?

Three common causes. The page is prerendered, so no server renders it. The page was prefetched on hover, so the click was served from the prefetch cache and the server rendered it earlier, in its own trace. Or the server doesn't continue incoming traces: with the Node adapter, check that OpenTelemetry's ES module hook is registered, or `node:http` isn't instrumented.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
