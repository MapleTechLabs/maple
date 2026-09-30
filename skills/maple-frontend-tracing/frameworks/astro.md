# Astro

Written against `astro` 7.3, `@astrojs/node` 11.1, `@astrojs/react` 7.0 and `@astrojs/vue` 7.0, `@maple-dev/browser` 0.10.0. Human version: https://maple.dev/docs/frontend/astro

Install `@maple-dev/browser` (0.10.0+). Entries: `@maple-dev/browser/astro` (the `maple()` integration), plus `@maple-dev/browser/astro/client` (`traceAstroNavigation`) and `@maple-dev/browser/astro/middleware` (`onRequest`) for wiring by hand. Needs Astro 5+ (`Astro.routePattern`); `astro:hydration-error` reporting needs 6.3, skipping route-cached pages needs 7. On Astro 4 the middleware passes everything through and spans keep generic names: tell the user.

Put `maple.ts` (the `MapleBrowser.init` call) in `src/`. Inline the key as `SKILL.md` Step 1 says. Astro only exposes `PUBLIC_`-prefixed env vars to the browser: if the project passes the key or version through env vars, read `import.meta.env.PUBLIC_MAPLE_INGEST_KEY` / `PUBLIC_COMMIT_SHA`, not `VITE_*`.

Astro is multi-page by default: every link is a document load, and each page gets one `pageload` span. With `<ClientRouter />` (view transitions), links are fetched and swapped in place, and each one gets a `navigate` span. The integration handles both.

## Integration and init

```js
// astro.config.mjs: add to the existing integrations array
import maple from "@maple-dev/browser/astro"

export default defineConfig({
	integrations: [maple()],
})
```

In the base layout that every page renders (merge into the existing `<head>`, keep its markup and props):

```astro
<script>
	import "../maple" // starts the SDK
</script>
```

That's all in the layouts. Don't add `data-route`, a navigation script, a `Tracing` component, or a hand-written `ssr` middleware: the integration covers them.

- The integration adds a middleware (first in the chain, `order: "pre"`) that writes `Astro.routePattern` onto each page's `<html data-route>` (at build time for prerendered pages, while streaming for on-demand ones), and one bundled page script that calls `traceAstroNavigation()`. `MapleBrowser.init` stays in the user's script: its options can hold functions and `import.meta.env` values.
- Keep the `init` `<script>` processed (no `is:inline`, no `data-astro-rerun`, no attributes besides `src`). Astro bundles it as a module and includes it once per page.
- Several base layouts: the same `<script>` in each. No layout (the `minimal` starter writes `<html>` in each page): the same `<script>` in every page's `<head>`. Don't restructure the pages into a layout for tracing.
- Don't add `<ClientRouter />` for tracing.
- Template: `Astro.routePattern`, relative to `src/pages` without extension: `/`, `/projects/[id]`, `/blog/[slug]` (prerendered via `getStaticPaths` too), `/docs/[...path]`, `/404`. The server span uses the same string.
- Route stamping needs `<html>` first in the document (only a doctype and comments before it), within the first 16 KiB; otherwise, or when another middleware compressed the body, spans keep the generic names. A `data-route` the page sets itself wins. Server islands and partials pass through. After `Astro.rewrite()`, the rendered page's route wins.
- `pageload`: from `DOMContentLoaded` (after every module script, `init` included) to `load`. Often under a millisecond; the request and server render are in the server half of the trace.
- With `<ClientRouter />`: `navigate` from `astro:before-preparation` to `astro:page-load`, with a `load page` span around the router's loader, so the document `fetch` (carrying `traceparent`) and, for an on-demand page, the server's spans are under it. The router copies the new page's `<html>` attributes on swap, so the name is the new template.
- A click during a pending navigation: the first span ends as interrupted (generic `navigate`). Links to non-HTML responses (`/file.pdf`), to a page without `<ClientRouter />`, or redirects to another origin fall back to a document load: the `navigate` span ends with the generic name, and the new document gets its own `pageload`. Same-origin redirects: named after the destination, `url.path` is the path clicked. Query-only changes are navigations; hash-only links start nothing. Back/forward are navigations (with `<ClientRouter />`) or new `pageload`s (without; a back/forward cache restore runs no script, so no span).
- A navigation that another `astro:before-preparation` listener cancels, or whose custom loader throws, ends as interrupted at the next navigation or page exit.
- `<ClientRouter />` prefetches every link on hover (unless `prefetch: false`). `<link rel="prefetch">` makes no `fetch` span; the server renders the prefetch as its own trace, and the click's `load page` can be served from the prefetch cache with no server spans. Where `rel="prefetch"` isn't supported, Astro prefetches with `fetch()`: its own trace.
- In Chromium, a view transition in a hidden tab rejects with `InvalidStateError: Transition was aborted because of invalid state`, which the SDK reports as `browser.unhandled_rejection`. The navigation completes. Mention it in the hand-off; don't suppress it.

