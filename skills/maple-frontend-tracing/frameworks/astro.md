# Astro

Written against `astro` 7.3, `@astrojs/node` 11.1, `@astrojs/react` 7.0 and `@astrojs/vue` 7.0. Human version: https://maple.dev/docs/frontend/astro

Put `maple.ts` (the `MapleBrowser.init` call) and `tracing.ts` in `src/`. Install `@opentelemetry/api` next to `@maple-dev/browser`: `tracing.ts` and `src/middleware.ts` import it. Inline the key as `SKILL.md` Step 1 says. Astro only exposes `PUBLIC_`-prefixed env vars to the browser: if the project passes the key or version through env vars, read `import.meta.env.PUBLIC_MAPLE_INGEST_KEY` / `PUBLIC_COMMIT_SHA`, not `VITE_*`.

Astro is multi-page by default: every link is a document load, and each page gets one `pageload` span. With `<ClientRouter />` (view transitions), links are fetched and swapped in place, and each one gets a `navigate` span. The script below handles both.

## Init, page loads and navigations

In the base layout that every page renders (merge into the existing `<html>` and `<head>`, keep its markup and props):

```astro
---
// src/layouts/Layout.astro
import { ClientRouter } from "astro:transitions" // only if the app already uses it
---

<html lang="en" data-route={Astro.routePattern}>
	<head>
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
	<body><slot /></body>
</html>
```

- Keep the `<script>` processed (no `is:inline`, no `data-astro-rerun`, no attributes besides `src`). Astro bundles it as a module, includes it once per page, and `<ClientRouter />` doesn't run it again after a swap, so the listeners register once per document.
- Several base layouts: move the `<script>` into one component (`src/components/Tracing.astro`) that each layout renders. Two separate scripts would each call `startNavigation`, and the second ends the first as interrupted.
- No layout (the `minimal` starter writes `<html>` in each page): same component, rendered in every page's `<head>`, plus `data-route={Astro.routePattern}` on every page's `<html>`. Don't restructure the pages into a layout for tracing.
- Without `<ClientRouter />`, the `astro:*` events never fire; leave the listeners in. Don't add `<ClientRouter />` for tracing.
- Template: `Astro.routePattern` in a layout is the page's route, relative to `src/pages` without extension: `/`, `/projects/[id]`, `/blog/[slug]` (prerendered via `getStaticPaths` too), `/docs/[...path]`, `/404`. Keep the brackets; the server span uses the same string.
- `<ClientRouter />` copies the new page's `<html>` attributes on swap, so `data-route` is the new template by `astro:page-load`.
- The `pageload` span runs from when the module script executes (after the HTML is parsed) to `load` (images, stylesheets). It's short on light pages; the request and server render are in the server half of the trace (see Server side).
- `<ClientRouter />` events, in order: `astro:before-preparation` (before the next page is fetched; `event.loader` does the fetch and can be replaced; `event.signal` aborts when another navigation starts), `astro:after-preparation`, `astro:before-swap`, `astro:after-swap` (DOM swapped, scripts not yet run), `astro:page-load` (after scripts; also fires on the first load, from `load`, which is why the second `endNavigation` is a no-op).
- `traced("load page", load)` puts the document `fetch` under the `navigate` span. It carries `traceparent`, so for an on-demand page the server's spans join the click's trace. For a prerendered page it's the `fetch` span only.
- A click during a pending navigation aborts it: the first span ends as interrupted (generic name `navigate`), and the `signal.aborted` check keeps the new span open.
- Links to non-HTML responses (`/file.pdf`), to a page without `<ClientRouter />`, or redirects to another origin: Astro cancels the swap and loads the URL as a document. The `navigate` span ends with the generic name; the new document gets its own `pageload`.
- Redirects on the same origin: the fetch follows them; the span is named after the destination, `url.path` is the path clicked.
- Query-only changes (`?tab=2`) fetch the page again: a `navigate` span. Hash-only links on the same page fire no event. Back/forward are navigations.
- Without `<ClientRouter />`, back/forward loads the document again: a new `pageload`. A page the browser restores from its back/forward cache runs no script, so it gets no span.
- `<ClientRouter />` turns on prefetching of every link on hover (unless `prefetch: false`). Browsers with `<link rel="prefetch">` support make no `fetch` span for it; the server renders the prefetch as its own trace, and the click's `load page` span can be served from the prefetch cache with no server spans under it. Where `rel="prefetch"` isn't supported, Astro prefetches with `fetch()`: its own trace.
- In Chromium, a view transition in a hidden tab (the user switched tabs mid-navigation) rejects with `InvalidStateError: Transition was aborted because of invalid state`, which the SDK reports as `browser.unhandled_rejection`. The navigation itself completes. Mention it in the hand-off; don't suppress it.

## Data loading

- Frontmatter runs on the server (on-demand pages) or at build time (prerendered). There is no client loader to wrap; the browser never sees that data loading. Server-side, it nests under the middleware span below.
- Islands (`client:*` components) fetch after hydration, which starts after `load` in testing, so their `fetch` spans are their own traces. Don't wrap them in `traced`.
- Island data loading that fails: a rejection nothing catches reaches the SDK as one `browser.unhandled_rejection` span with the `exception` event. An island that catches it to show an error state hides it from the SDK: add `MapleBrowser.captureException(error)` in that `catch` (one `exception` span). There is no `loader` span, so for `SKILL.md` Step 7's "data loading throws" check, expect one of those two spans instead.
- Server islands (`server:defer`) are fetched by an inline script Astro adds to the page. In testing those requests carried no `traceparent`, on the first load (the inline script runs before the bundled script has initialized the SDK) and after a swap: each server island render is its own server trace (`ssr /_server-islands/[name]`).
- `is:inline` scripts also run before the bundled script; requests they make on load aren't traced.

