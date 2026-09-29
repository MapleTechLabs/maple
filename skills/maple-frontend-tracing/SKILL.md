---
name: maple-frontend-tracing
description: "Trace a web frontend with Maple: install @maple-dev/browser, link browser and backend traces, add route navigation and data-loading spans, report errors the framework catches, and join the first page load to the server render. Per-framework references for TanStack Router/Start, React Router, Next.js, Vue/Nuxt, SvelteKit, Angular and Astro. Triggers on 'trace my frontend', 'add frontend observability', 'instrument the browser with Maple', 'trace route changes', 'connect frontend and backend traces', 'add session replay'."
---

# Maple frontend tracing

The goal: **one click is one trace**. A navigation span, the data-loading spans under it, the `fetch` spans they make, and the backend spans behind those. The first page load joins the server render's trace. Errors the framework catches are reported. Session replay links to the traces through a shared `session.id`.

The human-readable version of this skill is the guide at https://maple.dev/docs/frontend. Read it if you need the reasoning behind a step.

## Step 0: Detect the framework and read its reference

Read the `package.json` of each web frontend in the repo, then read **only** the matching reference in `frameworks/`:

| Dependency | Reference |
| --- | --- |
| `@tanstack/react-router`, `@tanstack/react-start` | `frameworks/tanstack.md` |
| `react-router` (v7, v8), `react-router-dom` | `frameworks/react-router.md` |
| `next` | `frameworks/nextjs.md` |
| `vue-router`, `nuxt` | `frameworks/vue.md` |
| `@sveltejs/kit` | `frameworks/sveltekit.md` |
| `@angular/router` | `frameworks/angular.md` |
| `astro` | `frameworks/astro.md` |
| anything else (Solid, Qwik, plain SPA, hand-rolled router) | `frameworks/other.md` |

The steps below are the same for every framework. The reference tells you where each one goes. If the references are not next to this file, read them from https://github.com/MapleTechLabs/maple/tree/main/skills/maple-frontend-tracing.

Backends are out of scope for this skill. If the API the frontend calls isn't instrumented with OpenTelemetry yet, use the `maple-onboard` skill for it first, or say in the hand-off that browser traces won't connect to it until it is.

## Step 1: Key and region

Maple has two regions. A key only works in the region that issued it.

- US (default): SDK option `region: "us"`, dashboard `https://app.maple.dev`.
- EU: `region: "eu"`, dashboard `https://app.eu.maple.dev`. Use it when the prompt mentions the EU or an `eu.maple.dev` URL.

Browser code takes the **public** ingest key (`maple_pk_…`) only. It is write-only and safe to ship, like a Sentry DSN. Inline it in the init call. Never put a private key (`maple_sk_…`) in browser code: if the prompt only has a private key, use `MAPLE_TEST` in the browser and tell the user to swap in the public key. With no key at all, inline the sentinel `MAPLE_TEST` (ingest accepts it and stores nothing) and keep going.

## Step 2: Install and initialize the browser SDK

Install `@maple-dev/browser` 0.10.0 or later with the project's package manager. The framework entries (`@maple-dev/browser/nextjs`, `/tanstack`, …) ship in the same package. Add `@opentelemetry/api` only if app code imports it (the `await` rule's `context`, or where a reference says so): strict package managers (pnpm) won't resolve it as the SDK's transitive dependency. Initialize the SDK once, before the app renders, at the place the framework reference names:

```ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "MAPLE_TEST", // public key, maple_pk_…
	serviceName: "acme-web",
	region: "us", // "eu" for EU organizations
	serviceVersion: "<commit sha from the build env, if the bundler exposes one>",
	environment: import.meta.env.MODE,
	tracing: {
		// First-party APIs on another origin. Same-origin requests are covered already.
		propagateTraceHeaderCorsUrls: [/^https:\/\/api\.acme\.com\//],
	},
})
```

- `serviceName`: distinct from the backend's, usually `<app>-web`.
- `init()` is a no-op on the server, so importing it from code that also runs during SSR is safe.
- The SDK instruments **`fetch` only**, not `XMLHttpRequest`. Find the app's HTTP client. `ky`, `ofetch`, `redaxios` and plain `fetch` are covered. axios uses XHR in browsers unless created with `adapter: "fetch"`; Angular's `HttpClient` uses fetch by default from Angular 22, and XHR in Angular 21 and older unless `provideHttpClient(withFetch())`. Switch those clients to fetch where it's a one-line change; otherwise register `XMLHttpRequestInstrumentation` from `@opentelemetry/instrumentation-xml-http-request` with the same `propagateTraceHeaderCorsUrls`.
- If another tracer already instruments `fetch` (for example `@maple-dev/effect-sdk/client`), set `tracing.instrumentFetch: false`.
- Keep existing error and RUM vendors (Sentry, Datadog, LogRocket…). If another tool on the page also reports global errors to Maple, set `tracing.captureErrors: false` so errors aren't counted twice.