### Wiring by hand (only when asked to trace some pages only)

The integration's script loads the SDK chunk on every page, including pages without the `init` script. To limit that, skip `maple()`:

```ts
// src/middleware.ts (existing middleware: sequence(onRequest, existing) from astro:middleware, this one first)
export { onRequest } from "@maple-dev/browser/astro/middleware"
```

```astro
<script>
	import "../maple" // starts the SDK
	import { traceAstroNavigation } from "@maple-dev/browser/astro/client"

	traceAstroNavigation()
</script>
```

## Data loading

- Frontmatter runs on the server (on-demand pages) or at build time (prerendered). There is no client loader to wrap; the browser never sees that data loading. Server-side, it nests under the integration's `ssr` span.
- Islands (`client:*` components) fetch after hydration, which starts after `load` in testing, so their `fetch` spans are their own traces. Don't wrap them in `traced`.
- Island data loading that fails: a rejection nothing catches reaches the SDK as one `browser.unhandled_rejection` span with the `exception` event. An island that catches it to show an error state hides it from the SDK: add `MapleBrowser.captureException(error)` in that `catch` (one `exception` span). There is no `loader` span, so for `SKILL.md` Step 7's "data loading throws" check, expect one of those two spans instead.
- Server islands (`server:defer`) are fetched by an inline script Astro adds to the page. In testing those requests carried no `traceparent`, on the first load (the inline script runs before the SDK starts) and after a swap: each server island render is its own server trace (`ssr /_server-islands/[name]`).
- `is:inline` scripts also run before the bundled scripts; requests they make on load aren't traced.

## Caught errors

Astro has no client error hook. What reaches Maple:

- Uncaught errors in islands and scripts: the SDK's global handler (`browser.uncaught_error`). A React 19 island that throws while rendering, with no boundary, lands here.
- Island code that fails to load (chunk 404 after a deploy, network): Astro catches it, retries once, then dispatches `astro:hydration-error` (Astro 6.3+). The integration reports it as `astro.hydration_error`; add nothing.
- Errors the island framework catches: report from its own boundary, once per framework used.
	- React: `componentDidCatch(error)` in the app's error boundary, `MapleBrowser.captureException(error, { name: "react.render_error" })`. React calls it once; the error doesn't also reach the global handler.
	- Vue: production builds only `console.error` component errors. Set `app.config.errorHandler` (as in `frameworks/vue.md`) from the file passed to `vue({ appEntrypoint: "/src/vue-app" })`; the file default-exports `(app: App) => void`. Keep an existing `appEntrypoint`.
	- Svelte: `<svelte:boundary onerror={(error) => MapleBrowser.captureException(error)}>`. Solid: in the `ErrorBoundary` fallback.

## Server side

### Static output (default, no adapter)

Skip this section. No server runs at request time, and the `pageload` span starts its own trace. The integration still writes the route into each page at build time.

### On-demand rendering (an adapter, with `output: "server"` or `export const prerender = false` pages)