## Caught errors

Astro has no client error hook. What reaches Maple:

- Uncaught errors in islands and scripts: the SDK's global handler (`browser.uncaught_error`). A React 19 island that throws while rendering, with no boundary, lands here.
- Island code that fails to load (chunk 404 after a deploy, network): Astro catches it, retries once, then dispatches `astro:hydration-error` (Astro 6.3+). The layout listener above reports it.
- Errors the island framework catches: report from its own boundary, once per framework used.
	- React: `componentDidCatch(error)` in the app's error boundary, `MapleBrowser.captureException(error, { name: "react.render_error" })`. React calls it once; the error doesn't also reach the global handler.
	- Vue: production builds only `console.error` component errors. Set `app.config.errorHandler` (as in `frameworks/vue.md`) from the file passed to `vue({ appEntrypoint: "/src/vue-app" })`; the file default-exports `(app: App) => void`. Keep an existing `appEntrypoint`.
	- Svelte: `<svelte:boundary onerror={(error) => MapleBrowser.captureException(error)}>`. Solid: in the `ErrorBoundary` fallback.

`alreadyRecorded` isn't needed in these hooks: nothing in this setup calls `traced` around island code.

## Server side

### Static output (default, no adapter)

Skip this section. No server runs at request time, and the `pageload` span starts its own trace.

### On-demand rendering (an adapter, with `output: "server"` or `export const prerender = false` pages)

Middleware wraps every on-demand request in a span and hands its trace context to the browser:

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

- If `src/middleware.ts` exists, add this as its own handler with `sequence()` from `astro:middleware`, first in the list.
- `ctx.cache` is Astro 7's route cache; on Astro 6 or older, drop the `cached` check. Pages cached by a CDN rule need the same exclusion.
- Endpoints (`src/pages/api/*.ts`) and server islands get the span too (`ssr /api/...`, `ssr /_server-islands/[name]`); their responses aren't HTML, or aren't documents, so the header does no harm.
- The span ends when Astro starts streaming: after the page's own frontmatter, before the components inside it render. Their server requests still nest under it (AsyncLocalStorage) but run past its end. The HTTP server span covers the whole response.
- An error thrown in the page's frontmatter rejects `next()`: recorded on the span, 500 response, no header. A component deeper in the page that throws after streaming started produces a 200 with `Internal server error` appended, and nothing records it. Say so in the hand-off if the app renders data-fetching components.
- Astro sets no `ETag` on on-demand HTML (only `Astro.cache.set({ etag })` does, and cached pages are skipped). Prerendered files served by the Node adapter have ETags but never pass through the middleware. Don't send the header on responses a CDN caches.

Server OpenTelemetry, by adapter:

- `@astrojs/node`: Node SDK per `maple-nodejs-style`, preloaded: `node --import ./instrumentation.mjs ./dist/server/entry.mjs` (update the `start` script or Dockerfile). The server build is ES modules: `register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)` before `sdk.start()` is required. Without it `node:http` isn't patched: no HTTP server span, and an incoming `traceparent` isn't continued, so `<ClientRouter />` page fetches don't join the click's trace. Ignore Astro's hashed assets in the HTTP instrumentation, or every script and stylesheet gets a trace: `"@opentelemetry/instrumentation-http": { ignoreIncomingRequestHook: (request) => request.url?.startsWith("/_astro/") ?? false }` (`build.assets` if the project changes it). Install the OpenTelemetry packages as `dependencies`: the preload file isn't bundled. Prerendered pages and `public/` files the adapter serves still get a lone HTTP server span each, in a trace of its own; their `pageload` doesn't join it (no header). Node 26 prints a deprecation warning for `module.register()`; it still works.
- `@astrojs/cloudflare`: follow Maple's Cloudflare Workers guide (Workers Observability OTLP export, https://maple.dev/docs/guides/instrumentation-cloudflare-workers). Worker code can't read those spans' trace ids yet, and no OpenTelemetry provider is registered in the Worker, so skip the middleware: `propagation.inject` would find nothing. The `pageload` span starts its own trace. Say so in the hand-off.
- Other adapters (Vercel, Netlify, Deno): follow that runtime's Maple guide; keep the middleware only if an OpenTelemetry SDK is registered in the server process.

## Check

With the production build (`astro build`, then the adapter's start command; `astro preview` for static output), in addition to `SKILL.md` Step 7:

- Full load of an on-demand page: one `pageload <template>` span whose parent is `ssr <template>`, with the frontmatter's server `fetch` spans in the same trace. A prerendered page: `pageload <template>` with no parent, and no `server-timing` header.
- With `<ClientRouter />`, one click: `navigate <template>` > `load page` > `fetch`, and for an on-demand page the server's HTTP and `ssr` spans under that `fetch`. Repeat for a param-only change (`/projects/1` to `/projects/2`).
- Without `<ClientRouter />`, each click is a new document: `pageload <template>` per page. The span is often under a millisecond (module script to `load`); that's expected.
- Interrupted navigation (`SKILL.md` Step 7) needs `<ClientRouter />` and a page whose response is slow, like an on-demand page with slow frontmatter. A slow `fetch` in an island doesn't hold the navigation open, and without `<ClientRouter />` there is no navigation span to interrupt.
