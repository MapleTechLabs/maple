---
title: "Frontend tracing for Astro"
description: "Trace Astro page loads, ClientRouter navigations and island errors in the browser, and join the first page load to the server render of on-demand pages in one OpenTelemetry trace."
group: "Frontend"
order: 7
navLabel: "Astro"
icon: "astro"
---

Astro ships HTML first and JavaScript only where you ask for it, so its frontend tracing looks different from a single-page app. By default every link loads a new document, and each page load becomes one `pageload` span named after the page's route. With `<ClientRouter />`, links are fetched and swapped in place, and each one becomes a `navigate` span with the page request and, for pages rendered on demand, the server's spans under it. This guide covers both, plus errors from islands and the server half for on-demand rendering. The integration needs Astro 5 or later, and the code was checked against Astro 7.3.

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
npm install @maple-dev/browser
```

This guide needs `@maple-dev/browser` 0.10.0 or later.

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

Astro only exposes environment variables with the `PUBLIC_` prefix to browser code, so the key and version come from `PUBLIC_MAPLE_INGEST_KEY` and `PUBLIC_COMMIT_SHA`. Import `./maple` in a `<script>` in your base layout, which [the next section](#trace-page-loads-and-navigations) adds. It must run before other code that wraps `fetch`.

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

## Navigation and data-loading spans

Out of the box, every `fetch()` is its own trace, so a navigation that makes three requests shows up as three unrelated traces. The SDK fixes that with a span per navigation, and the data-loading and `fetch` spans nested under it. Three calls do the work:

- `MapleBrowser.startNavigation(path)` opens a `pageload` span for the first route and a `navigate` span for each one after it. If a navigation starts before the previous one ended, the previous span ends and is marked `app.navigation.interrupted`.
- `MapleBrowser.endNavigation(route)` names the span after the route template and ends it.
- `MapleBrowser.traced(name, fn, { isFailure })` runs data loading in a child span of the current navigation, and marks the span failed when `fn` throws, unless `isFailure` returns `false`. An error it recorded isn't reported a second time by `captureException` or the SDK's global error handlers.

The Astro integration below connects them to page loads and `<ClientRouter />` navigations.

Span names use the route template, like `navigate /projects/:id`, never the concrete URL. Maple groups by span name, so a template gives you one row with a real p95, while concrete URLs give you one row per project. The concrete path is still on the span as `url.path`.

The first page load joins the server render's trace without any browser code: when the server sends its trace context in a `Server-Timing` header or a `<meta name="traceparent">` tag, the `pageload` span becomes part of that trace, and follows its sampling decision: a page load under a trace the server didn't sample isn't recorded. In a client-only app, it starts a trace of its own. The [Browser SDK reference](/docs/session-replay/browser-sdk#navigation-and-data-loading-spans) has the details.

### The await problem

In the browser, a span only stays active until the first `await` inside it. A request that starts after an `await` loses its parent and shows up as a separate trace.

```ts
// ❌ fetchMembers starts after an await, so it becomes its own trace
MapleBrowser.traced("load project", async () => {
	const project = await fetchProject(id)
	const members = await fetchMembers(project.id)
	return { project, members }
})
```

```ts
// ✅ Save the context before the first await, and run later requests inside it
import { context } from "@opentelemetry/api"

MapleBrowser.traced("load project", async () => {
	const ctx = context.active()
	const project = await fetchProject(id)
	const members = await context.with(ctx, () => fetchMembers(project.id))
	return { project, members }
})
```

`context` comes from `@opentelemetry/api`, so add it with `npm install @opentelemetry/api` if you use this pattern. The SDK already depends on it, but strict package managers like pnpm only resolve packages you list yourself.

If the requests don't depend on each other, start them together with `Promise.all` instead. Both nest under the span, and the page stops waiting on one request before starting the next.

This happens because browsers have no equivalent of Node's `AsyncLocalStorage`, which is what carries the active span across `await` on the server.

## Trace page loads and navigations

Add the `maple()` integration to your Astro config:

```js
// astro.config.mjs
import maple from "@maple-dev/browser/astro"
import { defineConfig } from "astro/config"