## Step 3: Link browser and backend traces

1. Find every first-party API base URL the frontend calls (API client config, env vars like `VITE_API_URL`). Same-origin requests already carry `traceparent`. List each cross-origin first-party API in `propagateTraceHeaderCorsUrls` as an anchored regex.
2. **Never list third-party origins** (analytics, payment providers, CDNs). It leaks trace ids and often breaks their CORS preflight.
3. Check the API's CORS config. Many setups already echo the requested headers (the `cors` npm package default). If there's an explicit allow-list, add `traceparent` and `tracestate` and keep the existing entries. Without this, the browser blocks the request after the preflight.

## Step 4: Navigation and data-loading spans

Use the framework entry from the reference (`@maple-dev/browser/nextjs`, `/tanstack`, `/react-router`, `/vue`, `/sveltekit`): it names spans, handles the first page load, redirects and interrupted navigations, and wraps loaders. Add only the calls the reference lists; don't hand-write router glue it already covers. For other frameworks, call the SDK's navigation API from the router's hooks (`frameworks/other.md`):

- `MapleBrowser.startNavigation(path)`: call when the router starts a navigation. The first call opens a `pageload` span (joined to the server render, see Step 6), later calls open `navigate` spans. A navigation that starts before the previous one ended ends the previous one as interrupted.
- `MapleBrowser.endNavigation(routeTemplate?)`: call when the new route is ready. Renames the span to `<kind> <template>` and ends it. No-op when nothing is open.
- `MapleBrowser.traced(name, fn, { isFailure })`: runs a data-loading function in a child span of the current navigation. Pass `isFailure` to exclude the framework's control-flow throws (redirects, not-found) from being marked as errors. An error it records isn't reported again by `captureException` or the global handlers.

The Angular and Astro references still copy `tracing.ts` from this skill's directory verbatim, which also needs `@opentelemetry/api` installed. Follow them as written until they're updated.

Rules:

- **Span names use the route template**, never the concrete URL: `navigate /projects/:id`, not `navigate /projects/8f2a`. The concrete path is already the `url.path` attribute.
- Wrap the framework's **route-level** data loading (loaders, `load` functions, resolvers), named `loader <template>`. Don't wrap every component fetch or event handler.
- **The `await` rule.** The browser has no async context: inside `traced`, only requests started before the first `await` nest under the span. Start independent requests together (`Promise.all`). For a request that depends on an earlier one, capture `const ctx = context.active()` (from `@opentelemetry/api`) before the first `await` and call it inside `context.with(ctx, () => …)`. Don't install `ZoneContextManager`.
- No PII in span names or attributes.

## Step 5: Report errors the framework catches

Error boundaries stop errors from reaching `window.onerror`, so the SDK's global handlers never see them. Use the reporter from the framework entry, in the hook the reference names. For other frameworks, find the central caught-error hook and call `MapleBrowser.captureException(error)` there. No dedupe check is needed: it skips errors `traced` already recorded, and records each error object once.

Keep whatever the hook already does (logging, other vendors, fallback UI). `init()` is a no-op on the server but `captureException` is not: if the hook also runs during SSR, the error is recorded in the server's trace.

## Step 6: Server-side rendering (only if the app renders on the server)

1. The server needs OpenTelemetry like any backend: follow `maple-nodejs-style` (or `maple-nextjs-style` for Next.js) for the SDK bootstrap and inline key. If that skill isn't installed, install it with `npx skills add MapleTechLabs/maple/skills --skill maple-nodejs-style -y`, or read it at https://github.com/MapleTechLabs/maple/tree/main/skills/maple-nodejs-style.
2. Use the reference's server entry (`withMapleProxy`, `traceRequests`/`traceRender`, `serverInstrumentation`, `mapleNitroPlugin`, `mapleHandle`). Otherwise add a span around the render, named `ssr <template>`, unless the framework already creates one. If the framework loads data before it calls your render hook, open the span (or a request span) where the request arrives, so the server's loaders run inside it; otherwise every request's loaders become separate traces. Then, from inside that span's context, append the trace context to the response:

	```ts
	import { serverTiming } from "@maple-dev/browser/server"

	const timing = serverTiming() // undefined when no span is active
	if (timing) headers.append("server-timing", timing)
	```

	The SDK reads it back from the Navigation Timing API and parents the browser's `pageload` span to it (or reads `<meta name="traceparent">`). Only the page load joins the server trace; later navigations are their own traces. The browser follows the server's sampling decision.
