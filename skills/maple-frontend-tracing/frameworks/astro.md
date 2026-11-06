# Astro

Checked against `astro` 7.4, `@astrojs/node` 11.1, `@astrojs/react` 7.1, `@astrojs/vue` 7.1, `@maple-dev/browser` 0.14.0. Human version: https://maple.dev/docs/frontend/astro

There is no Astro entry in the SDK: wire the core calls (`startNavigation`, `endNavigation`, `traced`) from the code below. Don't import `@maple-dev/browser/astro` or any `/server` entry; they don't exist. Needs `Astro.routePattern` (Astro 5+).

Astro is multi-page by default: each document load is a `pageload` span. With `<ClientRouter />`, links are fetched and swapped in place, and each is a `navigate` span. The code below covers both. Don't add `<ClientRouter />` for tracing.

## Browser

Create `src/maple.ts`. Inline the key per `SKILL.md` Step 1; if the project passes it through env vars, Astro only exposes `PUBLIC_*` to the browser (`import.meta.env.PUBLIC_MAPLE_INGEST_KEY`), never `VITE_*`.

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "MAPLE_TEST", // public key, maple_pk_...
	serviceName: "acme-web",
	environment: import.meta.env.MODE,
	tracing: {
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})

const endNavigation = () => MapleBrowser.endNavigation(document.documentElement.dataset.route)

// Every document load is a page load, named when the window load event fires
MapleBrowser.startNavigation(location.pathname)
addEventListener("load", endNavigation)

// <ClientRouter /> navigations, with the page fetch inside them
document.addEventListener("astro:before-preparation", (event) => {
	MapleBrowser.startNavigation(event.to.pathname)
	const loader = event.loader
	event.loader = () => MapleBrowser.traced("load page", loader)
})
document.addEventListener("astro:page-load", endNavigation)
```

In every base layout (merge into the existing markup, keep its props): add `data-route={Astro.routePattern}` to `<html>`, and in `<head>`:

```astro
<script>
	import "../maple"
</script>
```

- Plain `<script>`: no `is:inline`, no attributes. Astro bundles it once per page.
- No layout (the `minimal` starter writes `<html>` per page): add both to every page. Don't restructure pages into a layout.
- Keep an existing `data-route` or `astro:*` listeners; add these alongside.
- `ClientRouter` copies the new page's `<html>` attributes on swap, so `endNavigation` reads the new route.
- Route templates: `/`, `/projects/[id]`, `/blog/[slug]`, `/docs/[...path]`, `/404`. Brackets stay.
- No route-level loaders run in the browser; the wrapped page `loader` is the data-loading span. Island requests are their own traces (not under the navigation span), still joined to the backend: don't wrap them in `traced`.

## Island errors

- React islands: wrap the island's root in `MapleErrorBoundary` from `@maple-dev/browser/react` (`fallback` prop). Reports `react.render_error` once.
- Vue islands: `vue({ appEntrypoint: "/src/vue-app" })` (keep an existing `appEntrypoint`); that file default-exports `(app: App) => { app.config.errorHandler = (error, _instance, info) => { console.error(error); MapleBrowser.captureException(error, { name: "vue.error", attributes: { "vue.error.info": info } }) } }`.
- Others (Svelte, Solid): `MapleBrowser.captureException(error)` in their error boundary hook.
- Uncaught errors in scripts and handlers need nothing (`browser.uncaught_error`).

## Server (only for on-demand pages: an adapter plus `output: "server"` or `prerender = false`)

Static output: skip this section. Prerendered pages get no header and their `pageload` starts its own trace.

1. `@astrojs/node`: server OpenTelemetry per `maple-nodejs-style` (its `tracing.mjs` registers the ES module hook; Astro's server build is ESM). Preload it: `node --import ./tracing.mjs ./dist/server/entry.mjs` (update the `start` script or Dockerfile). OpenTelemetry packages go in `dependencies`. In `getNodeAutoInstrumentations`, add `"@opentelemetry/instrumentation-http": { ignoreIncomingRequestHook: (request) => request.url?.startsWith("/_astro/") ?? false }` (use `build.assets` if the project changed it).
2. Install `@opentelemetry/api`. Add to `src/middleware.ts` (if one exists, combine them with `sequence()` from `astro:middleware`):

	```ts
	import { context, propagation, trace } from "@opentelemetry/api"
	import { defineMiddleware } from "astro:middleware"

	export const onRequest = defineMiddleware(async ({ request, routePattern }, next) => {
		// Name the HTTP server span after the route, like the browser spans
		trace.getActiveSpan()?.setAttribute("http.route", routePattern).updateName(`${request.method} ${routePattern}`)
		const response = await next()
		const carrier: Record<string, string> = {}
		propagation.inject(context.active(), carrier)
		if (carrier.traceparent && response.headers.get("content-type")?.startsWith("text/html")) {
			response.headers.append("server-timing", `traceparent;desc="${carrier.traceparent}"`)
		}
		return response
	})
	```

- Other adapters: the middleware only writes the header if an OpenTelemetry SDK runs in the server process. Otherwise page loads start their own traces; say so in the hand-off.
- Pages a CDN caches must not get the header. Back/forward can reuse the cached document and its header (the `pageload` joins the old trace); `Cache-Control: no-store` prevents it. Mention, don't add.

## Check

Production build (`astro build`, then the start command; `astro preview` for static output; `astro dev` renders prerendered pages on demand, so it sends the header for them). In the `/v1/traces` bodies:

- Direct load of an on-demand page: one `pageload <route>`, `parentSpanId` = the server's `GET <route>` span, same `traceId`; document response has `server-timing: traceparent;desc="00-…"`. Prerendered page: `pageload <route>` with no parent, no header.
- `<ClientRouter />` click: one `navigate <route>` > `load page` > `fetch` of the page URL; for an on-demand page the server's `GET <route>` span has the `fetch` as parent. Repeat for a param-only change (`/projects/1` → `/projects/2`).
- Without `<ClientRouter />`: each click is a new `pageload <route>`, no `navigate`.
- Same-origin redirect: `navigate <destination route>`, `url.path` = clicked path. Missing page: `navigate /404` (or `pageload /404`), a 404 `fetch`, no `exception` event.
- Interrupted (needs `<ClientRouter />` and a slow on-demand page): first span `navigate` with `maple.navigation.interrupted: true`, second named, no error spans.
- React render error under `MapleErrorBoundary`: exactly one `react.render_error`; handler throw: exactly one `browser.uncaught_error`; Vue: exactly one `vue.error`.
- Cross-origin API: the API's server span has the browser `fetch` span as parent.
- No server spans for `/_astro/*`.