export default defineConfig({
	integrations: [maple()],
})
```

Then start the SDK from a `<script>` in the base layout that every page renders:

```astro
---
// src/layouts/Layout.astro
const { title } = Astro.props
---

<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>{title}</title>
		<script>
			import "../maple" // starts the SDK
		</script>
	</head>
	<body>
		<slot />
	</body>
</html>
```

That's the whole browser setup, with or without `<ClientRouter />`. The integration adds two things to every page. A middleware writes the page's route template onto its `<html>` element as `data-route`, and a script, bundled once per page, starts and ends the navigation spans and names them after that attribute. `MapleBrowser.init()` stays in your own script because its options can hold functions and `import.meta.env` values, which the integration's config can't pass to the browser.

Keep the `<script>` a plain one, with no `is:inline` and no attributes. Astro then bundles it as a module, resolves its imports, and includes it once per page even if the layout renders twice. If your pages don't share a layout, as in the `minimal` starter where each page writes its own `<html>`, add the same `<script>` to every page's `<head>`.

Without `<ClientRouter />`, each link loads a new document, and each page load becomes a `pageload` span that ends at the window `load` event. Back and forward load the document again and get a new `pageload` span, unless the browser restores the page from its back/forward cache. A restored page runs no script, so it records no span.

### Name spans after the route

`Astro.routePattern` is the route of the page being rendered, as a path relative to `src/pages` without the extension. It's what the integration writes into `data-route`:

| Page file | `Astro.routePattern` |
| --- | --- |
| `src/pages/index.astro` | `/` |
| `src/pages/projects/[id].astro` | `/projects/[id]` |
| `src/pages/blog/[slug].astro`, prerendered with `getStaticPaths` | `/blog/[slug]` |
| `src/pages/docs/[...path].astro` | `/docs/[...path]` |
| `src/pages/404.astro` | `/404` |

The brackets stay. The server span in [the server section](#server-side-tracing-for-on-demand-pages) uses the same string, so browser and server spans for a route share a name.

- **Prerendered pages get it at build time.** Astro runs middleware for them while it builds, and writes the HTML the middleware returns.
- **Pages rendered on demand get it while the HTML streams out.** Only the bytes up to the end of the `<html>` start tag are held back.
- **The `<html>` tag has to come first.** Only a doctype and comments may come before it, and it must start within the first 16 KiB of the document. A page where it doesn't, or whose HTML another middleware compressed, gets no route, and its spans keep the generic names `pageload` and `navigate`.
- **A `data-route` you set yourself wins.** Server islands and partials, which have no `<html>`, pass through unchanged.
- **After `Astro.rewrite()`, the page that rendered wins,** because Astro runs the middleware again for it.

### How long the pageload span is

The integration starts the `pageload` span once the HTML has been parsed and every module script on the page has run, including the one that calls `init()`, and ends it when the page's images and stylesheets have loaded. On a light page that can be under a millisecond. The time before it, the request and the server render, belongs to the server's half of the trace, which [the server section](#server-side-tracing-for-on-demand-pages) connects for pages rendered on demand.

### Navigations with ClientRouter

`<ClientRouter />` from `astro:transitions` turns links into client-side navigations: it fetches the next page's HTML, swaps it into the current document, and animates the change with view transitions. There's no new document, and Astro doesn't run the page's bundled scripts again. Instead, the router fires events on `document`, and the integration's script turns them into spans:

- **The span runs from `astro:before-preparation` to `astro:page-load`**, from the moment the router starts fetching the next page until the new page's scripts have run.
- **The page request joins the click.** The router's loader runs in a `load page` span, so the `fetch` for the next page's HTML is a child of the `navigate` span, and that request carries `traceparent`. For a page rendered on demand, the server's spans for that render land in the same trace.
- **The template follows the swap.** The router copies the new page's `<html>` attributes onto the document when it swaps, so by `astro:page-load`, `data-route` holds the new page's template.

The edge cases:

- **A second click aborts the first.** The router cancels the first navigation, and its span ends as interrupted, under the generic name `navigate`.
- **Some links fall back to a full page load.** When the response isn't HTML (a link to `/report.pdf`), the page has no `<ClientRouter />`, or a redirect leads to another origin, the router loads the URL as a new document. The `navigate` span ends with the generic name, and the new document gets its own `pageload` span.
- **Redirects on the same origin stay in one span.** The fetch follows the redirect, and the span is named after the page you land on. Its `url.path` is the path you clicked.
- **Query changes are navigations.** A link to `?tab=2` fetches the page again and gets a `navigate` span. A hash link on the same page fires no event and gets no span. Back and forward are navigations.
- **Prefetching moves the page request before the click.** `<ClientRouter />` prefetches every link on hover unless you set `prefetch: false`. Browsers that support `<link rel="prefetch">` use it, which makes no `fetch` span; the server renders the prefetch as its own trace, and the click's `load page` span can then be served from the prefetch cache with no server spans under it. Where `rel="prefetch"` isn't supported, Astro prefetches with `fetch()`, which shows up as its own trace.
- **Your own navigation listeners can hold a span open.** A navigation that another `astro:before-preparation` listener cancels, or whose custom loader throws, ends as interrupted at the next navigation or when the page is left.

## Data loading in Astro

An Astro page loads its data in the frontmatter, the code between the `---` fences. That code runs on the server when the page is rendered on demand, or once at build time when it's prerendered. There's no loader running in the browser, so there's nothing to wrap with `traced` there. On the server, frontmatter requests nest under the integration's `ssr` span from [the server section](#server-side-tracing-for-on-demand-pages).

Client-side requests come from islands, the `client:*` components. Astro loads each island's code after the page, and in testing even `client:load` islands mounted after the window `load` event, when the `pageload` span has already ended. Their `fetch` spans are their own traces, each still joined to your backend's spans through `traceparent`. Don't wrap them in `traced`; there's no navigation left for them to join.

Two kinds of requests don't join the page's trace:

- **Server islands.** A `server:defer` component is fetched by a small inline script Astro adds to the page. On the first load it runs before the bundled scripts have started the SDK. In testing, the request carried no `traceparent` either way, on the first load and after a `<ClientRouter />` swap, so the server renders each server island in its own trace, as `ssr /_server-islands/[name]`.
- **`is:inline` scripts.** They run while the page is parsed, before any bundled script, so requests they make right away aren't traced.

## Report errors from islands

Astro has no client-side error hook of its own: the page is HTML, and the JavaScript on it belongs to islands and scripts. Four kinds of errors need covering:

- **Uncaught errors reach the SDK by themselves.** An error thrown in a script or an event handler, or a React island that throws while rendering with no error boundary around it, reaches `window.onerror`. The SDK records it as `browser.uncaught_error`.
- **Islands whose code fails to load are reported by the integration.** When an island's JavaScript can't be fetched, often a chunk that a new deploy removed, Astro retries once, catches the error, and logs it. Since Astro 6.3 it also dispatches an `astro:hydration-error` event, which the integration reports as `astro.hydration_error`.
- **Errors your island framework catches.** Each framework's error boundary stops errors from reaching the SDK. Report from the boundary.
- **Island data loading that fails.** A rejected request or load function that nothing catches reaches the SDK as `browser.unhandled_rejection`. If the island catches the error to show an error state, the SDK never sees it, so call `MapleBrowser.captureException(error)` in that `catch`. There's no `loader` span in an Astro setup, so this error span is the only record of the failure.

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
import maple from "@maple-dev/browser/astro"
import { defineConfig } from "astro/config"

export default defineConfig({
	integrations: [maple(), vue({ appEntrypoint: "/src/vue-app" })],
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

## Server-side tracing for on-demand pages

What happens on the server depends on how the page is built.

### Static output

With the default `output: "static"` and no adapter, every page is prerendered at build time. No server runs when a visitor loads a page, so there's no server trace to join, and each `pageload` span starts its own trace. The same goes for prerendered pages in a project that also renders others on demand: they're served as files, with no `server-timing` header. Skip the rest of this section.

### On-demand rendering

A page is rendered on demand when the project has an adapter and either sets `output: "server"` or the page exports `prerender = false`. For those, the integration's middleware runs each request in an `ssr <route>` span, like `ssr /projects/[id]`, and hands its trace context to the browser in a `server-timing` header on the HTML response. The browser side needs nothing more: the `pageload` span becomes a child of the `ssr` span.

The integration adds its middleware before yours, so an existing `src/middleware.ts` keeps working unchanged.

What to know about the span:

- **It ends when streaming starts.** Astro runs the page's frontmatter, then streams the HTML while it renders the components inside the page. The span ends at that point. Requests made by those components still nest under it, because Node's `AsyncLocalStorage` carries the context, but they run past its end. The HTTP server span from the Node instrumentation covers the whole response.
- **Errors in the page's frontmatter are recorded.** They reject the render: the span records the exception and is marked `Error`, the response is a 500, and it has no `server-timing` header. An error in a component further down the page is different. The 200 status has already been sent, the page ends with `Internal server error`, and nothing records the error.
- **Endpoints get the span too.** API routes like `src/pages/api/*.ts` and Astro's server island route are named `ssr /api/...` and `ssr /_server-islands/[name]`. Their responses aren't HTML documents, so they don't get the header.
- **Cached responses don't get the header.** Every visitor who gets a cached copy would join the trace of the request that filled the cache, so the middleware skips pages that Astro 7's route cache stores (`Astro.cache.set()` or `routeRules`, with `maxAge` or `swr`), and responses whose `Cache-Control` has `public`, `s-maxage` or a `max-age` above 0, or that set `CDN-Cache-Control`, a vendor variant like `Vercel-CDN-Cache-Control`, or `Surrogate-Control`, unless the header also says `no-store` or `private`. If a CDN caches pages by a rule of its own, send one of those headers on them. Astro sets no `ETag` on pages rendered on demand, so a 304 can't replay an old header.
- **A rewrite adds a second span.** `Astro.rewrite()` runs the middleware again for the page it renders, so the rewriting route's `ssr` span has the rendered route's `ssr` span under it, and the response carries both spans' trace context. The browser joins the inner one, in the same trace.

### Wire it without the integration

The integration's script loads the SDK's code on every page, including pages that never call `init()`. To trace only some pages, skip the integration and wire its two parts yourself. Export the middleware from `src/middleware.ts`, first in `sequence()` from `astro:middleware` if you have your own:

```ts
// src/middleware.ts
export { onRequest } from "@maple-dev/browser/astro/middleware"
```

And trace navigations from the script that starts the SDK, on the pages you want traced:

```astro
<script>
	import "../maple" // starts the SDK
	import { traceAstroNavigation } from "@maple-dev/browser/astro/client"

	traceAstroNavigation()
</script>
```

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

Prerendered pages and files from `public/` that the adapter serves still get an HTTP server span each, in a trace of their own. Their `pageload` spans don't join those traces, because the files carry no `server-timing` header.

**Cloudflare adapter (`@astrojs/cloudflare`).** Export the Worker's traces with [Workers Observability](/docs/guides/instrumentation-cloudflare-workers). The Workers runtime records the spans itself, but your code can't read their trace ids yet, and no OpenTelemetry SDK is registered in the Worker, so the middleware finds no trace context to send. It still writes the route into your pages. The `pageload` span starts its own trace, and the Worker's request shows up as a separate trace in Maple.

For any other adapter, see [Instrument your application](/docs/instrumentation) for its runtime. The page load joins the server's trace only if an OpenTelemetry SDK runs in the same process as Astro.

## Worked example

A project with a base layout, `<ClientRouter />`, prerendered blog pages, and project pages rendered on demand by the Node adapter. This is the config:

```js
// astro.config.mjs
import node from "@astrojs/node"
import maple from "@maple-dev/browser/astro"
import { defineConfig } from "astro/config"

export default defineConfig({
	adapter: node({ mode: "standalone" }),
	integrations: [maple()],
})
```

And the complete layout:

```astro
---
// src/layouts/Layout.astro
import { ClientRouter } from "astro:transitions"

const { title } = Astro.props
---

<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>{title}</title>
		<ClientRouter />
		<script>
			import "../maple" // starts the SDK
		</script>
	</head>
	<body>
		<slot />
	</body>
</html>
```

Together with `src/maple.ts` and the preloaded Node SDK, you get these traces:

- **Loading `/projects/8f2a` directly.** The HTTP server span, `ssr /projects/[id]` under it with the frontmatter's requests, and `pageload /projects/[id]` from the browser as a child of the `ssr` span. A reload starts a new trace.
- **Loading `/blog/hello` directly.** A `pageload /blog/[slug]` span with no parent. The page is a prerendered file, so there's no server span.
- **Clicking from a blog post to `/projects/8f2a`.** `navigate /projects/[id]` with `load page` under it, the `fetch` for the page's HTML under that, and the server's HTTP and `ssr /projects/[id]` spans under the `fetch`: one trace for the click, from the browser to the frontmatter's requests.
- **Clicking to a blog post.** `navigate /blog/[slug]` with `load page` and its `fetch`, and no server spans.

## Astro tracing gotchas

- **Every page needs the `init()` script.** A page that doesn't render your base layout records nothing when it's loaded directly, even though the integration's script still loads the SDK's code there. With `<ClientRouter />`, a navigation to such a page also falls back to a full page load, since it has no `<ClientRouter />` of its own.
- **Use `PUBLIC_` environment variables.** Astro only exposes variables with that prefix to browser code. `VITE_*` variables are `undefined` in the browser unless you change `vite.envPrefix`.
- **Check your Astro version.** The integration needs Astro 5 or later for `Astro.routePattern`: on Astro 4 the middleware passes every response through, and spans keep their generic names. Reporting islands that fail to load needs Astro 6.3, and skipping pages in the route cache needs Astro 7.
- **Hidden tabs abort view transitions.** In Chromium, a `<ClientRouter />` navigation that finishes while the tab is in the background can't run its view transition, and the browser rejects it with `InvalidStateError: Transition was aborted because of invalid state`. Astro doesn't handle that rejection, so the SDK records it as `browser.unhandled_rejection`. The navigation itself completes.
- **Test with a production build.** `astro dev` also names and traces pages, but it doesn't bundle scripts the same way, and the server spans need the OpenTelemetry SDK that only the start command preloads. Run `astro build`, then the adapter's start command, or `astro preview` for a static site.
- **Node 26 warns about `module.register()`.** The ES module hook still works.
- **Interrupted navigations need a slow page response.** To see a `navigate` span end as interrupted, use `<ClientRouter />` and click away from a page whose response is slow, like an on-demand page with slow frontmatter. A slow request in an island doesn't hold the navigation open, and without `<ClientRouter />` there's no navigation span to interrupt.

## What this setup doesn't cover

- **`XMLHttpRequest`.** Only `fetch` is instrumented. Clients built on XHR, like axios by default, need `adapter: "fetch"` or OpenTelemetry's `XMLHttpRequestInstrumentation`.
- **Web Vitals.** The SDK doesn't record LCP, INP or CLS.
- **Readable stack traces.** Errors are grouped without bundle hashes and line numbers, so one bug stays one issue across deploys, but stacks show minified names.
- **Ad blockers.** Some block telemetry requests. If that matters for your users, point `endpoint` at a proxy on your own domain.
- **Trace sampling.** `replay.sampleRate` samples session recordings; browser traces are all sent.

## FAQ

### Does Astro have built-in OpenTelemetry support?

No. Astro doesn't create spans on the server or in the browser. On the server, the Node SDK's HTTP instrumentation gives you a span per request, and the `maple()` integration adds one named after the route. In the browser, the integration adds the page load and navigation spans.

### Does this work with a fully static Astro site?

Yes. Everything before the server section works without a server: each page load is a `pageload` span, and with `<ClientRouter />` each click is a `navigate` span. The integration writes the route into each page at build time. Without a `server-timing` header, the `pageload` span starts its own trace.

### Why is my navigate span missing the server's spans?

Three common causes. The page is prerendered, so no server renders it. The page was prefetched on hover, so the click was served from the prefetch cache and the server rendered it earlier, in its own trace. Or the server doesn't continue incoming traces: with the Node adapter, check that OpenTelemetry's ES module hook is registered, or `node:http` isn't instrumented.

## Next steps

- [Frontend tracing overview](/docs/frontend): every framework guide.
- [Browser SDK reference](/docs/session-replay/browser-sdk): consent, masking and URL redaction.
- [Session replays](/docs/session-replay/replays): open the recording behind a trace.
- [Errors and issues](/docs/errors/overview): how reported errors are grouped into issues.
- [Instrument your application](/docs/instrumentation): backend guides, so browser traces continue into your services.