The integration's middleware runs every on-demand request in an `ssr <routePattern>` span and appends `Server-Timing` to its HTML response; the browser's `pageload` becomes its child. Nothing to add in `src/middleware.ts`; an existing one keeps working (the integration's runs first).

- The span ends when Astro starts streaming: after the page's own frontmatter, before the components inside it render. Their server requests still nest under it (AsyncLocalStorage) but run past its end. The HTTP server span covers the whole response.
- An error thrown in the page's frontmatter: recorded on the span (Error), 500 response, no header. A component deeper in the page that throws after streaming started produces a 200 with `Internal server error` appended, and nothing records it. Say so in the hand-off if the app renders data-fetching components.
- Endpoints and server islands get the span too (`ssr /api/...`, `ssr /_server-islands/[name]`), no header (not HTML).
- Skipped automatically, so cached copies don't share one trace: Astro 7 route-cached pages (`maxAge` or `swr`), `Cache-Control` with `public`, `s-maxage` or `max-age` > 0, `CDN-Cache-Control` and vendor variants, `Surrogate-Control` (unless `no-store`/`private`). A CDN that caches by its own rule without those headers isn't detected: tell the user to send one of them on those pages. Astro sets no `ETag` on on-demand HTML.
- `Astro.rewrite()` runs the middleware twice: two nested `ssr` spans and two `traceparent` entries in `Server-Timing`; the browser joins the inner one, same trace.

Server OpenTelemetry, by adapter:

- `@astrojs/node`: Node SDK per `maple-nodejs-style`, preloaded: `node --import ./instrumentation.mjs ./dist/server/entry.mjs` (update the `start` script or Dockerfile). The server build is ES modules: `register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)` before `sdk.start()` is required. Without it `node:http` isn't patched: no HTTP server span, and an incoming `traceparent` isn't continued, so `<ClientRouter />` page fetches don't join the click's trace. Ignore Astro's hashed assets in the HTTP instrumentation, or every script and stylesheet gets a trace: `"@opentelemetry/instrumentation-http": { ignoreIncomingRequestHook: (request) => request.url?.startsWith("/_astro/") ?? false }` (`build.assets` if the project changes it). Install the OpenTelemetry packages as `dependencies`: the preload file isn't bundled. Prerendered pages and `public/` files the adapter serves still get a lone HTTP server span each, in a trace of its own; their `pageload` doesn't join it (no header). Node 26 prints a deprecation warning for `module.register()`; it still works.
- `@astrojs/cloudflare`: follow Maple's Cloudflare Workers guide (Workers Observability OTLP export, https://maple.dev/docs/guides/instrumentation-cloudflare-workers). Worker code can't read those spans' trace ids yet, and no OpenTelemetry provider is registered in the Worker, so the middleware sends no header (it still writes the route). The `pageload` span starts its own trace. Say so in the hand-off.
- Other adapters (Vercel, Netlify, Deno): follow that runtime's Maple guide. The page load joins the server trace only if an OpenTelemetry SDK is registered in the server process.

## Check

With the production build (`astro build`, then the adapter's start command; `astro preview` for static output), in addition to `SKILL.md` Step 7:

- Every page's HTML has `<html data-route="<template>">`.
- Full load of an on-demand page: one `pageload <template>` span whose parent is `ssr <template>`, with the frontmatter's server `fetch` spans in the same trace. A prerendered page: `pageload <template>` with no parent, and no `server-timing` header.
- With `<ClientRouter />`, one click: `navigate <template>` > `load page` > `fetch`, and for an on-demand page the server's HTTP and `ssr` spans under that `fetch`. Repeat for a param-only change (`/projects/1` to `/projects/2`).
- Without `<ClientRouter />`, each click is a new document: `pageload <template>` per page. The span is often under a millisecond; that's expected.
- Interrupted navigation (`SKILL.md` Step 7) needs `<ClientRouter />` and a page whose response is slow, like an on-demand page with slow frontmatter. A slow `fetch` in an island doesn't hold the navigation open, and without `<ClientRouter />` there is no navigation span to interrupt.