3. Server-side data loading (SSR loaders, Server Components, resolvers): `traced` from `@maple-dev/browser/server` spans under the active server span through the global tracer, keeps parents across `await`, and only runs `fn` without server OpenTelemetry. `MapleBrowser.traced` behaves the same when there's no `window`. `@maple-dev/browser/server` depends only on `@opentelemetry/api`: safe in Node, edge runtimes and Workers.
4. Don't send the header on responses a CDN caches, or every visitor joins the same trace. If the framework sets an `ETag` on HTML, delete it on responses that carry the header: a 304 revalidation reuses the cached header and joins an old trace.

## Step 7: Verify

1. Run the project's typecheck and build for the frontend. A build broken by your changes is a failure; fix it.
2. Start the production build (or the dev server, if the framework behaves the same in both) and check the network tab:
	- requests to `https://ingest(.eu).maple.dev/v1/traces` return 200 (a 401 means wrong key or wrong region);
	- API requests carry a `traceparent` header, and cross-origin ones pass their CORS preflight;
	- with SSR, the document response has a `server-timing` header containing `traceparent`.
3. Check the span shapes in the JSON bodies of the `/v1/traces` requests. This works with `MAPLE_TEST` too:
	- a reload gives one `pageload <template>` span, never a bare `pageload`, and it is exported even when the page's render throws;
	- one click gives exactly one `navigate <template>` span; its `loader …` spans have its `spanId` as `parentSpanId`, and the `fetch` spans sit under those. Repeat for a param-only change (`/items/1` to `/items/2`);
	- unless the framework reference says otherwise (Astro islands have no loader span), a route whose data loading throws gives exactly one span with an `exception` event, and no `browser.unhandled_rejection` for the same error. An event handler that throws gives exactly one error span: `browser.uncaught_error`, or the framework hook's span when the framework catches handler errors (Angular: `angular.error`). Errors thrown in server-side data loading (Next.js Server Components, server loaders) are on the server's spans, not in the browser's `/v1/traces` bodies.
	- click a link whose data loads slowly, then another link before it finishes: the first span ends at the second click (marked `app.navigation.interrupted`, or merged into the second where the reference says so), the second is `navigate <template>`, and no navigation span stays open;
	- with SSR, load a route whose render throws directly (not by client navigation): exactly one `exception` event, on a server span. A URL that matches no route produces no `exception` event and no Error span other than a 4xx `fetch`.
4. With a real key and the Maple MCP tools available, wait a minute, then `search_traces` for the frontend's `serviceName` and `inspect_trace` a `navigate …` trace: it should contain the loader span, `fetch` spans and the backend's spans, unless the framework reference says those are separate traces (Next.js App Router). With `MAPLE_TEST`, nothing is stored; say so instead.

## Step 8: Hand-off

3 to 7 bullets: packages installed, files created or changed, which APIs got `traceparent` (and any CORS change), which framework hooks were wired, and what you could not verify. Also tell the user:

- `fetch` spans for 4xx responses are marked `Error` (OpenTelemetry's rule for client spans). Maple doesn't open error issues for 4xx spans without exception data, so an expected 404 doesn't create an issue.
- Session replay is on, with all inputs masked (`replay: { enabled: false }` turns it off), and the SDK keeps a persistent visitor id in localStorage and a cookie (`privacy: { persistVisitorId: false }` turns it off). Both matter for their privacy and cookie notices.
- If `MAPLE_TEST` is inline: copy the public key from Settings → Ingestion (`<dashboard>/settings?tab=ingestion`) and search-replace `MAPLE_TEST`.

## Hard rules

- Never modify files outside the project root. Don't commit, push, or open PRs unless the user asks you to.
- Never put a private key in browser code.
- Never send `traceparent` to third-party origins.
- Never remove an existing observability vendor unless asked.
- Use the project's package manager and existing code style.
- Verify framework APIs against the installed package's types before using them. The references were written against specific versions; if the installed major differs, check.
